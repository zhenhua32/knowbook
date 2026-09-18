import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { KnowbookStore } from '../src/main/database/store'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const samples = 7, warmups = 2, backgroundDocuments = 2_000, blocksPerSource = 20
const sourceFingerprint = createHash('sha256').update(['src/main/database/store.ts', 'src/main/database/markdown-link-index.ts',
  'src/main/database/schema.ts', 'src/main/database/schema-version.ts',
  'src/shared/markdownLinkMaintenance.ts', 'src/shared/markdownSourceLinks.ts', 'scripts/markdown-link-benchmark.ts']
  .map((path) => path + '\n' + readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).join('\n')).digest('hex')
const paragraph = (content: string): DocumentBlockDraft => ({ type: 'paragraph', content, checked: false, depth: 0 })
const metrics: Array<{ sources: number; operation: string; samplesMs: number[]; medianMs: number; p95Ms: number; limitMs: number; passed: boolean }> = []
for (const sourceCount of [100, 1_000]) {
  const root = mkdtempSync(join(os.tmpdir(), 'knowbook-markdown-links-'))
  const store = new KnowbookStore(join(root, 'workspace.db'))
  try {
    let target = ''
    const sources: string[] = []
    // Use the public mutation boundary: SQL-only fixtures omit derived indexes.
    store.runInBulkDocumentMutation(() => {
      target = store.createDocument(null)
      store.updateDocument(target, { title: 'Target', summary: '', blocks: [
        { ...paragraph('Changing'), type: 'heading-2' }, { ...paragraph('Stable'), type: 'heading-2' }, paragraph('Body')
      ] })
      for (let index = 0; index < sourceCount + backgroundDocuments; index++) {
        const id = store.createDocument(null)
        const blocks = index < sourceCount ? [paragraph(index % 10 === 0
          ? '[Chapter](Target.md#changing) [Stable](Target.md#stable) [[Target]]'
          : '[Stable](Target.md#stable) [Top](Target.md) [[Target]]'),
          ...Array.from({ length: blocksPerSource - 1 }, (_, block) => paragraph(`Source ${index} paragraph ${block}: 中文 **text** and \`code\`.`))]
          : [paragraph(`Unrelated document ${index}`)]
        store.updateDocument(id, { title: `Source ${index}`, summary: '', blocks })
        if (index < sourceCount) sources.push(id)
      }
    })
    assert.equal(store.getDocumentDetail(target)!.backlinks.length, sourceCount)
    for (const operation of ['body-edit', 'heading-rename', 'document-rename'] as const) {
      const times: number[] = []
      let expectedTitle = '', expectedHeading = ''
      for (let iteration = -warmups; iteration < samples; iteration++) {
        const detail = store.getDocumentDetail(target)!
        const blocks = detail.blocks.map((block, index) => operation === 'body-edit' && index === 2
          ? { ...block, content: `Body ${iteration}` } : operation === 'heading-rename' && index === 0
            ? { ...block, content: `Changing ${iteration + warmups}` } : block)
        expectedTitle = operation === 'document-rename' ? `Target ${iteration + warmups}` : detail.title
        expectedHeading = blocks[0].content.toLowerCase().replace(/ /g, '-')
        const started = performance.now()
        const affected = store.updateDocument(target, { ...detail, title: expectedTitle, blocks })
        const duration = performance.now() - started
        if (iteration >= 0) times.push(duration)
        assert.equal(affected.length, operation === 'body-edit' ? 1 : operation === 'heading-rename' ? sourceCount / 10 + 1 : sourceCount + 1)
      }
      // Validate every source outside the measured update, not just one link.
      for (const [index, id] of sources.entries()) {
        const detail = store.getDocumentDetail(id)!
        const path = encodeURIComponent(expectedTitle) + '.md'
        assert.equal(detail.blocks[0].content, index % 10 === 0
          ? `[Chapter](${path}#${expectedHeading}) [Stable](${path}#stable) [[${expectedTitle}]]`
          : `[Stable](${path}#stable) [Top](${path}) [[${expectedTitle}]]`)
        assert.equal(detail.blocks.length, blocksPerSource)
        assert.deepEqual(new Set(detail.outgoingLinks.map((link) => link.id)), new Set([target]))
        assert.deepEqual(store.checkDocumentLinks(id, () => null).issues, [])
      }
      const sorted = times.toSorted((a, b) => a - b), medianMs = sorted[Math.floor(samples / 2)], p95Ms = sorted.at(-1)!
      const limitMs = operation === 'body-edit' ? 250 : operation === 'heading-rename' ? 1_500 : 10_000
      metrics.push({ sources: sourceCount, operation, samplesMs: times, medianMs, p95Ms, limitMs, passed: medianMs < limitMs })
      console.log(`${sourceCount}/${operation}: median ${medianMs.toFixed(2)} ms, p95 ${p95Ms.toFixed(2)} ms`)
    }
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}
let commit = 'unknown', workingTreeChanged: boolean | null = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  workingTreeChanged = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim())
} catch { /* Source archives have no git metadata. */ }
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/markdown-link-report.json', JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(), commit,
  workingTreeChanged, sourceFingerprint, samples, warmups, backgroundDocuments, blocksPerSource,
  environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3,
    platform: process.platform, architecture: process.arch, node: process.version, electron: process.versions.electron },
  note: 'Real SQLite mutations with complete derived indexes; 10% of sources link to the renamed heading. Seven samples; p95 is their maximum. Regression ceilings are not UI latency promises.', metrics }, null, 2) + '\n')
if (metrics.some((metric) => !metric.passed)) process.exitCode = 1
