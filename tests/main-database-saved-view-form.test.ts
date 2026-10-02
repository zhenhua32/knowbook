import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { DatabaseSavedViewNameError, runDatabaseSavedViewForm } from '../src/main/database/saved-view-form.ts'
import type { DatabaseSavedViewFormResult } from '../src/shared/contracts.ts'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const takenMessage = 'A saved view with this name already exists in this database.'
const requiredMessage = 'Saved view name is required.'

function withStore(run: (store: KnowbookStore, databasePath: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-saved-view-form-'))
  const databasePath = join(directory, 'knowbook.sqlite')
  const store = new KnowbookStore(databasePath)
  try { run(store, databasePath) }
  finally { store.destroy(); rmSync(directory, { recursive: true, force: true }) }
}

function saved(result: DatabaseSavedViewFormResult) {
  assert.equal(result.status, 'saved')
  if (result.status !== 'saved') throw new Error('Expected a saved view')
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  return result.view
}

test('form creation returns a plain saved result, preserves normal view data, and restricts name conflicts to its database', () => {
  withStore(store => {
    const firstDatabase = store.createDatabase({ name: 'Projects' })
    const otherDatabase = store.createDatabase({ name: 'Projects' })
    const created = saved(runDatabaseSavedViewForm(() => store.createDatabaseSavedView({
      databaseId: firstDatabase.id, name: '  Beta table  ', filterQuery: 'beta', filterScope: '__document__',
      sortMode: 'created-asc', viewMode: 'table'
    })))
    assert.equal(created.name, 'Beta table')
    assert.equal(created.databaseId, firstDatabase.id)
    assert.equal(created.filterQuery, 'beta')
    assert.equal(created.filterScope, '__document__')
    assert.equal(created.sortMode, 'created-asc')
    assert.equal(created.config.layout, 'table')
    assert.deepEqual(store.getDatabaseSavedViews(firstDatabase.id), [created])

    const before = store.getDatabaseSavedViews(firstDatabase.id)
    const result = runDatabaseSavedViewForm(() => store.createDatabaseSavedView({
      databaseId: firstDatabase.id, name: ' bETA TABLE ', filterQuery: 'must not be persisted', viewMode: 'board'
    }))
    assert.deepEqual(result, { status: 'invalid-name', reason: 'name-taken', message: takenMessage })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'Known failures remain plain serializable data')
    assert.deepEqual(store.getDatabaseSavedViews(firstDatabase.id), before)
    const other = saved(runDatabaseSavedViewForm(() => store.createDatabaseSavedView({ databaseId: otherDatabase.id, name: 'beta table' })))
    assert.equal(other.databaseId, otherDatabase.id)
    assert.equal(store.getDatabaseSavedViews(otherDatabase.id).length, 1)
    assert.deepEqual(store.getDatabaseSavedViews(firstDatabase.id), before)
  })
})

test('rename excludes its own identity and a rejected name cannot mutate any view metadata or configuration', () => {
  withStore(store => {
    const database = store.createDatabase({ name: 'Projects' })
    const first = store.createDatabaseSavedView({ databaseId: database.id, name: 'Original', filterQuery: 'kept', viewMode: 'table' })
    const second = store.createDatabaseSavedView({ databaseId: database.id, name: 'Other', viewMode: 'cards' })
    const ownRename = saved(runDatabaseSavedViewForm(() => store.updateDatabaseSavedView({ viewId: first.id, name: ' ORIGINAL ' })))
    assert.equal(ownRename.id, first.id)
    assert.equal(ownRename.name, 'ORIGINAL')
    assert.deepEqual(ownRename.config, first.config)
    const before = store.getDatabaseSavedViews(database.id)
    const conflict = runDatabaseSavedViewForm(() => store.updateDatabaseSavedView({
      viewId: first.id, name: ' other ', filterQuery: 'unwanted', filterScope: 'unwanted', viewMode: 'board', sortOrder: 99
    }))
    assert.deepEqual(conflict, { status: 'invalid-name', reason: 'name-taken', message: takenMessage })
    assert.deepEqual(store.getDatabaseSavedViews(database.id), before)
    const corrected = saved(runDatabaseSavedViewForm(() => store.updateDatabaseSavedView({ viewId: first.id, name: 'Corrected' })))
    assert.equal(corrected.name, 'Corrected')
    assert.deepEqual(corrected.config, first.config)
    assert.deepEqual(store.getDatabaseSavedViews(database.id).find(view => view.id === second.id), second)
  })
})

