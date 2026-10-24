const Database = require('better-sqlite3')

const database = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try {
  database.pragma('query_only = ON')
  // Keep every table in one committed SQLite snapshot while Main remains active.
  const snapshot = database.transaction(() => ({
    schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
    tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities',
      'database_entity_values', 'document_database_values', 'database_saved_views'].map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()]))
  })).deferred()
  process.stdout.write(JSON.stringify(snapshot))
} finally {
  database.close()
}
