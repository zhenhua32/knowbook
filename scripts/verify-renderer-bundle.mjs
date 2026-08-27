import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const RENDERER_OUTPUT_DIR = resolve(SCRIPT_DIR, '../out/renderer')
const ENTRY_BUDGETS = {
  javascript: 450 * 1024,
  // Plugin Platform v2 adds the shared ViewSpec, sandbox, lifecycle-card, and
  // recovery-state styles. Keep a narrow ceiling while accounting for them.
  stylesheet: 96 * 1024
}

function findEntryAsset(html, pattern, label) {
  const match = html.match(pattern)
  if (!match) {
    throw new Error(`Unable to find the renderer ${label} entry in index.html.`)
  }
  return resolve(RENDERER_OUTPUT_DIR, match[1])
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`
}

const html = readFileSync(resolve(RENDERER_OUTPUT_DIR, 'index.html'), 'utf8')
const assets = [
  {
    kind: 'javascript',
    path: findEntryAsset(html, /<script[^>]+src="\.\/([^"?]+\.js)"/, 'JavaScript')
  },
  {
    kind: 'stylesheet',
    path: findEntryAsset(html, /<link[^>]+href="\.\/([^"?]+\.css)"/, 'stylesheet')
  }
]

const results = assets.map((asset) => {
  const content = readFileSync(asset.path)
  return {
    kind: asset.kind,
    asset: asset.path.slice(RENDERER_OUTPUT_DIR.length + 1),
    rawBytes: statSync(asset.path).size,
    gzipBytes: gzipSync(content).length,
    budgetBytes: ENTRY_BUDGETS[asset.kind]
  }
})

console.table(results.map((result) => ({
  entry: result.kind,
  asset: result.asset,
  raw: formatBytes(result.rawBytes),
  gzip: formatBytes(result.gzipBytes),
  budget: formatBytes(result.budgetBytes)
})))

const violations = results.filter((result) => result.rawBytes > result.budgetBytes)
if (violations.length > 0) {
  const details = violations
    .map((result) => `${result.kind}: ${formatBytes(result.rawBytes)} > ${formatBytes(result.budgetBytes)}`)
    .join(', ')
  throw new Error(`Renderer entry bundle budget exceeded (${details}).`)
}

const assetNames = readdirSync(resolve(RENDERER_OUTPUT_DIR, 'assets'))
const legacyFontAssets = assetNames.filter((assetName) => /\.(?:ttf|woff)$/i.test(assetName))
if (legacyFontAssets.length > 0) {
  throw new Error(`Renderer emitted legacy font formats: ${legacyFontAssets.join(', ')}`)
}
