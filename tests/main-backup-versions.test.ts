import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { listBackupVersions, publishBackupSnapshot, resolveBackupVersion, retainedBackupIds } from '../src/main/backup/versions'
import type { BackupVersion } from '../src/shared/document-recovery'

test('successive backups keep independently readable previous snapshots across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-backup-versions-')), backupRoot = join(root, 'markdown')
  const store = new KnowbookStore(join(root, 'store.db'))
  try {
    const id = store.createDocument(null)
    const original = store.getDocumentDetail(id)!
    store.updateDocument(id, { ...original, title: 'Versioned', summary: 'Before' })
    const service = new MarkdownBackupService(store, backupRoot)
    await service.exportAll()
    await service.exportAll()
    assert.equal(service.listVersions().length, 1, 'unchanged scheduled backups should not churn versions')
    const selectedVersionId = service.listVersions()[0].id
    store.updateDocument(id, { ...store.getDocumentDetail(id)!, summary: 'After' })
    await service.exportAll(true)
    const restarted = new MarkdownBackupService(store, backupRoot)
    const versions = restarted.listVersions()
    assert.equal(versions.length, 2)
    assert.match(readFileSync(join(restarted.resolveVersion(selectedVersionId), 'Versioned.md'), 'utf8'), /Before/,
      'a selected snapshot must keep its identity when background rotation archives it')
    assert.match(readFileSync(join(restarted.resolveVersion(versions.find((v) => !v.current)!.id), 'Versioned.md'), 'utf8'), /Before/)
    assert.match(readFileSync(join(backupRoot, 'Versioned.md'), 'utf8'), /After/)
    const archiveRoot = restarted.resolveVersion(versions.find((v) => !v.current)!.id)
    await new MarkdownRestoreService(store).restoreFromDirectory(archiveRoot)
    assert.equal(store.getDocumentDetail(id)!.summary, 'Before')
    const undoVersion = store.documentRecovery.listHistory(id)[0]
    assert.equal(undoVersion.reason, 'restore')
    assert.equal(store.documentRecovery.getHistory(id, undoVersion.id).content.summary, 'After')
    assert.throws(() => restarted.resolveVersion('../store.db'), /Invalid/)
    assert.throws(() => restarted.resolveVersion('00000000-0000-0000-0000-000000000000'), /no longer/)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('a manual backup queued behind an older snapshot includes newer edits', async () => {
  let release: () => void = () => {}, revision = 'before'
  const gate = new Promise<void>((resolve) => { release = resolve })
  const observed: string[] = []
  const store = { getBackupRevision: () => revision, getExportDocuments: () => [], getExportStandaloneDatabases: () => [], saveSetting: () => {} }
  const service = new MarkdownBackupService(store as never, 'unused', undefined, async () => {
    observed.push(revision)
    if (observed.length === 1) await gate
  })
  const first = service.exportAll()
  revision = 'after'
  const manual = service.exportAll(true)
  release()
  await Promise.all([first, manual, service.waitForIdle()])
  assert.deepEqual(observed, ['before', 'after'])
})

test('retention keeps recent edits and daily recovery points without deleting all of yesterday’s backups', () => {
  const now = Date.parse('2026-09-27T12:00:00Z'), versions: BackupVersion[] = []
  for (let day = 0; day < 35; day++) for (let minute = 0; minute < 20; minute++) {
    versions.push({ id: `${day}-${minute}`, current: day === 0 && minute === 0, documentCount: 1,
      createdAt: new Date(now - day * 86400_000 - minute * 60_000).toISOString() })
  }
  const retained = retainedBackupIds(versions, now)
  for (let index = 0; index < 10; index++) assert.equal(retained.has(`0-${index}`), true)
  assert.equal(retained.has('1-0'), true)
  assert.equal(retained.has('29-0'), true)
  assert.equal(retained.has('34-0'), false)
  assert.equal(retained.has('1-1'), false)
})

test('publication failure restores the latest snapshot, and legacy snapshots remain discoverable', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-backup-publish-')), backupRoot = join(root, 'markdown')
  try {
    mkdirSync(backupRoot); writeFileSync(join(backupRoot, 'note.md'), 'Original')
    assert.throws(() => publishBackupSnapshot(backupRoot, join(root, 'missing-staging')), /ENOENT/)
    assert.equal(readFileSync(join(backupRoot, 'note.md'), 'utf8'), 'Original')
    const staging = join(root, 'next'); mkdirSync(staging); writeFileSync(join(staging, 'note.md'), 'Next')
    publishBackupSnapshot(backupRoot, staging)
    const archived = listBackupVersions(backupRoot).find((v) => !v.current)!
    assert.equal(archived.documentCount, null)
    assert.equal(existsSync(join(resolveBackupVersion(backupRoot, archived.id), 'note.md')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
