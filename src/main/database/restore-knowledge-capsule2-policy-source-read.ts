import type Database from 'better-sqlite3'
import { STORED_PLUGIN_POLICY_TABLES } from '../plugin-platform/repository'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readRawCapsule2ContentOwned } from './restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2PhysicalGraphOwned } from './restore-knowledge-capsule2-physical-raw-read'
import { assertRawCapsule2OrdinaryHistoryOwned } from './restore-knowledge-capsule2-ordinary-history-read'
import { assertRawCapsule2TemplatesOwned } from './restore-knowledge-capsule2-templates-read'
import { assertRawCapsule2MovesOwned } from './restore-knowledge-capsule2-moves-read'
import { assertRawCapsule2AssistantHistoryOwned } from './restore-knowledge-capsule2-assistant-read'
import { assertRawCapsule2PreferencesOwned } from './restore-knowledge-capsule2-preferences-read'
import { assertRawCapsule2PluginPolicyOwned } from './restore-knowledge-capsule2-plugin-policy-read'
import { CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'

type Family = 'host-settings-and-reserved-metadata' | 'host-activity-text' | 'host-assistant-event-history' | 'plugin-retained-storage'
type AssetRule = 'host-message-and-retained-stream-markdown' | 'opaque-values-not-paths-or-markdown'
type Policy = { family: Family; assetRule: AssetRule; executionRule: 'retain-original-only-no-replay' }
const policies = new Map<string, Policy>([
  ['app_settings', { family: 'host-settings-and-reserved-metadata', assetRule: 'opaque-values-not-paths-or-markdown', executionRule: 'retain-original-only-no-replay' }],
  ['workspace_events', { family: 'host-activity-text', assetRule: 'opaque-values-not-paths-or-markdown', executionRule: 'retain-original-only-no-replay' }],
  ...['assistant_sessions', 'assistant_events'].map(table => [table, { family: 'host-assistant-event-history', assetRule: table === 'assistant_events' ? 'host-message-and-retained-stream-markdown' : 'opaque-values-not-paths-or-markdown',
    executionRule: 'retain-original-only-no-replay' }] as [string, Policy]),
  ...STORED_PLUGIN_POLICY_TABLES.map(table => [table, { family: 'plugin-retained-storage', assetRule: 'opaque-values-not-paths-or-markdown',
    executionRule: 'retain-original-only-no-replay' }] as [string, Policy])
])
const bad = (message: string): never => { throw new Error('capsule2 source policy无效：' + message + '；不修原件，不重放设置/事件/插件，不授文件、grant、认证或安装权。') }

export interface RawCapsule2SourcePolicy {
  readonly kind: 'capsule2-source-policy-dispositions'; readonly version: 1; readonly forReader: typeof CAPSULE2_READER
  readonly state: 'retained-original-policy-only'; readonly schemaVersion: 26 | 27; readonly sourceContentHash: string
  readonly tables: readonly (Policy & { readonly table: string; readonly rows: number; readonly originalTableHash: string })[]
  readonly managedFiles: 'requires-actual-main-managed-originals'; readonly externalPaths: 'original-literals-only-no-follow'
  readonly reservedMetadata: 'requires-observer2-total2-and-prior-root-interpretation'
  readonly certified: false; readonly semanticValidationComplete: false; readonly acceptedCoverage: false; readonly effective: false
  readonly replayAllowed: false; readonly executionAllowed: false; readonly grantAuthority: false; readonly permit: false
  readonly observationHash: string
}

/** Exact former workspace source preflight order, now also classifying EVERY
 * policy-role table. Only a real readonly/query-only/FKON transaction enters;
 * no caller raw DTO, family allowlist, policy plan or attestation is accepted.
 * This returns full private source data; never expose it as UI diagnostics.
 * Reserved metadata still needs the outer historical interpreter. Classifying
 * its source bytes as retained data cannot turn it into ordinary/empty K. */
export function readRawCapsule2OrdinaryPolicySourceOwned(db: Database.Database) {
  const sourceContent = readRawCapsule2ContentOwned(db)
  const physical = readRawCapsule2PhysicalGraphOwned(db)
  assertRawCapsule2OrdinaryHistoryOwned(db)
  assertRawCapsule2TemplatesOwned(db)
  assertRawCapsule2MovesOwned(db)
  assertRawCapsule2AssistantHistoryOwned(db)
  assertRawCapsule2PreferencesOwned(db)
  assertRawCapsule2PluginPolicyOwned(db)
  const sourceContentHash = capsuleBytesHash('knowbook.capsule2.workspace-history-source-content.v1\0' + capsuleJson(sourceContent))
  const tables: Array<Policy & { table: string; rows: number; originalTableHash: string }> = [], seen = new Set<string>()
  for (const table of sourceContent.tables) {
    if (table.role !== 'policy-unresolved') {
      if (policies.has(table.name)) return bad('已知policy family被降成另一raw角色')
      continue
    }
    const policy = policies.get(table.name)
    if (!policy || seen.has(table.name)) return bad('完整来源含未分类/重复policy family')
    seen.add(table.name)
    tables.push({ table: table.name, rows: table.rows.length, ...policy,
      originalTableHash: capsuleBytesHash('knowbook.capsule2.source-policy-original-table.v1\0' + capsuleJson(table)) })
  }
  if (seen.size !== policies.size) return bad('完整policy family缺失，不能当作空集合')
  tables.sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0)
  const body = { kind: 'capsule2-source-policy-dispositions' as const, version: 1 as const, forReader: CAPSULE2_READER,
    state: 'retained-original-policy-only' as const, schemaVersion: sourceContent.schemaVersion, sourceContentHash, tables,
    managedFiles: 'requires-actual-main-managed-originals' as const, externalPaths: 'original-literals-only-no-follow' as const,
    reservedMetadata: 'requires-observer2-total2-and-prior-root-interpretation' as const,
    certified: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const,
    replayAllowed: false as const, executionAllowed: false as const, grantAuthority: false as const, permit: false as const }
  const policy: RawCapsule2SourcePolicy = freezeCapsuleValue({ ...body,
    observationHash: capsuleBytesHash('knowbook.capsule2.source-policy-dispositions.v1\0' + capsuleJson(body)) })
  return Object.freeze({ sourceContent, physical, policy })
}

/** Only counts and disposition identifiers leave this diagnostic. Original
 * policy TEXT/JSON, credentials, commands and per-table byte hashes stay private. */
export function diagnoseRawCapsule2SourcePolicyOwned(db: Database.Database) {
  const { policy } = readRawCapsule2OrdinaryPolicySourceOwned(db)
  return freezeCapsuleValue({ kind: 'capsule2-source-policy-summary' as const, version: 1 as const,
    sourceContentHash: policy.sourceContentHash, observationHash: policy.observationHash,
    tables: policy.tables.map(({ table, family, rows, assetRule, executionRule }) => ({ table, family, rows, assetRule, executionRule })),
    certified: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const,
    replayAllowed: false as const, executionAllowed: false as const, grantAuthority: false as const, permit: false as const })
}
