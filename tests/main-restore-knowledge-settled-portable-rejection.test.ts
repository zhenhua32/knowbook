import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AttachmentStore } from '../src/main/attachments'
import { publicationJson } from '../src/main/sync/synced-publication-model'
import { readCapsule2SettledPortableSource3, prepareCapsule2SettledPortableSource3, assertCapsule2SettledPortableSourceOwner3 } from '../src/main/database/restore-knowledge-assets3-settled-portable-owner'
import { assertRestorePath } from '../src/main/database/restore-safety-files'
import { prepareCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { withSettledPortable3, object, array } from './helpers/settled-portable-owner-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'

test('genuine settled owner rejects wrong whole-record source facts forged identities and changed original job receipt or phase bytes without deleting legitimate history',
  t => withSettledPortable3(async saved => {
    const before = await saved.capture(), baseJob = before.value.jobs.find(value => value.jobSettingKey === saved.documentJob.row.key); assert.ok(baseJob)
    const currentSource = array(object(baseJob.binding).sources).map(object).find(value => value.recordKey === 'doc:' + saved.documentId)!
    assert.deepEqual(currentSource.source, ['documents', saved.documentId, 'complete-original-protocol-record'])
    const another = await saved.capture()
    assert.throws(() => assertCapsule2SettledPortableSourceOwner3(before.owner, another.sealed.source))
    await assert.rejects(Reflect.apply(readCapsule2SettledPortableSource3, undefined, [structuredClone(before.owner)]))
    await assert.rejects(Reflect.apply(prepareCapsule2SettledPortableSource3, undefined, [structuredClone(before.sealed.info)]))
    let getterTouches = 0
    const forged = Object.defineProperty({}, 'kind', { get() { getterTouches++; throw new Error('Caller getter must not be touched') } })
    await assert.rejects(Reflect.apply(readCapsule2SettledPortableSource3, undefined, [forged])); assert.equal(getterTouches, 0)
    const legacyOriginal = await captureAssetOriginal({ userDataRoot: saved.f.B.root, db: saved.f.B.db })
    const legacy = await captureSealedCapsule2SourceFromArchive(await prepareCapsule2AssetArchive(legacyOriginal.original))
    await assert.rejects(prepareCapsule2SettledPortableSource3(legacy.source), /archive1/)
    const blob = join(before.original.info.recoveryDirectory, 'knowledge-complete-assets-v2', before.sealed.value.capsuleId, 'files', saved.digest)
    await assertRestorePath(blob, before.original.info.profileRoot); await assertRestorePath(blob + '.missing-proof', before.original.info.profileRoot)
    await rename(blob, blob + '.missing-proof')
    try { await assert.rejects(readCapsule2SettledPortableSource3(before.owner)) } finally { await rename(blob + '.missing-proof', blob) }
    const foreignStore = new AttachmentStore(join(saved.f.folder, 'foreign-actual-profile', 'storage', 'assets'))
    const [foreign] = await foreignStore.import([{ name: saved.logicalName, bytes: saved.bytes }])
    assert.deepEqual(await readFile(new URL(foreign.url)), saved.bytes)
    const row = saved.f.B.db.prepare('SELECT id,content FROM blocks WHERE document_id=? AND content LIKE ?').get(saved.documentId, '%complete settled W%') as { id: string; content: string }
    assert.ok(row); const ownUri = pathToFileURL(saved.logicalPath).href; assert.ok(row.content.includes(ownUri))
    const flip = (hash: string) => (hash[0] === '0' ? '1' : '0') + hash.slice(1)
    const actualDoc = saved.f.B.db.prepare('SELECT title,created_at,sort_order,parent_id FROM documents WHERE id=?').get(saved.documentId) as { title: string; created_at: string; sort_order: number; parent_id: string | null }
    const mutations = [
      { name: 'whole-title', run: () => saved.f.B.db.prepare('UPDATE documents SET title=? WHERE id=?').run(actualDoc.title + ' changed whole record', saved.documentId), restore: () => saved.f.B.db.prepare('UPDATE documents SET title=? WHERE id=?').run(actualDoc.title, saved.documentId) },
      { name: 'birth', run: () => saved.f.B.db.prepare('UPDATE documents SET created_at=? WHERE id=?').run('2058-01-02T03:04:05.006Z', saved.documentId), restore: () => saved.f.B.db.prepare('UPDATE documents SET created_at=? WHERE id=?').run(actualDoc.created_at, saved.documentId) },
      { name: 'sort', run: () => saved.f.B.db.prepare('UPDATE documents SET sort_order=? WHERE id=?').run(actualDoc.sort_order + 7, saved.documentId), restore: () => saved.f.B.db.prepare('UPDATE documents SET sort_order=? WHERE id=?').run(actualDoc.sort_order, saved.documentId) },
      { name: 'parent', run: () => saved.f.B.db.prepare('UPDATE documents SET parent_id=? WHERE id=?').run(saved.f.target, saved.documentId), restore: () => saved.f.B.db.prepare('UPDATE documents SET parent_id=? WHERE id=?').run(actualDoc.parent_id, saved.documentId) },
      { name: 'foreign-same-hash-name', run: () => saved.f.B.db.prepare('UPDATE blocks SET content=? WHERE id=?').run(row.content.replaceAll(ownUri, foreign.url), row.id), restore: () => saved.f.B.db.prepare('UPDATE blocks SET content=? WHERE id=?').run(row.content, row.id) },
      { name: 'job-hash', run: () => saved.f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(saved.documentJob.row.value.replace(saved.documentJob.job.descriptor.next.manifestHash, flip(saved.documentJob.job.descriptor.next.manifestHash)), saved.documentJob.row.key), restore: () => saved.f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(saved.documentJob.row.value, saved.documentJob.row.key) },
      { name: 'receipt-hash', run: () => saved.f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(saved.documentJob.receiptRow.result_json.replace(saved.documentJob.receipt.provenance.afterManifestHash, flip(saved.documentJob.receipt.provenance.afterManifestHash)), saved.documentJob.job.request.operationId), restore: () => saved.f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(saved.documentJob.receiptRow.result_json, saved.documentJob.job.request.operationId) },
      { name: 'phase-hash', run: () => { const phase = saved.documentJob.phases.at(-1)!; return saved.f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(phase.row.value.replace(phase.fact.jobHash, flip(phase.fact.jobHash)), phase.row.key) }, restore: () => { const phase = saved.documentJob.phases.at(-1)!; return saved.f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(phase.row.value, phase.row.key) } }
    ]
    const outcomes: Array<{ name: string; rejectedBy: string }> = []
    for (const mutation of mutations) {
      try {
        mutation.run()
        let result: Awaited<ReturnType<typeof saved.capture>>
        try { result = await saved.capture() } catch (error) {
          // A stricter genuine source reader may reject corrupt original facts
          // before an owner can be minted. Assertion/fixture failures must fail.
          if ((error as { code?: string }).code === 'ERR_ASSERTION') throw error
          assert.match(String(error), /capsule|settled|原|恢复|历史|knowledge|exchange|invalid|无效|JSON/i)
          outcomes.push({ name: mutation.name, rejectedBy: 'genuine-source-or-owner-read' })
          continue
        }
        assert.equal(result.value.jobs.some(value => value.jobSettingKey === saved.documentJob.row.key), false, mutation.name)
        assert.ok(result.value.notProven.some(value => value.jobSettingKey === saved.documentJob.row.key), mutation.name)
        outcomes.push({ name: mutation.name, rejectedBy: 'settled-owner-not-proven' })
      } finally { mutation.restore() }
    }
    const restored = await saved.capture()
    assert.ok(restored.value.jobs.some(value => value.jobSettingKey === saved.documentJob.row.key))
    assert.deepEqual(await readCapsule2SettledPortableSource3(before.owner), before.value)
    const groupJob = saved.jobs.find(value => value.job.merges?.some(merge => merge.key === 'group:' + saved.groupId))!
    assert.ok(groupJob)
    const groupRow = saved.f.B.db.prepare('SELECT origin_json,bindings_json FROM synced_groups WHERE id=?').get(saved.groupId) as { origin_json: string; bindings_json: string }
    const origin = object(JSON.parse(groupRow.origin_json)); origin.pathAtCreation = String(origin.pathAtCreation) + ' changed opaque Origin'
    const bindings = array(JSON.parse(groupRow.bindings_json)).map(object); assert.ok(bindings.length)
    bindings[0].from = Number(bindings[0].from) + 1
    assert.throws(() => saved.f.B.db.prepare('UPDATE synced_groups SET origin_json=? WHERE id=?').run(JSON.stringify(origin), saved.groupId),
      /Lifecycle incarnation and origin are immutable/)
    outcomes.push({ name: 'origin_json', rejectedBy: 'native-immutable-Origin-guard' })
    for (const [column, replacement, old] of [['bindings_json', JSON.stringify(bindings), groupRow.bindings_json]] as const) {
      try {
        saved.f.B.db.prepare('UPDATE synced_groups SET ' + column + '=? WHERE id=?').run(replacement, saved.groupId)
        let result: Awaited<ReturnType<typeof saved.capture>>
        try { result = await saved.capture() } catch (error) {
          if ((error as { code?: string }).code === 'ERR_ASSERTION') throw error
          assert.match(String(error), /capsule|settled|原|恢复|历史|knowledge|exchange|invalid|无效|JSON/i)
          outcomes.push({ name: column, rejectedBy: 'genuine-source-or-owner-read' }); continue
        }
        const actual = result.value.jobs.find(value => value.jobSettingKey === groupJob.row.key)
        if (actual) {
          const record = actual.merged.find(value => value.recordKey === 'group:' + saved.groupId)!; assert.ok(record)
          assert.equal(publicationJson(record.record), publicationJson(saved.oracleRecords.get(record.recordKey)))
          const source = array(object(actual.binding).sources).map(object).find(value => value.recordKey === record.recordKey)!
          assert.notDeepEqual(source.source, ['synced_groups', saved.groupId, 'complete-original-protocol-record'],
            'A legitimate complete old GroupWire is retained; the changed current Origin/binding must not be selected')
          outcomes.push({ name: column, rejectedBy: 'changed-current-rejected-exact-historical-W-retained' })
        } else outcomes.push({ name: column, rejectedBy: 'settled-owner-not-proven' })
      } finally { saved.f.B.db.prepare('UPDATE synced_groups SET ' + column + '=? WHERE id=?').run(old, saved.groupId) }
    }
    t.diagnostic(JSON.stringify(outcomes))
  }, { group: true }))
