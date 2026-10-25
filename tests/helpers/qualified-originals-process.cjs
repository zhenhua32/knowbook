(async () => {
  const started = performance.now(), stage = name => console.error('[qualified-child-stage]', JSON.stringify({ name, elapsedMs: Math.round(performance.now() - started), pid: process.pid }))
  stage('started')
  const assert = require('node:assert/strict'), fs = require('node:fs/promises')
  const { captureReopenedQualifiedOriginalBundle } = await import('../../src/main/database/restore-knowledge-qualified-originals.ts')
  stage('module-loaded')
  const input = JSON.parse(process.argv[2]), expected = JSON.parse(await fs.readFile(input.expectedPath, 'utf8'))
  const { expectedPath: _oracle, ...locator } = input
  stage('oracle-loaded')
  const actual = await captureReopenedQualifiedOriginalBundle(locator)
  stage('actual-cold-read')
  // Same full-material equality formerly checked after parent-process import;
  // it now belongs to this real independent SQL certification's mint point.
  assert.deepEqual(actual.value, expected)
  stage('material-equal')
  process.stdout.write(JSON.stringify({ pid: process.pid, original: actual.value }))
})().catch(error => { console.error(error); process.exitCode = 1 })
