import assert from 'node:assert/strict'
import test from 'node:test'
import { appSchema } from '../src/main/database/schema.ts'

function has(fragment: string): boolean {
  return appSchema.includes(fragment)
}

test('appSchema includes all core tables', () => {
  assert.equal(has('CREATE TABLE IF NOT EXISTS documents'), true)
  assert.equal(has('CREATE TABLE IF NOT EXISTS blocks'), true)
  assert.equal(has('CREATE TABLE IF NOT EXISTS links'), true)
  assert.equal(has('CREATE TABLE IF NOT EXISTS document_database_columns'), true)
  assert.equal(has('CREATE TABLE IF NOT EXISTS document_database_values'), true)
  assert.equal(has('CREATE TABLE IF NOT EXISTS document_embeddings'), true)
  assert.equal(has('CREATE TABLE IF NOT EXISTS workspace_events'), true)
  assert.equal(has('CREATE TABLE IF NOT EXISTS app_settings'), true)
})

test('appSchema preserves block tree and editor enhancement columns', () => {
  assert.equal(has('parent_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL'), true)
  assert.equal(has('depth INTEGER NOT NULL DEFAULT 0'), true)
  assert.equal(has("tags_json TEXT NOT NULL DEFAULT '[]'"), true)
  assert.equal(has('database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE'), true)
})

test('appSchema includes indices for high-frequency queries', () => {
  assert.equal(has('CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);'), true)
  assert.equal(has('CREATE INDEX IF NOT EXISTS idx_blocks_document_id ON blocks(document_id);'), true)
  assert.equal(has('CREATE INDEX IF NOT EXISTS idx_workspace_events_created_at ON workspace_events(created_at);'), true)
  assert.equal(has('CREATE INDEX IF NOT EXISTS idx_document_embeddings_model ON document_embeddings(model);'), true)
})
