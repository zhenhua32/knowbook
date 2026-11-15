import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Rows } from './restore-knowledge-graph3-data'
import type { observeRootRestoreFinalAssetClosure5 } from './restore-knowledge-final-asset-closure5'
import type { readRootRestorePhysicalStageAssetEvidence3 } from './restore-knowledge-stage3-physical'
import type { readRootRestoreWorkingAssetStageAndSources5 } from './restore-knowledge-working-asset-stage5'
import type { Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'

type Physical = Awaited<ReturnType<typeof readRootRestorePhysicalStageAssetEvidence3>>
type Assets = Awaited<ReturnType<typeof readRootRestoreWorkingAssetStageAndSources5>>
type Audit = ReturnType<typeof observeRootRestoreFinalAssetClosure5>
const fail = (reason: string): never => { throw new Error('恢复保留策略附件审计失败：' + reason) }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const retainedAssetTableHash5 = (table: Capsule2RawSqlTable) => hash('knowbook.restore.stage3.exact-table.v1', { ...table,
  rows: [...table.rows].sort((left, right) => BigInt(left.sourceRowId) < BigInt(right.sourceRowId) ? -1 : 1) })

/** This supplement authenticates the finite source policy against the exact
 * retained SQLite table. Older audit and alias-manifest hashes stay intact. */
export function observeRootRestoreRetainedAssetPolicy5(physical: Physical, assets: Assets, audit: Audit) {
  const { source } = assets.sources.captured.pair.current
  const raw = source.sourceContent, policy = source.policy
  const original = new Map(raw.tables.filter(table => table.role === 'policy-unresolved').map(table => [table.name, table]))
  const actual = new Map(physical.value.protectedObservations.map(row => [row.table, row.rowHash]))
  const occurrenceTables = new Map<string, Audit['entries'][number][]>()
  for (const entry of audit.entries) {
    if (entry.domain !== 'retained-sql') continue
    const table = entry.scope[0], list = occurrenceTables.get(table) ?? []
    list.push(entry)
    occurrenceTables.set(table, list)
  }
  if (original.size !== policy.tables.length || source.assets.sourceContentHash !== policy.sourceContentHash)
    return fail('来源策略没有覆盖确切 SQL')
  const seen = new Set<string>()
  const resolved = new Set<string>()
  const tables = policy.tables.map(rule => {
    const table = original.get(rule.table)
    if (!table || seen.has(rule.table) || table.rows.length !== rule.rows
      || hash('knowbook.capsule2.source-policy-original-table.v1', table) !== rule.originalTableHash
      || rule.executionRule !== 'retain-original-only-no-replay') return fail('策略来源原表或角色不符')
    seen.add(rule.table)
    const observed = rule.table === 'app_settings' ? physical.retainedSettingsHash : actual.get(rule.table)
    const entries = occurrenceTables.get(rule.table) ?? []
    const missingWorking = rule.table === 'app_settings' && audit.remainder.some(item => item.domain === 'retained-working')
    let typedEvents = 0
    if (rule.assetRule === 'host-message-and-retained-stream-markdown') {
      if (rule.table !== 'assistant_events') return fail('未知类型化策略 Markdown 表')
      const events = graph3Rows(raw, 'assistant_events').filter(row =>
        row.value.type === 'assistant.message' || row.value.type === 'assistant.chunk')
      typedEvents = events.length
      const visited = source.assets.scopes.filter(scope => scope.source[0] === rule.table)
        .flatMap(scope => scope.assistant?.parts.map(part => part.eventId) ?? [])
      const ids = new Set(visited)
      if (ids.size !== typedEvents || visited.length !== typedEvents || events.some(row => !ids.has(String(row.value.id))))
        return fail('保留助手消息和流事件未由确切范围覆盖')
    } else if (rule.assetRule !== 'opaque-values-not-paths-or-markdown') return fail('未知保留策略附件语义')
    const status = observed === retainedAssetTableHash5(table) && !missingWorking && entries.every(item => item.status === 'matched')
      ? 'proved' as const : 'unresolved' as const
    if (status === 'proved') resolved.add(rule.table)
    return { table: rule.table, rows: rule.rows, originalTableHash: rule.originalTableHash, assetRule: rule.assetRule,
      typedEvents, matchedOccurrences: entries.filter(item => item.status === 'matched').length, status }
  })
  const remaining = audit.remainder.filter(item => item.reason !== 'remaining-policy-held-payload-asset-scopes'
    || item.scope.length !== 1 || !resolved.has(item.scope[0]))
  const value = { kind: 'root-restore-retained-asset-policy-audit' as const, version: 1 as const,
    assetAuditHash: audit.observationHash, policyObservationHash: policy.observationHash, tables, remaining,
    blockedOccurrences: audit.blocked, finalAssetClosureComplete: false as const, installPermit: false as const }
  return freezeCapsuleValue({ ...value, observationHash: hash('knowbook.restore.retained-asset-policy-audit.v1', value) })
}
