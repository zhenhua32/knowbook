import type Database from 'better-sqlite3'
import { capsuleJson } from './restore-knowledge-capsule-model'
import type { Capsule2Encoding, Capsule2RawSqlRow, Capsule2RawStreamTable } from './restore-knowledge-capsule2-raw-model'
import { graph3Encode } from './restore-knowledge-graph3-data'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { assertV3SourceGroupRetirementPhysicalOwned, v3SourceGroupRetirementKey, writeV3SourceGroupRetirementsOwned,
  type V3SourceGroupRetirement } from './v3-source-group-retirement'

const equal = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const fail = (reason: string): never => { throw new Error('V3 同步组裁剪候选已变化：' + reason) }

export function assertV3RetirementBeforeSql(db: Database.Database, { group }: V3SourceGroupRetirement) {
  const actual = readRawSyncedGroupSnapshotsOwned(db, [group.id]).get(group.id)
  if (!actual || actual.history.undoToken || actual.history.redoToken || actual.instances.length
    || actual.bindings.length || !group.blocks.length || group.bindings.length
    || !equal(group, { kind: 'synced-group', id: actual.groupId, creationId: actual.creationId, createdAt: actual.createdAt,
      origin: actual.origin, blocks: actual.blocks, bindings: actual.bindings })) fail('原组正文、来源或引用')
  if (db.prepare('SELECT 1 FROM synced_group_pins WHERE group_id=? LIMIT 1').get(group.id)
    || db.prepare('SELECT 1 FROM synced_group_history WHERE group_id=? LIMIT 1').get(group.id))
    fail('原组仍有历史或固定引用')
}

export function applyV3RetirementSql(db: Database.Database, retirements: readonly V3SourceGroupRetirement[]) {
  for (const retirement of retirements) assertV3RetirementBeforeSql(db, retirement)
  const remove = db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?')
  for (const { group } of retirements) {
    if (remove.run(group.id).changes !== group.blocks.length) return fail('原组正文缺行')
  }
  writeV3SourceGroupRetirementsOwned(db, retirements)
}

/** Produce C's protected projection. B/R still hashes the full native rows. */
export function normalizeV3RetirementSqlTable(table: Capsule2RawStreamTable, encoding: Capsule2Encoding,
  retirements: readonly V3SourceGroupRetirement[], installed: boolean) {
  if (table.name !== 'synced_group_blocks' && table.name !== 'block_identities') return
  const ids = new Set(retirements.flatMap(({ group }) => group.blocks.map(block => capsuleJson(graph3Encode(block.id, encoding)))))
  const idIndex = table.columns.indexOf('id'), stateIndex = table.columns.indexOf('state')
  if (idIndex < 0 || table.name === 'block_identities' && stateIndex < 0) return fail('原稳定身份列缺失')
  const expected = graph3Encode(installed ? 'retained' : 'live', encoding)
  const retained = graph3Encode('retained', encoding)
  return (row: Capsule2RawSqlRow): Capsule2RawSqlRow | null => {
    if (!ids.has(capsuleJson(row.cells[idIndex]))) return row
    if (table.name === 'synced_group_blocks') {
      if (installed) return fail('写后仍有实际正文')
      return null
    }
    if (!equal(row.cells[stateIndex], expected)) return fail('稳定身份状态与实际安装阶段不符')
    if (installed) return row
    const cells = [...row.cells]
    cells[stateIndex] = retained
    return { ...row, cells }
  }
}

export { assertV3SourceGroupRetirementPhysicalOwned, v3SourceGroupRetirementKey }
