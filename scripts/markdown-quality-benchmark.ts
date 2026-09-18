import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { markdownEngine } from '../src/shared/markdownEngine'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets, getMarkdownHeadingRewrites } from '../src/shared/markdownLinkMaintenance'
import { mixedMarkdown, unclosedMath, unclosedBrackets, deepQuote, duplicateHeadings, largeTable, imageParagraph } from '../tests/fixtures/markdown-quality'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks'

const samples = 7, warmups = 2
type Metric = { name: string; samplesMs: number[]; medianMs: number; p95Ms: number; limitMs: number; passed: boolean }
function measure(name: string, run: () => unknown, limitMs: number): Metric {
  for (let index = 0; index < warmups; index++) run()
  const times: number[] = []
  for (let index = 0; index < samples; index++) {
    const start = performance.now()
    run()
    times.push(performance.now() - start)
  }
  const sorted = times.toSorted((a, b) => a - b), medianMs = sorted[Math.floor(samples / 2)], p95Ms = sorted.at(-1)!
  const metric = { name, samplesMs: times, medianMs, p95Ms, limitMs, passed: medianMs < limitMs }
  console.log(`${name}: median ${medianMs.toFixed(2)} ms, p95 ${p95Ms.toFixed(2)} ms, limit ${limitMs} ms — ${metric.passed ? 'PASS' : 'FAIL'}`)
  return metric
}
const metrics: Metric[] = []
const inputs: Array<{ name: string; characters: number; sha256: string; blocks?: number }> = []
function input(name: string, source: string, blocks?: number) {
  inputs.push({ name, characters: source.length, sha256: createHash('sha256').update(source).digest('hex'), blocks })
}
for (const sections of [100, 500]) {
  const source = mixedMarkdown(sections)
  const blocks = parseMarkdownBlocks(source).map((block, index) => ({ ...block, id: `b${index}` }))
  input(`mixed-${sections}`, source, blocks.length)
  for (const [name, run] of [
    ['parse', () => markdownEngine.parse(source, {})], ['import', () => parseMarkdownBlocks(source)],
    ['document', () => parseMarkdownDocumentBlocks(blocks, 'Benchmark')],
    ['links', () => collectDocumentMarkdownLinks(blocks)], ['serialize', () => serializeBlocksToMarkdown(blocks)]
  ] as const) metrics.push(measure(`mixed-${sections}/${name}`, run, 2_000))
}
for (const [name, source, limit] of [
  ['unclosed-math', unclosedMath, 500], ['unclosed-brackets', unclosedBrackets, 1_000],
  ['deep-quote', deepQuote, 500], ['large-table', largeTable, 2_000]
] as const) {
  input(name, source)
  metrics.push(measure(name + '/import', () => parseMarkdownBlocks(source), limit))
}
input('duplicate-headings', duplicateHeadings)
input('image-paragraph', imageParagraph)
metrics.push(measure('image-paragraph/links', () => collectMarkdownDestinations(imageParagraph), 1_000))
metrics.push(measure('duplicate-headings/parse', () => getMarkdownHeadingTargets([{ id: 'raw', type: 'paragraph', content: duplicateHeadings }], 'Benchmark'), 500))
const before = getMarkdownHeadingTargets([{ id: 'raw', type: 'paragraph', content: duplicateHeadings }], 'Benchmark')
const after = getMarkdownHeadingTargets([{ id: 'raw', type: 'paragraph', content: duplicateHeadings.replace('## Same\n\nText 0\n\n', '') }], 'Benchmark')
metrics.push(measure('duplicate-headings/maintain', () => getMarkdownHeadingRewrites(before, after), 250))
let commit = 'unknown', workingTreeChanged: boolean | null = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  workingTreeChanged = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim())
} catch { /* Source archives have no git metadata. */ }
const report = { schemaVersion: 1, commit, workingTreeChanged, recordedAt: new Date().toISOString(), samples, warmups,
  sourceFingerprint: createHash('sha256').update(['markdownEngine', 'markdownAdvanced', 'markdownInlineMath', 'markdownSourceLinks',
    'markdownLinks', 'markdownHeadingText', 'markdownLinkMaintenance', 'markdown', 'markdownDocument'].map((name) => {
    const path = `src/shared/${name}.ts`
    return path + '\n' + (existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '<absent>')
  }).join('\n')).digest('hex'),
  environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3,
    platform: process.platform, architecture: process.arch, node: process.version, electron: process.versions.electron },
  note: 'Isolated process microbenchmarks. p95 is the largest of seven samples. These are regression ceilings, not UI latency targets or competitor measurements.',
  inputs, metrics }
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/markdown-quality-report.json', JSON.stringify(report, null, 2) + '\n')
if (metrics.some((metric) => !metric.passed)) process.exitCode = 1
