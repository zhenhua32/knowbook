import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSystemPluginLogWriter,
  redactSystemPluginLog
} from '../src/main/system-plugin/log-writer'

test('Full Trust log redaction covers headers, JSON, assignments, query strings, and bearer text', () => {
  const secrets = [
    'header-secret',
    'basic-secret',
    'json-api-secret',
    'access-secret',
    'client-secret-value',
    'password secret',
    'query-secret',
    'loose-bearer-secret'
  ]
  const redacted = redactSystemPluginLog([
    'Authorization: Bearer header-secret',
    'proxy_authorization=Basic basic-secret',
    '{"apiKey":"json-api-secret","access_token":"access-secret"}',
    "CLIENT_SECRET='client-secret-value'",
    'password = "password secret"',
    'https://example.test/callback?safe=yes&refresh-token=query-secret&next=1',
    'request used Bearer loose-bearer-secret'
  ].join('\n'))

  for (const secret of secrets) assert.equal(redacted.includes(secret), false)
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/)
  assert.match(redacted, /"apiKey":"\[REDACTED\]"/)
  assert.match(redacted, /refresh-token=\[REDACTED\]&next=1/)
  assert.match(redacted, /request used Bearer \[REDACTED\]/)
})

test('Full Trust log entries are one physical line and bounded by UTF-8 bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-log-entry-'))
  try {
    const path = join(root, 'service.log')
    const writer = createSystemPluginLogWriter(path, {
      maxEntryBytes: 96,
      maxFileBytes: 192,
      maxTotalBytes: 384
    })
    await writer.append(
      `Authorization: Bearer never-write-this\n${'🙂'.repeat(200)}`
    )
    await writer.flush()

    const content = readFileSync(path, 'utf8')
    assert.equal(statSync(path).size <= 96, true)
    assert.equal(content.includes('never-write-this'), false)
    assert.equal(content.includes('\\n'), true)
    assert.equal(content.split('\n').length, 2)
    assert.match(content, /…\[TRUNCATED\]\n$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Full Trust log rotation bounds every file and aggregate retained bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-log-rotation-'))
  try {
    const path = join(root, 'dependencies.log')
    mkdirSync(root, { recursive: true })
    writeFileSync(path, 'oversized-current'.repeat(20))
    writeFileSync(`${path}.1`, 'oversized-rotation'.repeat(20))
    writeFileSync(`${path}.9`, 'stale-rotation')
    const writer = createSystemPluginLogWriter(path, {
      maxEntryBytes: 80,
      maxFileBytes: 160,
      maxTotalBytes: 320
    })

    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      writer.append(`entry-${index} api_key=secret-${index} ${'x'.repeat(44)}`)
    )))
    await writer.flush()

    const names = readdirSync(root).filter((name) => name.startsWith('dependencies.log')).sort()
    assert.deepEqual(names, ['dependencies.log', 'dependencies.log.1'])
    const sizes = names.map((name) => statSync(join(root, name)).size)
    assert.equal(sizes.every((size) => size <= 160), true)
    assert.equal(sizes.reduce((total, size) => total + size, 0) <= 320, true)
    for (const name of names) {
      assert.equal(readFileSync(join(root, name), 'utf8').includes('secret-'), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Full Trust log limits reject configurations that cannot uphold their bounds', () => {
  assert.throws(() => createSystemPluginLogWriter('ignored.log', {
    maxEntryBytes: 128,
    maxFileBytes: 64,
    maxTotalBytes: 256
  }), /maxEntryBytes cannot exceed maxFileBytes/)
  assert.throws(() => createSystemPluginLogWriter('ignored.log', {
    maxEntryBytes: 32,
    maxFileBytes: 128,
    maxTotalBytes: 64
  }), /maxFileBytes cannot exceed maxTotalBytes/)
})
