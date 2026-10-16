/**
 * Two local Source Applies on one real controller / CodeMirror lineage.
 *
 * Run with Electron's Node mode and tsx, from the repository root:
 *   electron --import tsx scripts/synced-source-checkpoint-benchmark.ts --output-dir <new-directory>
 * The caller must set ELECTRON_RUN_AS_NODE=1 and wait for the actual child exit.
 * Every invocation requires a new output directory; previous evidence is never replaced.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { EditorState } from '@codemirror/state'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedBlocksApi, SyncedCanonicalEdit, SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import { getSyncedWorkspaceController, readSyncedWorkingEndpoint } from '../src/renderer/src/features/synced-blocks/controller'
import { openSyncedSourceCheckpoint, createCanonicalSourceLedgerSession, prepareSourceCheckpoint,
  readPreparedSourceCheckpoint, applyPreparedSourceCheckpoint, readAcceptedSourceCheckpoint } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { readCanonicalSourceAllocation, readMarkdownSourceDraftReceipt } from '../src/renderer/src/features/synced-blocks/sourceManifest'
import type { SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { markdownSourceEditorText } from '../src/renderer/src/utils/markdownSourceSession'

const sizes = [800, 4000] as const
const segments = ['open', 'fork1', 'prepare1', 'apply1', 'fork2', 'prepare2', 'apply2'] as const
type Segment = typeof segments[number]
type Phase = 'preflight' | 'warmup' | 'measured'
type Flow = {
  blocks: number; phase: Phase; iteration: number; status: 'running' | 'passed' | 'failed'
  timingsMs: Partial<Record<Segment, number | null>>
  input?: { sourceCharacters: number; sourceSha256: string; blocksSha256: string; links: number }
  first?: ReturnType<typeof oracle>
  second?: ReturnType<typeof oracle>
  freshIds?: { first: number; second: number; id: string }
  receipts?: { initialRevision: number; firstRevision: number; secondRevision: number; sameOpening: boolean }
  forbiddenPortCalls?: string[]
  memoryAfter?: NodeJS.MemoryUsage
  failure?: { name: string; message: string; stack?: string }
}
const fixedTime = '2026-10-16T00:00:00.000Z'
const prefix = '前'
const newParagraph = '新增 [链接](Same.md) 段落'
const secondInput = '字'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const jsonSha256 = (value: unknown) => sha256(JSON.stringify(value))
const keyId = (key: Readonly<SyncedBindingKey>) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
const failure = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message, stack: error.stack }
  : { name: 'ThrownValue', message: String(error) }

/** No parser is used to construct expected block bodies or edit correspondence. */
function fixture(count: number): SyncedCanonicalEdit[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `checkpoint-block-${index}`, type: 'paragraph', depth: 0, parentBlockId: null, checked: false,
    content: `段落 ${index} 中文🙂 [原链接](Same.md) ${'Source editing performance. '.repeat(4)}`
      + (index % 10 === 0 ? ' [重复链接](Same.md)' : ''),
    tags: [`group-${index % 5}`], ...(index % 7 === 0 ? { highlight: 'yellow' } : {})
  }))
}
function keys(blocks: readonly SyncedCanonicalEdit[], originPath: string): SyncedBindingKey[] {
  return collectDocumentMarkdownLinks([...blocks]).filter(link => link.kind !== 'image'
    && (link.kind === 'wiki' || resolveMarkdownDocumentPath(originPath, link.url) !== null)).map(link => {
      const block = blocks[link.blockIndex]
      assert.ok(block)
      assert.equal(link.blockId, block.id)
      return { blockId: block.id, from: link.start, to: link.end,
        raw: block.content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }
    })
}
function snapshot(blocks: SyncedCanonicalEdit[]): SyncedGroupSnapshot {
  const instanceId = randomUUID()
  const value: SyncedGroupSnapshot = { groupId: randomUUID(), creationId: randomUUID(), createdAt: fixedTime,
    revision: randomUUID(), topologyRevision: randomUUID(), origin: { version: 1, documentId: 'benchmark-origin',
      pathAtCreation: 'Bench/Source', firstInstanceId: instanceId }, bindings: [],
    blocks: blocks.map(block => ({ ...block, createdAt: fixedTime })),
    instances: [{ instanceId, hostDocumentId: 'benchmark-host', bindingVersion: randomUUID(),
      depth: 0, parentBlockId: null, parentType: null }],
    history: { cursor: randomUUID(), undoToken: null, redoToken: null }, maxRelativeDepth: 0 }
  value.bindings = keys(blocks, value.origin.pathAtCreation).map((key, index) => ({ ...key,
    target: { kind: 'document', id: `distinct-original-target-${index}`, state: 'live' } }))
  return value
}
function scope(value: SyncedGroupSnapshot): SyncedGroupScope {
  const instance = value.instances[0]
  return { owner: { kind: 'synced-group', groupId: value.groupId }, ...instance,
    hostSession: {}, mountEpoch: {}, bindingEpoch: {}, windowSessionId: 'benchmark-window',
    domNamespace: 'benchmark-instance', root: () => null, isCurrent: () => true }
}
/** The only permitted reads are the initial snapshot and change subscription.
 * No Main implementation, IPC, SQLite, persistent writer or ACK is involved. */
