import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteMarkdownDestinations } from '@shared/markdownLinks'

/** Export a standalone Markdown file with portable copies of its managed attachments. */
export function writeMarkdownFile(filePath: string, markdown: string, assetRoot: string): void {
  const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)
  const outputDirectory = dirname(resolve(filePath))
  const assetDirectory = join(outputDirectory, `${basename(filePath, extname(filePath))}.assets`)
  mkdirSync(outputDirectory, { recursive: true })
  const rewritten = rewriteMarkdownDestinations(markdown, ({ url }) => {
    if (!url.startsWith('file:')) return null
    let source: string
    try { source = fileURLToPath(url) } catch { return null }
    if (!inside(resolve(source), resolve(assetRoot)) || !lstatSync(source, { throwIfNoEntry: false })?.isFile()) return null
    if (!inside(realpathSync(source), realpathSync(assetRoot))) throw new Error('Markdown attachment is outside the managed asset directory.')
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex')
    const name = hash + extname(source).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16)
    const existing = lstatSync(assetDirectory, { throwIfNoEntry: false })
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Markdown attachment destination must be a regular directory.')
    mkdirSync(assetDirectory, { recursive: true })
    const destination = join(assetDirectory, name)
    if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Markdown attachment destination cannot be a symbolic link.')
    copyFileSync(source, destination)
    const parsed = new URL(url)
    return './' + relative(outputDirectory, destination).split(sep).map(encodeURIComponent).join('/') + parsed.search + parsed.hash
  })
  writeFileSync(filePath, rewritten, 'utf8')
}
