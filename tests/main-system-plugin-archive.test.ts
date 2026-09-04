import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  extractSystemPluginArchive,
  validateSystemPluginArchiveEntry
} from '../src/main/system-plugin-archive.ts'

test('system plugin ZIP extraction accepts one wrapper directory and returns its artifact root', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'knowbook-system-plugin-zip-'))
  try {
    const archivePath = join(temporaryDirectory, 'weather.zip')
    await writeFile(archivePath, createStoredZip([
      {
        name: 'weather/plugin.json',
        content: JSON.stringify({
          manifestVersion: 3,
          id: 'plugin.weather',
          name: 'Weather',
          version: '1.0.0',
          trust: 'full',
          entries: { main: 'main.cjs' }
        })
      },
      { name: 'weather/main.cjs', content: 'module.exports = {}\n' }
    ]))

    const extracted = await extractSystemPluginArchive({
      archivePath,
      extractionRoot: join(temporaryDirectory, 'imports')
    })

    assert.equal(extracted.entryCount, 2)
    assert.equal(
      extracted.extractedBytes,
      Buffer.byteLength(await readFile(join(extracted.artifactDirectory, 'plugin.json')))
        + Buffer.byteLength('module.exports = {}\n')
    )
    assert.equal(
      await readFile(join(extracted.artifactDirectory, 'main.cjs'), 'utf8'),
      'module.exports = {}\n'
    )
    assert.equal(extracted.artifactDirectory, join(extracted.extractionDirectory, 'weather'))
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test('system plugin ZIP entry validation rejects traversal, encryption, links, and oversized files', () => {
  const valid = {
    fileName: 'plugin/main.cjs',
    uncompressedSize: 42,
    externalFileAttributes: 0,
    isEncrypted: () => false
  }
  assert.equal(validateSystemPluginArchiveEntry(valid), 42)
  assert.equal(validateSystemPluginArchiveEntry({
    ...valid,
    fileName: 'plugin/'
  }), 0)

  for (const fileName of [
    '../escape',
    'plugin/../../escape',
    '/absolute',
    'C:/absolute',
    'plugin\\windows-path',
    'plugin/\0hidden'
  ]) {
    assert.throws(
      () => validateSystemPluginArchiveEntry({ ...valid, fileName }),
      /invalid entry path|escapes the extraction root/
    )
  }
  assert.throws(
    () => validateSystemPluginArchiveEntry({
      ...valid,
      isEncrypted: () => true
    }),
    /encrypted/
  )
  assert.throws(
    () => validateSystemPluginArchiveEntry({
      ...valid,
      externalFileAttributes: 0o120777 << 16
    }),
    /symbolic links/
  )
  assert.throws(
    () => validateSystemPluginArchiveEntry({
      ...valid,
      uncompressedSize: 128 * 1024 * 1024 + 1
    }),
    /too large/
  )
})

interface StoredZipEntry {
  name: string
  content: string
}

function createStoredZip(entries: readonly StoredZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const content = Buffer.from(entry.content, 'utf8')
    const checksum = crc32(content)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(content.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localParts.push(localHeader, name, content)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(content.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, name)
    localOffset += localHeader.length + name.length + content.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function crc32(input: Buffer): number {
  let value = 0xffffffff
  for (const byte of input) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    }
  }
  return (value ^ 0xffffffff) >>> 0
}