function port(value: SyncedGroupSnapshot) {
  const forbidden: string[] = []
  let snapshotReads = 0, activeSubscriptions = 0
  const deny = (operation: string): never => { forbidden.push(operation); throw new Error(`Forbidden benchmark port call: ${operation}`) }
  const api: SyncedBlocksApi = {
    getSyncedGroupSnapshots: async () => {
      snapshotReads++
      assert.equal(snapshotReads, 1)
      return { workspaceScope: randomUUID(), items: [{ status: 'ready', snapshot: structuredClone(value) }] }
    },
    onSyncedBlocksChanged: () => { activeSubscriptions++; return () => { activeSubscriptions-- } },
    listSyncedGroups: async () => deny('listSyncedGroups'),
    updateSyncedBlockGroup: async () => deny('updateSyncedBlockGroup'),
    getSyncedOperation: async () => deny('getSyncedOperation'),
    applySyncedHostStructure: async () => deny('applySyncedHostStructure'),
    restoreSyncedGroupOperation: async () => deny('restoreSyncedGroupOperation'),
    restoreSyncedHostOperation: async () => deny('restoreSyncedHostOperation'),
    getSyncedHostHistory: async () => deny('getSyncedHostHistory')
  }
  return { api, forbidden, deny, verify() { assert.equal(snapshotReads, 1); assert.equal(activeSubscriptions, 1); assert.deepEqual(forbidden, []) } }
}
/** Collector closure alone would allow two Same.md sources to be exchanged.
 * Pair each destination with the same known block and physical-link ordinal
 * in the independently collected before body, then verify the exact pair. */
function oracle(input: { before: readonly SyncedCanonicalEdit[]; expected: readonly SyncedCanonicalEdit[];
  actual: readonly SyncedCanonicalEdit[]; claims: readonly SyncedBindingClaim[]; originPath: string; newId: string | null; first: boolean }) {
  assert.deepEqual(input.actual, input.expected, 'Complete block identities, content, structure and metadata must match the authored edit')
  const source = keys(input.before, input.originPath), destination = keys(input.expected, input.originPath)
  const actualDestination = keys(input.actual, input.originPath)
  assert.deepEqual(actualDestination, destination)
  const claimedDestination = input.claims.map(claim => keyId(claim.destination))
  assert.equal(new Set(claimedDestination).size, claimedDestination.length)
  assert.deepEqual(claimedDestination.toSorted(), destination.map(keyId).toSorted())
  const sourceByBlock = new Map<string, SyncedBindingKey[]>()
  for (const key of source) { const current = sourceByBlock.get(key.blockId) ?? []; current.push(key); sourceByBlock.set(key.blockId, current) }
  const ordinals = new Map<string, number>(), claimByDestination = new Map(input.claims.map(claim => [keyId(claim.destination), claim]))
  const exactPairs: Array<{ kind: 'continue'; source: SyncedBindingKey; destination: SyncedBindingKey } | { kind: 'new'; destination: SyncedBindingKey }> = []
  for (const key of destination) {
    const ordinal = ordinals.get(key.blockId) ?? 0
    ordinals.set(key.blockId, ordinal + 1)
    const claim = claimByDestination.get(keyId(key))
    assert.ok(claim)
    assert.equal(Object.hasOwn(claim, 'target'), false)
    if (input.newId === key.blockId) {
      assert.deepEqual(claim, { kind: 'new', destination: key })
      exactPairs.push({ kind: 'new', destination: key })
    } else {
      const original = sourceByBlock.get(key.blockId)?.[ordinal]
      assert.ok(original)
      assert.deepEqual(claim, { kind: 'continue', source: original, destination: key })
      if (input.first && key.blockId === input.before[0].id) {
        assert.equal(key.from, original.from + 1, 'The first block destination moves by exactly one UTF-16 unit')
        assert.equal(key.to, original.to + 1)
      }
      exactPairs.push({ kind: 'continue', source: original, destination: key })
    }
  }
  const claimedSource = input.claims.flatMap(claim => claim.kind === 'continue' ? [keyId(claim.source)] : [])
  assert.equal(new Set(claimedSource).size, claimedSource.length)
  assert.deepEqual(claimedSource.toSorted(), source.map(keyId).toSorted())
  return { verified: true, blocks: input.actual.length, links: destination.length,
    continued: claimedSource.length, created: input.claims.filter(claim => claim.kind === 'new').length,
    blockSha256: jsonSha256(input.actual), sourceKeysSha256: jsonSha256(source), destinationKeysSha256: jsonSha256(destination),
    exactPairsSha256: jsonSha256(exactPairs), actualClaimsSha256: jsonSha256(input.claims) }
}

