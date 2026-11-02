import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { assertCanonicalSearchSnapshotOwned, canonicalSearchOccurrencesSql, occurrenceFromCanonicalSearchRow,
  validateCanonicalSearchPageOwned, type CanonicalSearchOccurrenceRow } from '../src/main/database/workspace-search-occurrences'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'

test('the canonical occurrence projection is reproducible on a genuine independent readonly SQL copy without persisted host expansion',
  {concurrency:false},()=>withCanonicalSearchFixture(async f=>{
    const file=join(f.root,'canonical-readonly-'+randomUUID()+'.db')
    await f.db.backup(file)
    const db=new Database(restoreSqliteFilename(file),{readonly:true,fileMustExist:true})
    try{db.pragma('query_only=ON');db.pragma('foreign_keys=ON')
      const rows=db.transaction(()=>{
        assertCanonicalSearchSnapshotOwned(db)
        const rows=db.prepare(`SELECT * FROM (${canonicalSearchOccurrencesSql}) WHERE group_id=? ORDER BY document_id,instance_id,block_order`)
          .all(f.searchGroupId) as CanonicalSearchOccurrenceRow[]
        validateCanonicalSearchPageOwned(db,rows)
        return rows.map(occurrenceFromCanonicalSearchRow)
      })()
      assert.equal(rows.length,6)
      const main=f.store.searchWorkspace({query:f.query,scope:'blocks',pageSize:100}).items.flatMap(item=>item.canonicalOccurrence?[item.canonicalOccurrence]:[])
      const sort=(addresses:typeof rows)=>addresses.map(value=>JSON.stringify(value)).sort()
      assert.deepEqual(sort(rows),sort(main))
      assert.equal((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,0)
      assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=?').get(f.childId),undefined)
      assert.equal(db.pragma('user_version',{simple:true}),27)
    }finally{db.close()}
  }))
