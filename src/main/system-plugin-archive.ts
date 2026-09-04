import extractZip from 'extract-zip'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, posix, resolve } from 'node:path'
import type { Entry } from 'yauzl'

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 10_000

export interface ExtractedSystemPluginArchive {
  archivePath: string
  extractionDirectory: string
  artifactDirectory: string
  entryCount: number
  extractedBytes: number
}

export async function extractSystemPluginArchive(input: {
  archivePath: string
  extractionRoot: string
}): Promise<ExtractedSystemPluginArchive> {
  const archivePath = resolve(input.archivePath)
  const extractionRoot = resolve(input.extractionRoot)
  const archive = await stat(archivePath)
  if (!archive.isFile() || archive.size < 1 || archive.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Full Trust plugin ZIP must be a non-empty file no larger than 256 MiB.')
  }
  if (basename(archivePath).toLowerCase().endsWith('.zip') === false) {
    throw new Error('Full Trust plugin archive must use the .zip extension.')
  }

  await mkdir(extractionRoot, { recursive: true })
  const extractionDirectory = join(extractionRoot, `archive-${randomUUID()}`)
  await mkdir(extractionDirectory, { recursive: false })
  let entryCount = 0
  let extractedBytes = 0

  try {
    await extractZip(archivePath, {
      dir: extractionDirectory,
      onEntry(entry) {
        const size = validateSystemPluginArchiveEntry(entry)
        entryCount += 1
        extractedBytes += size
        if (entryCount > MAX_ENTRIES) {
          throw new Error(`Full Trust plugin ZIP exceeds ${MAX_ENTRIES} entries.`)
        }
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
          throw new Error('Full Trust plugin ZIP expands beyond 512 MiB.')
        }
      }
    })
    const artifactDirectory = await resolveExtractedArtifactDirectory(extractionDirectory)
    return {
      archivePath,
      extractionDirectory,
      artifactDirectory,
      entryCount,
      extractedBytes
    }
  } catch (error) {
    await rm(extractionDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function validateSystemPluginArchiveEntry(
  entry: Pick<Entry, 'fileName' | 'uncompressedSize' | 'externalFileAttributes'> & {
    isEncrypted?: () => boolean
  }
): number {
  const fileName = entry.fileName
  if (
    typeof fileName !== 'string'
    || !fileName
    || fileName.length > 1_024
    || fileName.includes('\0')
    || fileName.includes('\\')
    || isAbsolute(fileName)
    || /^[a-z]:/i.test(fileName)
  ) {
    throw new Error('Full Trust plugin ZIP contains an invalid entry path.')
  }
  const normalized = posix.normalize(fileName)
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`Full Trust plugin ZIP entry escapes the extraction root: ${fileName}`)
  }
  if (entry.isEncrypted?.()) {
    throw new Error(`Full Trust plugin ZIP entry is encrypted: ${fileName}`)
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error(`Full Trust plugin ZIP cannot contain symbolic links: ${fileName}`)
  }
  const isDirectory = fileName.endsWith('/')
  const size = isDirectory ? 0 : entry.uncompressedSize
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
    throw new Error(`Full Trust plugin ZIP entry is too large: ${fileName}`)
  }
  return size
}

async function resolveExtractedArtifactDirectory(extractionDirectory: string): Promise<string> {
  if (await isRegularFile(join(extractionDirectory, 'plugin.json'))) return extractionDirectory
  const entries = await readdir(extractionDirectory, { withFileTypes: true })
  const visible = entries.filter((entry) => entry.name !== '__MACOSX')
  if (visible.length === 1 && visible[0].isDirectory()) {
    const nested = join(extractionDirectory, visible[0].name)
    if (await isRegularFile(join(nested, 'plugin.json'))) return nested
  }
  return extractionDirectory
}

async function isRegularFile(path: string): Promise<boolean> {
  return lstat(path).then((value) => value.isFile(), (error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