const arguments_ = process.argv.slice(2)
assert.equal(arguments_.length, 2, 'Usage: --output-dir <new-directory>')
assert.equal(arguments_[0], '--output-dir', 'Usage: --output-dir <new-directory>')
const outputDirectory = resolve(arguments_[1])
mkdirSync(dirname(outputDirectory), { recursive: true })
mkdirSync(outputDirectory) // EEXIST is intentional: never overwrite a previous run.
const reportPath = resolve(outputDirectory, 'report.json')
const retained: unknown[] = []
const report = {
  schemaVersion: 1, benchmark: 'synced-source-checkpoint-two-apply', startedAt: new Date().toISOString(),
  status: 'running' as 'running' | 'passed' | 'failed',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }),
  scriptSha256: sha256(readFileSync(resolve('scripts/synced-source-checkpoint-benchmark.ts'))),
  environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, platform: process.platform,
    architecture: process.arch, node: process.version, electron: process.versions.electron ?? null,
    totalMemory: os.totalmem(), initialMemory: process.memoryUsage() },
  plan: { sizes, preflightPerSize: 1, warmupPerSize: 1, measuredPerSize: 3, totalFreshFlows: 10,
    segments, maximumBasisDepth: 2, thresholds: null },
  method: [
    'Both complete untimed preflights pass before any timing. Every flow creates a fresh registered controller, binding, Source opening and CM lineage.',
    'Fixture, registry load, initial EditorState creation, expected bodies, collector oracle, hashing, and report IO are outside the seven timed regions.',
    'Each fork times one real CM update plus reading its actual Source draft. First fork inserts a one-unit outside prefix and one complete linked paragraph; second fork types one unit at its end.',
    'The first preparation must allocate exactly one fresh block ID. The second allocator throws if called and must preserve that ID and exact accepted link sources.',
    'All local Apply persistence and flush calls are forbidden; this covers a mock contract port, not Main, IPC, SQLite or a product UI.',
    'All samples, including warmups and preflights, are retained. No threshold, retry, old first-Apply comparison, per-key, long-session, or UI-performance claim is made.',
    'Opening, allocation, endpoint and controller objects are intentionally retained until report completion. Process RSS includes this retention, fixture/oracle work and IO; it cannot be attributed to any segment or to product UI memory.'
  ],
  preflightGatePassed: false,
  flows: [] as Flow[],
  metrics: [] as Array<{ blocks: number; segment: Segment; samplesMs: number[]; medianMs: number; maximumSampleMs: number }>,
  finishedAt: null as string | null,
  finalMemory: null as NodeJS.MemoryUsage | null,
  failure: null as ReturnType<typeof failure> | null
}
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')

