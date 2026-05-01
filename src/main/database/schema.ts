export const appSchema = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_document_id ON blocks(document_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent_block_id ON blocks(parent_block_id);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_source_document_id ON links(source_document_id);
CREATE INDEX IF NOT EXISTS idx_links_target_document_id ON links(target_document_id);

CREATE TABLE IF NOT EXISTS document_database_columns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_database_columns_sort_order ON document_database_columns(sort_order);

CREATE TABLE IF NOT EXISTS document_database_values (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES document_database_columns(id) ON DELETE CASCADE,
  value_text TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, column_id)
);

CREATE INDEX IF NOT EXISTS idx_document_database_values_document_id ON document_database_values(document_id);
CREATE INDEX IF NOT EXISTS idx_document_database_values_column_id ON document_database_values(column_id);

CREATE TABLE IF NOT EXISTS document_embeddings (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, model)
);

CREATE INDEX IF NOT EXISTS idx_document_embeddings_model ON document_embeddings(model);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`