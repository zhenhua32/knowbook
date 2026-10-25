import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATABASE_SYSTEM_FIELD_IDS,createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreDatabaseReferencePlan3,readRootRestoreDatabaseReferencePlan3 } from '../src/main/database/restore-knowledge-database3-read'
import { graph3Encode,graph3PatchTable,graph3Rows,graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import type { Capsule2RawSqlTable } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { withContent3Fixture,tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { allTables,createRequest,created,applySyncedHostCommand,freshBlock } from './helpers/synced-backup-v3-fixture'

test('database reference Main owners reject copied handles and caller accessors without evaluating them', async()=>{
  let accesses=0
  const fake=Object.defineProperty({},'kind',{get(){accesses++;throw new Error('caller getter')}})
  await assert.rejects(prepareRootRestoreDatabaseReferencePlan3(fake as never))
  await assert.rejects(readRootRestoreDatabaseReferencePlan3(fake as never))
  await assert.rejects(prepareRootRestoreDatabaseReferencePlan3({kind:'main-root-restore-identity-plan'}))
  await assert.rejects(readRootRestoreDatabaseReferencePlan3({kind:'main-root-restore-database-reference-plan'}))
  assert.equal(accesses,0)
})

test('actual complete originals rewrite database tables and all authored view carriers without activating qualified missing fields', t=>{
  const missing=randomUUID(),missingView=randomUUID(),absentDatabase=randomUUID(),foreign=randomUUID()
  const canonical=randomUUID(),ordinary=randomUUID()
  let catalogView='',templateId='',templateBlock='',templateOpaque=''
  return withContent3Fixture(async f=>{
    const identity=await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const prepared=await prepareRootRestoreDatabaseReferencePlan3(identity.plan),value=prepared.value
    const original=f.sourcePacket.source.sourceContent
    const content={...original,tables:value.tables},rows=(name:string)=>graph3Rows(content,name).map(row=>row.value)
    const target=(kind:string,id:string)=>identity.value.assignments.find(item=>item.kind===kind&&item.sourceId===id&&item.physical)!.targetId
    const field=(db:string,id:string)=>value.references.find(item=>item.kind==='column'&&item.sourceDatabaseId===db&&item.sourceId===id)!
    await t.test('actual foreign reservations force a consistent database and field mapping through value tables',()=>{
      assert.equal(value.tables.length,12)
      assert.notEqual(target('database',f.source.customId),f.source.customId)
      for(const [kind,id] of [['column',f.source.customColumn.id],['column',f.source.catalogColumn.id],['view',f.source.view.id],['view',catalogView],['entity',f.source.entity.id]])
        assert.notEqual(target(kind,id),id)
      const entity=rows('database_entities').find(row=>row.id===target('entity',f.source.entity.id))!
      assert.equal(entity.database_id,target('database',f.source.customId))
      assert.equal(rows('database_entity_values').some(row=>row.entity_id===entity.id&&row.column_id===target('column',f.source.customColumn.id)&&row.value_text==='original custom value'),true)
      assert.equal(rows('document_database_values').some(row=>row.column_id===target('column',f.source.catalogColumn.id)&&row.value_text==='catalog actual value'),true)
    })
    await t.test('the same missing spelling has distinct DB-qualified slots and never follows a current physical occupant',()=>{
      const a=field(f.source.catalogId,missing),b=field(f.source.customId,missing)
      assert.equal(a.state,'missing-reservation');assert.equal(b.state,'missing-reservation')
      assert.notEqual(a.targetId,b.targetId);assert.notEqual(a.targetId,missing);assert.notEqual(b.targetId,missing)
      assert.equal(f.currentPacket.source.sourceContent.tables.find(table=>table.name==='document_database_columns')!.rows.some(row=>
        graph3Text(row.cells[0],original.encoding)===missing),true)
      const wrongOwner=field(f.source.customId,f.source.catalogColumn.id)
      assert.equal(wrongOwner.state,'missing-reservation')
      assert.notEqual(wrongOwner.targetId,target('column',f.source.catalogColumn.id))
      assert.equal(field(f.source.catalogId,f.source.catalogColumn.id).targetId,target('column',f.source.catalogColumn.id))
    })
    await t.test('saved views rewrite only typed field positions and preserve system fields query rule IDs and values',()=>{
      const view=rows('database_saved_views').find(row=>row.id===target('view',f.source.view.id))!
      const config=JSON.parse(String(view.config_json))
      assert.equal(view.database_id,target('database',f.source.customId))
      assert.equal(config.query,'literal '+f.source.catalogColumn.id+' file:///opaque')
      assert.equal(config.filters.rules[0].id,f.source.catalogColumn.id)
      assert.equal(config.filters.rules[0].value,missing)
      assert.equal(config.filters.rules[0].fieldId,field(f.source.customId,f.source.catalogColumn.id).targetId)
      assert.deepEqual(config.visibleFieldIds,[DATABASE_SYSTEM_FIELD_IDS.title,target('column',f.source.customColumn.id),field(f.source.customId,missing).targetId])
      assert.equal(config.columnWidths[field(f.source.customId,missing).targetId],240)
      assert.equal(config.groupBy.fieldId,field(f.source.customId,missing).targetId)
      assert.equal(config.sorts[0].fieldId,DATABASE_SYSTEM_FIELD_IDS.updatedAt)
      assert.equal(config.cardFieldIds[0],field(f.source.customId,missing).targetId)
    })
    await t.test('ordinary canonical and template atoms share qualified mappings while unrelated template bytes remain data',()=>{
      const ordinaryRow=rows('blocks').find(row=>row.id===ordinary)!,canonicalRow=rows('synced_group_blocks').find(row=>row.id===canonical)!
      for(const row of [ordinaryRow,canonicalRow]){
        const payload=parseDatabaseViewPayload(String(row.content))
        assert.equal(payload.databaseId,target('database',f.source.customId))
        assert.equal(payload.viewId,target('view',f.source.view.id))
        assert.equal(payload.config.filters.rules[0]&&'fieldId' in payload.config.filters.rules[0] ? payload.config.filters.rules[0].fieldId:null,
          field(f.source.customId,f.source.catalogColumn.id).targetId)
      }
      const template=rows('document_templates').find(row=>row.id===templateId)!,blocks=JSON.parse(String(template.blocks_json))
      assert.equal(blocks.find((block:{id:string})=>block.id===templateOpaque).content,'opaque '+missing+' '+f.source.catalogColumn.id)
      const atom=parseDatabaseViewPayload(blocks.find((block:{id:string})=>block.id===templateBlock).content)
      assert.equal(atom.databaseId,value.references.find(item=>item.kind==='database'&&item.sourceId===absentDatabase)!.targetId)
      assert.notEqual(atom.databaseId,absentDatabase)
      assert.equal(value.references.find(item=>item.kind==='view'&&item.sourceDatabaseId===absentDatabase&&item.sourceId===missingView)!.state,'missing-reservation')
      assert.equal(template.summary,'opaque '+missing)
    })
    await t.test('all undeclared cells retain original classes bytes row order and full original table coverage',()=>{
      for(const table of value.tables){
        const before=original.tables.find(item=>item.name===table.name)!
        assert.deepEqual(table.columns,before.columns);assert.deepEqual(table.primaryKey,before.primaryKey)
        assert.equal(table.rows.length,before.rows.length)
        table.rows.forEach((row,index)=>{
          assert.equal(row.sourceRowId,before.rows[index].sourceRowId)
          const columns=value.changedCells.find(item=>item.table===table.name&&item.sourceRowId===row.sourceRowId)?.columns??[]
          table.columns.forEach((column,position)=>{if(!columns.includes(column))assert.deepEqual(row.cells[position],before.rows[index].cells[position])})
        })
      }
      assert.equal(value.tables.some(table=>table.role!=='content'),false)
      assert.equal(rows('blocks').some(row=>row.content===f.raw),true)
      assert.equal(rows('documents').some(row=>row.title==='源'.repeat(501)),true)
      for(const key of ['referenceRewriteComplete','semanticValidationComplete','acceptedCoverage','effective','permit'] as const)assert.equal(value[key],false)
      assert.equal(value.structuralMergeStillRequired,true)
      assert.equal(value.sourceHistoryReplayed,false);assert.equal(value.sourcePolicyReplayed,false)
    })
    await t.test('hot reads rebuild actual originals and reject changed durable kernels or verification SQL',async()=>{
      assert.deepEqual(await readRootRestoreDatabaseReferencePlan3(prepared.plan),value)
      assert.equal(Object.isFrozen(value),true);assert.equal(Object.isFrozen(value.tables[0].rows),true)
      await assert.rejects(readRootRestoreDatabaseReferencePlan3({...prepared.plan}))
      const file=join(identity.directory,'manifest.json'),bytes=await readFile(file)
      await writeFile(file,Buffer.from('{}\n'))
      await assert.rejects(readRootRestoreDatabaseReferencePlan3(prepared.plan))
      await writeFile(file,bytes)
      assert.deepEqual(await readRootRestoreDatabaseReferencePlan3(prepared.plan),value)
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readRootRestoreDatabaseReferencePlan3(prepared.plan))
    })
    assert.deepEqual(allTables(f.source.db),f.beforeSource);assert.deepEqual(allTables(f.receiver.db),f.beforeReceiver)
  },source=>{
    source.db.prepare('INSERT INTO document_database_columns SELECT ?,database_id,?,type,options_json,sort_order,created_at,updated_at FROM document_database_columns WHERE id=?')
      .run(missing,'Current same-spelling occupant',source.catalogColumn.id)
    const save=source.db.prepare('INSERT INTO backup_restore_identities(lineage,kind,source_database_id,source_id,state,target_id) VALUES(?,?,?,?,?,?)')
    for(const [kind,id] of [['database',source.customId],['column',source.customColumn.id],['column',source.catalogColumn.id],['view',source.view.id],['view',catalogView],['entity',source.entity.id]])
      save.run(foreign,kind,'',randomUUID(),'live',id)
  },undefined,source=>{
    const config=createDefaultDatabaseViewConfig('table',[DATABASE_SYSTEM_FIELD_IDS.title,source.customColumn.id,missing])
    config.query='literal '+source.catalogColumn.id+' file:///opaque'
    config.filters={operator:'and',rules:[{id:source.catalogColumn.id,fieldId:source.catalogColumn.id,operator:'equals',value:missing}]}
    config.groupBy={fieldId:missing};config.columnWidths={[missing]:240};config.cardFieldIds=[missing]
    source.db.prepare('UPDATE database_saved_views SET config_json=? WHERE id=?').run(JSON.stringify(config,null,2),source.view.id)
    const catalogConfig=createDefaultDatabaseViewConfig('cards',[source.catalogColumn.id,missing,source.customColumn.id])
    const view=source.store.createDatabaseSavedView({databaseId:source.catalogId,name:'Qualified catalog view',config:catalogConfig})
    catalogView=view.id
    source.db.prepare('UPDATE database_saved_views SET config_json=? WHERE id=?').run(JSON.stringify(catalogConfig,null,2),view.id)
    const payload=JSON.stringify({version:1,databaseId:source.customId,viewId:source.view.id,config},null,2)
    const viewHost=source.store.createDocument(null)
    source.store.updateDocument(viewHost,{title:'View source host',summary:'',blocks:[]})
    const result=applySyncedHostCommand(source.db,createRequest(source.db,{documentId:viewHost,selectedRootIds:[canonical],dirty(working){
      working.blocks.push({...freshBlock(ordinary,payload),type:'database-view'},{...freshBlock(canonical,payload),type:'database-view'})
    }}))
    assert.equal(result.status,'applied',JSON.stringify(result));created(result)
    const template=source.store.saveDocumentTemplate({name:'Actual typed reference template',title:'Template',summary:'opaque '+missing,blocks:[
      {type:'paragraph',content:'opaque '+missing+' '+source.catalogColumn.id,checked:false,depth:0,parentBlockId:null},
      {type:'database-view',content:JSON.stringify({version:1,databaseId:absentDatabase,viewId:missingView,config}),checked:false,depth:0,parentBlockId:null}
    ]})
    templateId=template.id;templateOpaque=template.blocks[0].id!;templateBlock=template.blocks[1].id!
  })
})

test('database reference field patches preserve int64 REAL BLOB NULL rowid and untouched UTF16 cells exactly',()=>{
  for(const encoding of ['UTF-8','UTF-16le','UTF-16be'] as const){
    const table:Capsule2RawSqlTable={name:'database_entity_values',role:'content',columns:['entity_id','column_id','value_text','updated_at'],primaryKey:['entity_id','column_id'],rows:[
      {sourceRowId:'-9223372036854775808',cells:[graph3Encode('old',encoding),['integer','9223372036854775807'],['real-ieee754-le','0000000000000080'],['blob','AP8=']]},
      {sourceRowId:'9223372036854775807',cells:[graph3Encode('old',encoding),['null'],graph3Encode('中文\0unchanged',encoding),graph3Encode('clock',encoding)]}
    ]}
    const mapped=graph3PatchTable(table,encoding,()=>({entity_id:'new 中文'}))
    assert.equal(graph3Text(mapped.rows[0].cells[0],encoding),'new 中文')
    assert.deepEqual(mapped.rows.map(row=>row.sourceRowId),table.rows.map(row=>row.sourceRowId))
    assert.deepEqual(mapped.rows.map(row=>row.cells.slice(1)),table.rows.map(row=>row.cells.slice(1)))
    assert.equal(capsuleJson(table.rows[1].cells[2]),capsuleJson(mapped.rows[1].cells[2]))
  }
})