async function runFlow(count: number, phase: Phase, iteration: number) {
  const row: Flow = { blocks: count, phase, iteration, status: 'running', timingsMs: {} }
  report.flows.push(row)
  const timed = <T>(segment: Segment, run: () => T): T => {
    if (phase === 'preflight') { row.timingsMs[segment] = null; return run() }
    assert.equal(report.preflightGatePassed, true)
    const start = performance.now()
    try { return run() } finally { row.timingsMs[segment] = performance.now() - start }
  }
  try {
    const original = fixture(count), value = snapshot(original), mock = port(value)
    row.forbiddenPortCalls = mock.forbidden
    const workspace = getSyncedWorkspaceController(mock.api)
    await workspace.load([value.groupId])
    const controller = workspace.getGroup(value.groupId)
    assert.ok(controller)
    const binding = controller.bind(scope(value))
    // Preserve the genuine registered object while ensuring an accidental flush
    // fails immediately, even if the controller is currently clean.
    binding.flush = async () => mock.deny('binding.flush')
    const newId = randomUUID(), firstTransactionId = randomUUID(), secondTransactionId = randomUUID(), expected1 = structuredClone(original)
    expected1[0].content = prefix + expected1[0].content
    expected1.push({ id: newId, type: 'paragraph', content: newParagraph, checked: false, depth: 0, parentBlockId: null })
    const expected2 = structuredClone(expected1)
    expected2.at(-1)!.content += secondInput
    const opened = timed('open', () => openSyncedSourceCheckpoint(binding))
    assert.ok(opened)
    const session = createCanonicalSourceLedgerSession({ draft: opened.draft })
    let state = EditorState.create({ doc: markdownSourceEditorText(opened.draft.source), extensions: session.extension })
    const initialReceipt = readMarkdownSourceDraftReceipt(opened.draft)
    row.input = { sourceCharacters: opened.draft.source.length, sourceSha256: sha256(opened.draft.source),
      blocksSha256: jsonSha256(original), links: value.bindings.length }
    assert.equal(row.input.links, count + Math.ceil(count / 10))
    const expectedSource1 = prefix + opened.draft.source + '\n\n' + newParagraph
    const firstDraft = timed('fork1', () => {
      state = state.update({ changes: [{ from: 0, insert: prefix }, { from: state.doc.length, insert: '\n\n' + newParagraph }] }).state
      return session.read(state)
    })
    assert.equal(firstDraft.source, expectedSource1)
    let firstIds = 0, secondIds = 0
    const firstPreparation = timed('prepare1', () => prepareSourceCheckpoint({ checkpoint: opened.checkpoint,
      draft: firstDraft, freshId: () => { firstIds++; assert.equal(firstIds, 1); return newId } }))
    assert.equal(firstPreparation.status, 'prepared')
    assert.ok(firstPreparation.status === 'prepared')
    assert.equal(firstIds, 1)
    const firstFacts = readPreparedSourceCheckpoint(firstPreparation.preparation)
    row.first = oracle({ before: original, expected: expected1, actual: firstFacts.blocks,
      claims: firstFacts.bindingClaims, originPath: value.origin.pathAtCreation, newId, first: true })
    assert.equal(firstFacts.draft, firstDraft)
    assert.equal(firstFacts.draftReceipt, readMarkdownSourceDraftReceipt(firstDraft))
    assert.deepEqual(readCanonicalSourceAllocation(firstFacts.allocation).blocks, expected1)
    const firstApply = timed('apply1', () => applyPreparedSourceCheckpoint({ preparation: firstPreparation.preparation,
      transactionId: firstTransactionId }))
    assert.equal(firstApply.status, 'accepted')
    assert.ok(firstApply.status === 'accepted')
    const firstAccepted = readAcceptedSourceCheckpoint(firstApply.accepted)
    assert.ok(firstAccepted)
    assert.equal(firstAccepted.allocation, firstFacts.allocation)
    assert.equal(firstAccepted.draft, firstDraft)
    assert.equal(firstAccepted.committed, null)
    assert.deepEqual(binding.getCurrent().working, expected1)
    assert.equal(binding.getCurrent().editSequence, 1)
    const firstEndpoint = readSyncedWorkingEndpoint(firstAccepted.endpoint)
    assert.ok(firstEndpoint.status === 'available')
    assert.deepEqual(firstEndpoint.working, expected1)
    const secondDraft = timed('fork2', () => {
      state = state.update({ changes: { from: state.doc.length, insert: secondInput } }).state
      return session.read(state)
    })
    assert.equal(secondDraft.source, expectedSource1 + secondInput)
    const secondPreparation = timed('prepare2', () => prepareSourceCheckpoint({ checkpoint: opened.checkpoint,
      draft: secondDraft, freshId: () => { secondIds++; throw new Error('Second preparation must not allocate a new block ID') } }))
    assert.equal(secondPreparation.status, 'prepared')
    assert.ok(secondPreparation.status === 'prepared')
    assert.equal(secondIds, 0)
    const secondFacts = readPreparedSourceCheckpoint(secondPreparation.preparation)
    row.second = oracle({ before: expected1, expected: expected2, actual: secondFacts.blocks,
      claims: secondFacts.bindingClaims, originPath: value.origin.pathAtCreation, newId: null, first: false })
    assert.equal(secondFacts.draft, secondDraft)
    assert.equal(secondFacts.draftReceipt, readMarkdownSourceDraftReceipt(secondDraft))
    assert.deepEqual(readCanonicalSourceAllocation(secondFacts.allocation).blocks, expected2)
    const secondApply = timed('apply2', () => applyPreparedSourceCheckpoint({ preparation: secondPreparation.preparation,
      transactionId: secondTransactionId }))
    assert.equal(secondApply.status, 'accepted')
    assert.ok(secondApply.status === 'accepted')
    const secondAccepted = readAcceptedSourceCheckpoint(secondApply.accepted)
    assert.ok(secondAccepted)
    assert.equal(secondAccepted.allocation, secondFacts.allocation)
    assert.equal(secondAccepted.draft, secondDraft)
    assert.equal(secondAccepted.committed, null)
    assert.deepEqual(binding.getCurrent().working, expected2)
    assert.equal(binding.getCurrent().editSequence, 2)
    const secondEndpoint = readSyncedWorkingEndpoint(secondAccepted.endpoint)
    assert.ok(secondEndpoint.status === 'available')
    assert.deepEqual(secondEndpoint.working, expected2)
    const firstReceipt = readMarkdownSourceDraftReceipt(firstDraft), secondReceipt = readMarkdownSourceDraftReceipt(secondDraft)
    assert.equal(firstReceipt.opening, initialReceipt.opening)
    assert.equal(secondReceipt.opening, initialReceipt.opening)
    assert.equal(firstReceipt.revision, initialReceipt.revision + 1)
    assert.equal(secondReceipt.revision, firstReceipt.revision + 1)
    row.receipts = { initialRevision: initialReceipt.revision, firstRevision: firstReceipt.revision,
      secondRevision: secondReceipt.revision, sameOpening: true }
    row.freshIds = { first: firstIds, second: secondIds, id: newId }
    mock.verify()
    row.forbiddenPortCalls = [...mock.forbidden]
    // Retention is deliberate and reported; no UI memory interpretation is valid.
    retained.push({ workspace, controller, binding, opened, state, firstFacts, firstAccepted, secondFacts, secondAccepted })
    row.memoryAfter = process.memoryUsage()
    row.status = 'passed'
    save()
    console.log(`${count}/${phase}/${iteration}: PASS${phase === 'preflight' ? ' (untimed)' : ' ' + segments.map(name => `${name}=${row.timingsMs[name]!.toFixed(2)}ms`).join(' ')}`)
  } catch (error) {
    row.status = 'failed'
    row.failure = failure(error)
    throw error
  }
}

async function main() {
  save()
  for (const count of sizes) await runFlow(count, 'preflight', 1)
  report.preflightGatePassed = true
  save()
  for (const count of sizes) {
    await runFlow(count, 'warmup', 1)
    for (let iteration = 1; iteration <= 3; iteration++) await runFlow(count, 'measured', iteration)
  }
  assert.equal(report.flows.length, 10)
  assert.equal(retained.length, 10)
  for (const count of sizes) for (const segment of segments) {
    const samplesMs = report.flows.filter(flow => flow.blocks === count && flow.phase === 'measured').map(flow => flow.timingsMs[segment]!)
    assert.equal(samplesMs.length, 3)
    assert.ok(samplesMs.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0))
    const ordered = samplesMs.toSorted((left, right) => left - right)
    report.metrics.push({ blocks: count, segment, samplesMs, medianMs: ordered[1], maximumSampleMs: ordered[2] })
  }
  report.status = 'passed'
}
main().catch(error => {
  report.status = 'failed'
  report.failure = failure(error)
  process.exitCode = 1
  console.error(error)
}).finally(() => {
  report.finishedAt = new Date().toISOString()
  report.finalMemory = process.memoryUsage()
  save()
  console.log(`Report: ${reportPath}`)
})
