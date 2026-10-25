import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareRootRestoreIdentityPlan3,readRootRestoreIdentityGraphInputs3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreDatabaseReferencePlan3 } from '../src/main/database/restore-knowledge-database3-read'
import { deriveRootRestoreDatabaseReferences3 } from '../src/main/database/restore-knowledge-database3-model'
import { graph3Encode } from '../src/main/database/restore-knowledge-graph3-data'
import { withContent3Fixture } from './helpers/content3-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

test('stored saved-view configs are strict originals and only the exact empty migration sentinel has a legacy fallback',()=>withContent3Fixture(async f=>{
  const identity=await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
  await assert.rejects(prepareRootRestoreDatabaseReferencePlan3(identity.plan),/数据库视图引用或配置无效/)
  const inputs=await readRootRestoreIdentityGraphInputs3(identity.plan),changed=structuredClone(inputs)
  const table=changed.inputs.source.source.sourceContent.tables.find(table=>table.name==='database_saved_views')!
  const index=table.columns.indexOf('config_json')
  for(const row of table.rows)Reflect.set(row.cells,index,graph3Encode('{}',changed.inputs.source.source.sourceContent.encoding))
  const value=deriveRootRestoreDatabaseReferences3(changed)
  assert.equal(value.permit,false)
  assert.deepEqual(value.tables.find(item=>item.name==='database_saved_views')!.rows.map(row=>row.cells[index]),table.rows.map(row=>row.cells[index]))
  assert.deepEqual(allTables(f.source.db),f.beforeSource);assert.deepEqual(allTables(f.receiver.db),f.beforeReceiver)
},undefined,source=>{source.db.prepare('UPDATE database_saved_views SET config_json=? WHERE id=?').run('{"version":1}',source.view.id)}))
