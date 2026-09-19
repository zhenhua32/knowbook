import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { createMarkdownSourceDraft, markdownSourceChange, replaceMarkdownSource, markdownSourceDraftToBlocks, type MarkdownSourceChange } from '../src/renderer/src/utils/markdownSourceDraft'
import * as sourceDraft from '../src/renderer/src/utils/markdownSourceDraft'
import { formatMarkdownSelection } from '../src/renderer/src/utils/markdownFormatting'
import { sourceEditingBlocks } from '../tests/fixtures/markdown-source-performance'

const warmups = 2, samples = 7
const fingerprintFiles = ['src/renderer/src/utils/markdownSourceDraft.ts', 'src/renderer/src/utils/markdownFormatting.ts',
  'src/shared/markdown.ts', 'src/shared/markdownEngine.ts', 'src/shared/markdownSourceLinks.ts', 'tests/fixtures/markdown-source-performance.ts']
const sourceFingerprint = createHash('sha256').update(fingerprintFiles.map(path => path + '\n' + readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).join('\n')).digest('hex')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
const workingTreeChanged = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim())
const metrics: Array<{ name: string; samplesMs: number[]; medianMs: number; p95Ms: number; ceilingMs: number; passed: boolean }> = []
const inputs: Array<{ blocks: number; characters: number; sha256: string }> = []
function measure<T>(name: string, run: () => T, verify: (value: T) => void, ceilingMs: number) {
  const times: number[] = []
  for (let index = -warmups; index < samples; index++) {
    const start = performance.now(), result = run(), elapsed = performance.now() - start
    verify(result)
    if (index >= 0) times.push(elapsed)
  }
  const sorted = times.toSorted((a, b) => a - b), medianMs = sorted[Math.floor(samples / 2)], p95Ms = sorted.at(-1)!
  const metric = { name, samplesMs: times, medianMs, p95Ms, ceilingMs, passed: medianMs < ceilingMs }
  metrics.push(metric)
  console.log(`${name}: median ${medianMs.toFixed(2)} ms, p95 ${p95Ms.toFixed(2)} ms — ${metric.passed ? 'PASS' : 'FAIL'}`)
}
for (const count of [800, 4000]) {
  const blocks = sourceEditingBlocks(count), original = createMarkdownSourceDraft(blocks)
  inputs.push({ blocks: count, characters: original.source.length, sha256: createHash('sha256').update(original.source).digest('hex') })
  measure(`${count}/open`, () => createMarkdownSourceDraft(blocks), value => assert.equal(value.source, original.source), 250)
  const caret = original.source.indexOf('段落 1') + 3
  const edited = original.source.slice(0, caret) + '字' + original.source.slice(caret)
  measure(`${count}/input`, () => replaceMarkdownSource(original, markdownSourceChange(original.source, edited, caret, caret)),
    value => assert.equal(value.source, edited), 100)
  const format = () => {
    let draft = original
    const changes: MarkdownSourceChange[] = []
    const result = formatMarkdownSelection(draft.source, 0, draft.source.length, 'bold', 'Link', change => changes.push(change))
    // The same benchmark also runs against the preceding revision. Its public
    // single-change path is the path that revision's dialog actually used.
    const batch = (sourceDraft as typeof sourceDraft & { replaceMarkdownSourceChanges?: (draft: typeof original, changes: MarkdownSourceChange[]) => typeof original }).replaceMarkdownSourceChanges
    if (batch) draft = batch(draft, changes)
    else for (const change of changes) draft = replaceMarkdownSource(draft, change)
    assert.equal(draft.source, result.content)
    return draft
  }
  const formatted = format()
  const verify = (draft: typeof original) => {
    const parsed = markdownSourceDraftToBlocks(draft)
    assert.deepEqual(parsed.map(block => block.id), blocks.map(block => block.id))
    assert.deepEqual(parsed.map(block => block.tags), blocks.map(block => block.tags))
    assert.equal(parsed[1].content, `**${blocks[1].content.trimEnd()}** `)
    for (let index = 19; index < count; index += 20) assert.equal(parsed[index].content, blocks[index].content)
  }
  measure(`${count}/format-all`, format, verify, 1500)
  measure(`${count}/apply`, () => markdownSourceDraftToBlocks(formatted), parsed => {
    assert.deepEqual(parsed.map(block => block.id), blocks.map(block => block.id))
  }, 1000)
}
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/markdown-source-report.json', JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(),
  commit, workingTreeChanged, sourceFingerprint, fingerprintFiles, warmups, samples,
  environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, platform: process.platform, architecture: process.arch, node: process.version, electron: process.versions.electron },
  method: 'Isolated process operations; two warmups and seven samples. Block identity and metadata checks outside the timed region. p95 is the maximum sample. Ceilings detect regressions; these are not UI latency or competitor results.',
  inputs, metrics }, null, 2) + '\n')
if (metrics.some(metric => !metric.passed)) process.exitCode = 1
