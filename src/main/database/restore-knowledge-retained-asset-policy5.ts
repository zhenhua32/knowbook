import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Value } from './restore-knowledge-graph3-data'
import type { observeRootRestoreFinalAssetClosure5 } from './restore-knowledge-final-asset-closure5'
import type { readRootRestorePhysicalStageAssetEvidence3 } from './restore-knowledge-stage3-physical'
import type { readRootRestoreWorkingAssetStageAndSources5 } from './restore-knowledge-working-asset-stage5'
import { hashValidatedCapsule2RawSqlTable, type Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'

type Physical = Awaited<ReturnType<typeof readRootRestorePhysicalStageAssetEvidence3>>
type Assets = Awaited<ReturnType<typeof readRootRestoreWorkingAssetStageAndSources5>>
type Audit = ReturnType<typeof observeRootRestoreFinalAssetClosure5>
const fail = (reason: string): never => { throw new Error('恢复保留策略附件审计失败：' + reason) }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const retainedAssetTableHash5 = (table: Capsule2RawSqlTable) => hashValidatedCapsule2RawSqlTable('knowbook.restore.stage3.exact-table.v1', table)

function captureRetainedPolicy(physical: Physical, assets: Assets, audit: Audit) {
  const { source } = assets.sources.captured.pair.current
  const raw = source.sourceContent, policy = source.policy
  const original = new Map(raw.tables.filter(table => table.role === 'policy-unresolved').map(table => [table.name, table]))
  const actual = new Map(physical.value.protectedObservations.map(row => [row.table, row.rowHash]))
  const occurrences = new Map<string, { total: number; matched: number }>()
  for (const entry of audit.entries) {
    if (entry.domain !== 'retained-sql') continue
    const table = entry.scope[0], counts = occurrences.get(table) ?? { total: 0, matched: 0 }
    counts.total++
    if (entry.status === 'matched') counts.matched++
    occurrences.set(table, counts)
  }
  const tables = policy.tables.map(rule => {
    const table = original.get(rule.table), observed = rule.table === 'app_settings' ? physical.retainedSettingsHash : actual.get(rule.table)
    const { total, matched } = occurrences.get(rule.table) ?? { total: 0, matched: 0 }
    const missingWorking = rule.table === 'app_settings' && audit.remainder.some(item => item.domain === 'retained-working')
    let typedEvents = 0, eventCoverage = true
    if (table && rule.table === 'assistant_events' && rule.assetRule === 'host-message-and-retained-stream-markdown') {
      const visited = source.assets.scopes.filter(scope => scope.source[0] === rule.table)
        .flatMap(scope => scope.assistant?.parts.map(part => part.eventId) ?? [])
      const ids = new Set(visited), type = table.columns.indexOf('type'), id = table.columns.indexOf('id')
      for (const row of table.rows) {
        const kind = graph3Value(row.cells[type], raw.encoding)
        if (kind !== 'assistant.message' && kind !== 'assistant.chunk') continue
        typedEvents++
        if (!ids.has(String(graph3Value(row.cells[id], raw.encoding)))) eventCoverage = false
      }
      eventCoverage &&= ids.size === typedEvents && visited.length === typedEvents
    }
    return { rule, rows: table?.rows.length,
      originalHash: table && hashValidatedCapsule2RawSqlTable('knowbook.capsule2.source-policy-original-table.v1', table),
      exactRetainedRows: table !== undefined && observed === retainedAssetTableHash5(table), total, matched, missingWorking, typedEvents, eventCoverage }
  })
  return { originalCount: original.size, sourceContentMatches: source.assets.sourceContentHash === policy.sourceContentHash,
    tables, assetAuditHash: audit.observationHash, policyObservationHash: policy.observationHash,
    remainder: audit.remainder, blocked: audit.blocked }
}

/** The later history writer can check the same policy without retaining raw
 * source tables, candidate cells or the expanded asset occurrence graph. */
export function prepareRootRestoreRetainedAssetPolicy5(physical: Physical, assets: Assets, audit: Audit) {
  const evidence = captureRetainedPolicy(physical, assets, audit)
  return () => observeRetainedPolicy(evidence)
}

function observeRetainedPolicy(evidence: ReturnType<typeof captureRetainedPolicy>) {
  if (evidence.originalCount !== evidence.tables.length || !evidence.sourceContentMatches)
    return fail('来源策略没有覆盖确切 SQL')
  const seen = new Set<string>()
  const resolved = new Set<string>()
  const tables = evidence.tables.map(({ rule, rows, originalHash, exactRetainedRows, total, matched, missingWorking, typedEvents, eventCoverage }) => {
    if (seen.has(rule.table) || rows !== rule.rows || originalHash !== rule.originalTableHash
      || rule.executionRule !== 'retain-original-only-no-replay') return fail('策略来源原表或角色不符')
    seen.add(rule.table)
    if (rule.assetRule === 'host-message-and-retained-stream-markdown') {
      if (rule.table !== 'assistant_events') return fail('未知类型化策略 Markdown 表')
      if (!eventCoverage) return fail('保留助手消息和流事件未由确切范围覆盖')
    } else if (rule.assetRule !== 'opaque-values-not-paths-or-markdown') return fail('未知保留策略附件语义')
    const status = exactRetainedRows && !missingWorking && total === matched
      ? 'proved' as const : 'unresolved' as const
    if (status === 'proved') resolved.add(rule.table)
    return { table: rule.table, rows: rule.rows, originalTableHash: rule.originalTableHash, assetRule: rule.assetRule,
      typedEvents, matchedOccurrences: matched, status }
  })
  const remaining = evidence.remainder.filter(item => item.reason !== 'remaining-policy-held-payload-asset-scopes'
    || item.scope.length !== 1 || !resolved.has(item.scope[0]))
  const value = { kind: 'root-restore-retained-asset-policy-audit' as const, version: 1 as const,
    assetAuditHash: evidence.assetAuditHash, policyObservationHash: evidence.policyObservationHash, tables, remaining,
    blockedOccurrences: evidence.blocked, finalAssetClosureComplete: false as const, installPermit: false as const }
  return freezeCapsuleValue({ ...value, observationHash: hash('knowbook.restore.retained-asset-policy-audit.v1', value) })
}
