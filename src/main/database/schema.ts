export const appSchema = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,
  link_count INTEGER NOT NULL DEFAULT 0,
  child_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  highlight TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_document_id ON blocks(document_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent_block_id ON blocks(parent_block_id);

CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
  document_id UNINDEXED,
  title,
  path,
  summary,
  tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS block_search USING fts5(
  block_id UNINDEXED,
  document_id UNINDEXED,
  content,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_document_search_insert
AFTER INSERT ON documents BEGIN
  INSERT INTO document_search(document_id, title, path, summary)
  VALUES (new.id, new.title, new.path, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS trg_document_search_update
AFTER UPDATE OF title, path, summary ON documents BEGIN
  DELETE FROM document_search WHERE document_id = old.id;
  INSERT INTO document_search(document_id, title, path, summary)
  VALUES (new.id, new.title, new.path, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS trg_document_search_delete
AFTER DELETE ON documents BEGIN
  DELETE FROM document_search WHERE document_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_block_search_insert
AFTER INSERT ON blocks BEGIN
  INSERT INTO block_search(block_id, document_id, content)
  VALUES (new.id, new.document_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_block_search_update
AFTER UPDATE OF document_id, content ON blocks BEGIN
  DELETE FROM block_search WHERE block_id = old.id;
  INSERT INTO block_search(block_id, document_id, content)
  VALUES (new.id, new.document_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_block_search_delete
AFTER DELETE ON blocks BEGIN
  DELETE FROM block_search WHERE block_id = old.id;
END;

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_source_document_id ON links(source_document_id);
CREATE INDEX IF NOT EXISTS idx_links_target_document_id ON links(target_document_id);

CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS database_saved_views (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filter_query TEXT NOT NULL DEFAULT '',
  filter_scope TEXT NOT NULL DEFAULT '',
  sort_mode TEXT NOT NULL DEFAULT 'updated-desc',
  view_mode TEXT NOT NULL DEFAULT 'cards',
  config_json TEXT NOT NULL DEFAULT '{}',
  config_version INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_database_saved_views_database_name
  ON database_saved_views(database_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS document_database_columns (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_database_columns_sort_order ON document_database_columns(sort_order);

CREATE TABLE IF NOT EXISTS database_entities (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS database_entity_values (
  entity_id TEXT NOT NULL REFERENCES database_entities(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES document_database_columns(id) ON DELETE CASCADE,
  value_text TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, column_id)
);

CREATE TABLE IF NOT EXISTS document_database_values (
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES document_database_columns(id) ON DELETE CASCADE,
  value_text TEXT,
  updated_at TEXT NOT NULL,
  entity_id TEXT REFERENCES database_entities(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, column_id)
);

CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_events_created_at ON workspace_events(created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  persistence_scope TEXT NOT NULL,
  created_session_id TEXT,
  current_revision_id TEXT,
  pending_revision_id TEXT,
  active_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_revisions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_definitions(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  previous_revision_id TEXT REFERENCES plugin_revisions(id) ON DELETE SET NULL,
  manifest_json TEXT NOT NULL,
  requested_permissions_json TEXT NOT NULL DEFAULT '[]',
  api_version TEXT NOT NULL,
  state_schema_version INTEGER,
  size_bytes INTEGER NOT NULL,
  static_check_status TEXT NOT NULL,
  static_check_json TEXT NOT NULL DEFAULT '[]',
  generated_by_session_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(plugin_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_plugin_revisions_plugin_created
  ON plugin_revisions(plugin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS plugin_installations (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_definitions(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL,
  workspace_id TEXT,
  session_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_installations_scope
  ON plugin_installations(
    plugin_id,
    scope_kind,
    ifnull(workspace_id, ''),
    ifnull(session_id, '')
  );

CREATE TABLE IF NOT EXISTS plugin_grants (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_definitions(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES plugin_revisions(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL,
  workspace_id TEXT,
  session_id TEXT,
  grants_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugin_grants_revision_status
  ON plugin_grants(revision_id, status);

CREATE TABLE IF NOT EXISTS plugin_runs (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_definitions(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES plugin_revisions(id) ON DELETE CASCADE,
  installation_id TEXT REFERENCES plugin_installations(id) ON DELETE SET NULL,
  grant_set_id TEXT NOT NULL REFERENCES plugin_grants(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL,
  workspace_id TEXT,
  session_id TEXT,
  epoch INTEGER,
  status TEXT NOT NULL,
  error_json TEXT,
  started_at TEXT NOT NULL,
  ready_at TEXT,
  stopped_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_runs_plugin_started
  ON plugin_runs(plugin_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_runs_status
  ON plugin_runs(status);

CREATE TABLE IF NOT EXISTS plugin_state (
  plugin_id TEXT NOT NULL REFERENCES plugin_definitions(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, scope_key)
);

CREATE TABLE IF NOT EXISTS plugin_logs (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugin_definitions(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES plugin_revisions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES plugin_runs(id) ON DELETE SET NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_logs_plugin_created
  ON plugin_logs(plugin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  active_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  model_config_json TEXT NOT NULL,
  status TEXT NOT NULL,
  active_turn_id TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_sessions_updated
  ON assistant_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_events (
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  surface TEXT NOT NULL,
  turn_id TEXT,
  step_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_assistant_events_session_type
  ON assistant_events(session_id, type, seq);
`