test('required-name results preserve the database and failed rename draft baseline without changing legacy error messages', () => {
  withStore(store => {
    const database = store.createDatabase({ name: 'Projects' })
    const existing = store.createDatabaseSavedView({ databaseId: database.id, name: 'Original' })
    const before = store.getDatabaseSavedViews(database.id)
    for (const name of ['', ' \t\n ']) {
      assert.deepEqual(runDatabaseSavedViewForm(() => store.createDatabaseSavedView({ databaseId: database.id, name })),
        { status: 'invalid-name', reason: 'name-required', message: requiredMessage })
      assert.deepEqual(runDatabaseSavedViewForm(() => store.updateDatabaseSavedView({ viewId: existing.id, name })),
        { status: 'invalid-name', reason: 'name-required', message: requiredMessage })
      assert.deepEqual(store.getDatabaseSavedViews(database.id), before)
    }
    const checkError = (error: unknown) => error instanceof DatabaseSavedViewNameError && error.message === requiredMessage
    assert.throws(() => store.createDatabaseSavedView({ databaseId: database.id, name: ' ' }), checkError)
    assert.throws(() => store.updateDatabaseSavedView({ viewId: existing.id, name: '' }), checkError)
    assert.deepEqual(store.getDatabaseSavedViews(database.id), before)
  })
})

test('name comparison follows real SQLite NOCASE without conflating distinct Unicode names', () => {
  withStore(store => {
    const database = store.createDatabase({ name: 'Names' })
    for (const name of ['Équipe', 'équipe', 'İ', 'i']) {
      assert.equal(saved(runDatabaseSavedViewForm(() => store.createDatabaseSavedView({ databaseId: database.id, name }))).name, name)
    }
    assert.deepEqual(runDatabaseSavedViewForm(() => store.createDatabaseSavedView({ databaseId: database.id, name: 'I' })),
      { status: 'invalid-name', reason: 'name-taken', message: takenMessage })
    const chinese = saved(runDatabaseSavedViewForm(() => store.createDatabaseSavedView({ databaseId: database.id, name: '计划' })))
    assert.deepEqual(runDatabaseSavedViewForm(() => store.createDatabaseSavedView({ databaseId: database.id, name: ' 计划 ' })),
      { status: 'invalid-name', reason: 'name-taken', message: takenMessage })
    assert.deepEqual(store.getDatabaseSavedViews(database.id).map(view => view.name), ['Équipe', 'équipe', 'İ', 'i', chinese.name])
  })
})

test('legacy create and update still return views and throw ordinary errors for duplicate names', () => {
  withStore(store => {
    const database = store.createDatabase({ name: 'Legacy' })
    const first = store.createDatabaseSavedView({ databaseId: database.id, name: 'First' })
    const second = store.createDatabaseSavedView({ databaseId: database.id, name: 'Second' })
    assert.equal('status' in first, false)
    assert.equal('status' in store.updateDatabaseSavedView({ viewId: second.id, filterQuery: 'legacy' }), false)
    assert.throws(() => store.createDatabaseSavedView({ databaseId: database.id, name: 'FIRST' }), error => error instanceof Error && error.message === takenMessage)
    assert.throws(() => store.updateDatabaseSavedView({ viewId: second.id, name: first.name }), error => error instanceof Error && error.message === takenMessage)
  })
})

test('unknown failures propagate unchanged, including an actual SQLite write failure with the same duplicate-name wording', () => {
  withStore((store, databasePath) => {
    const database = store.createDatabase({ name: 'Failure' })
    const existing = store.createDatabaseSavedView({ databaseId: database.id, name: 'Kept' })
    const before = store.getDatabaseSavedViews(database.id)
    const connection = new Database(databasePath)
    try {
      connection.exec(`
        CREATE TRIGGER saved_view_form_insert_failure BEFORE INSERT ON database_saved_views
        BEGIN SELECT RAISE(ABORT, 'A saved view with this name already exists in this database.'); END;
        CREATE TRIGGER saved_view_form_update_failure BEFORE UPDATE ON database_saved_views
        BEGIN SELECT RAISE(ABORT, 'Saved view name is required.'); END;
      `)
      for (const save of [
        () => store.createDatabaseSavedView({ databaseId: database.id, name: 'Available' }),
        () => store.updateDatabaseSavedView({ viewId: existing.id, name: 'Available' })
      ]) {
        assert.throws(() => runDatabaseSavedViewForm(save), error => error instanceof Error && !(error instanceof DatabaseSavedViewNameError))
        assert.deepEqual(store.getDatabaseSavedViews(database.id), before)
      }
    } finally { connection.close() }
    const unknown = new Error(takenMessage)
    assert.throws(() => runDatabaseSavedViewForm(() => { throw unknown }), error => error === unknown)
    assert.throws(() => runDatabaseSavedViewForm(() => store.createDatabaseSavedView({ databaseId: 'missing', name: 'New' })), /Database not found/)
    assert.throws(() => runDatabaseSavedViewForm(() => store.updateDatabaseSavedView({ viewId: 'missing', name: 'New' })), /Saved view not found/)
    assert.deepEqual(store.getDatabaseSavedViews(database.id), before)
  })
})
