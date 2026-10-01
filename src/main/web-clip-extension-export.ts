import { lstat, mkdir, mkdtemp, open, readFile, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WebClipExtensionExportResult } from '@shared/contracts'

const extensionFiles = ['manifest.json', 'popup.html', 'popup.js', 'page-collector.js', 'README.md'] as const
const exportFolderName = 'KnowBook Web Clipper'

type OwnedPath = { path: string; dev: bigint; ino: bigint; birthtimeNs: bigint }
type ExportOptions = {
  sourceDirectory: string
  openDirectory: (directory: string) => Promise<string>
  writeFile?: (file: FileHandle, contents: Buffer) => Promise<void>
}

class ExtensionExportError extends Error {}

export function getWebClipExtensionSourceDirectory(input: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  return join(input.isPackaged ? input.resourcesPath : input.appPath, 'web-clip-extension')
}

export class WebClipExtensionExportService {
  private exporting = false
  private opening = false
  private lastDirectory: string | null = null

  constructor(private readonly options: ExportOptions) {}

  async export(chooseDirectory: () => Promise<string | null>): Promise<WebClipExtensionExportResult | null> {
    this.requireIdle()
    this.exporting = true
    let staging: OwnedPath | null = null
    let destination: OwnedPath | null = null
    const stagedFiles: OwnedPath[] = []
    const publishedFiles: OwnedPath[] = []
    try {
      const selected = await chooseDirectory()
      if (selected === null) return null
      const bundle = await this.readBundle()
      const parent = await realpath(resolve(selected))
      if (!(await lstat(parent)).isDirectory()) throw new ExtensionExportError('Choose a folder to export the browser extension.')
      const directory = join(parent, exportFolderName)
      try {
        await lstat(directory)
        throw new ExtensionExportError('A KnowBook Web Clipper folder already exists here. Choose another parent folder; existing files will not be overwritten.')
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
      }
      staging = await describeOwnedPath(await mkdtemp(join(parent, '.knowbook-web-clip-extension-')))
      for (const file of bundle.files) await this.writeOwnedFile(join(staging.path, file.name), file.contents, stagedFiles)
      try {
        await mkdir(directory)
      } catch (error) {
        if (hasCode(error, 'EEXIST')) throw new ExtensionExportError('A KnowBook Web Clipper folder already exists here. Choose another parent folder; existing files will not be overwritten.')
        throw error
      }
      destination = await describeOwnedPath(directory)
      // Reserve the directory exclusively, then create each file exclusively.
      // Renaming over an existing empty directory is not safe across platforms.
      for (const file of bundle.files) {
        await this.writeOwnedFile(join(directory, file.name), await readFile(join(staging.path, file.name)), publishedFiles)
      }
      this.lastDirectory = directory
      return { directory, version: bundle.version }
    } catch (error) {
      await cleanupOwnedPaths(destination, publishedFiles)
      if (error instanceof ExtensionExportError) throw error
      throw new Error('Failed to export the browser extension. Choose a writable folder and try again.', { cause: error })
    } finally {
      await cleanupOwnedPaths(staging, stagedFiles)
      this.exporting = false
    }
  }

  async openDirectory(): Promise<void> {
    this.requireIdle()
    if (!this.lastDirectory) throw new Error('Export the browser extension before opening its folder.')
    this.opening = true
    try {
      const directory = this.lastDirectory
      let available = false
      try {
        const info = await lstat(directory)
        available = info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory
      } catch { /* A removed or inaccessible export cannot be opened. */ }
      if (!available) throw new Error('The exported browser extension folder is missing or unavailable. Export it again.')
      const errorMessage = await this.options.openDirectory(directory)
      if (errorMessage.trim()) throw new Error(errorMessage)
    } finally {
      this.opening = false
    }
  }

  private requireIdle(): void {
    if (this.exporting || this.opening) throw new Error('A browser extension export or folder opening is already in progress.')
  }

  private async readBundle(): Promise<{ version: string; files: { name: string; contents: Buffer }[] }> {
    try {
      const source = this.options.sourceDirectory
      const directory = await lstat(source)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid bundled extension directory.')
      const files = await Promise.all(extensionFiles.map(async name => {
        const path = join(source, name)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid bundled extension file.')
        return { name, contents: await readFile(path) }
      }))
      const manifest = JSON.parse(files[0].contents.toString('utf8')) as { manifest_version?: unknown; version?: unknown }
      if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
        throw new Error('Invalid bundled extension manifest.')
      }
      return { version: manifest.version, files }
    } catch (error) {
      throw new ExtensionExportError('The bundled browser extension is incomplete or unavailable. Reinstall KnowBook and try again.', { cause: error })
    }
  }

  private async writeOwnedFile(path: string, contents: Buffer, owned: OwnedPath[]): Promise<void> {
    const file = await open(path, 'wx')
    try {
      owned.push(pathIdentity(path, await file.stat({ bigint: true })))
      if (this.options.writeFile) await this.options.writeFile(file, contents)
      else await file.writeFile(contents)
    } finally {
      await file.close()
    }
  }
}

async function describeOwnedPath(path: string): Promise<OwnedPath> {
  return pathIdentity(path, await lstat(path, { bigint: true }))
}

function pathIdentity(path: string, info: BigIntStats): OwnedPath {
  // Windows reports different device IDs for a handle and the same path.
  // Keep exact file IDs and creation times; Unix also compares the device.
  return { path, dev: process.platform === 'win32' ? 0n : info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs }
}

function isOwnedPath(info: BigIntStats, owned: OwnedPath): boolean {
  const identity = pathIdentity(owned.path, info)
  return identity.dev === owned.dev && identity.ino === owned.ino && identity.birthtimeNs === owned.birthtimeNs
}

async function cleanupOwnedPaths(directory: OwnedPath | null, files: OwnedPath[]): Promise<void> {
  if (!directory) return
  try {
    const info = await lstat(directory.path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || !isOwnedPath(info, directory)) return
    for (const file of files) {
      try {
        const current = await lstat(file.path, { bigint: true })
        if (current.isFile() && !current.isSymbolicLink() && isOwnedPath(current, file)) await unlink(file.path)
      } catch { /* Keep files that disappeared or were replaced after export began. */ }
    }
    // Never recursively delete a selected folder or external files added to it.
    await rmdir(directory.path)
  } catch { /* Cleanup cannot turn a complete export into a failed export. */ }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
