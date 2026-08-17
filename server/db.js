const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'dashboard.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'work',
    duration_minutes INTEGER NOT NULL,
    completed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_focus_sessions_completed_at ON focus_sessions(completed_at);

  -- One row per module. CREATE TABLE IF NOT EXISTS is fine for ADDING a table and is not
  -- a strategy for CHANGING one: it succeeds silently against an old shape, so the app
  -- runs against a schema it does not expect. From here every structural change is a
  -- numbered migration.
  CREATE TABLE IF NOT EXISTS schema_meta (
    module TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// Modules own their own tables and their own migrations — see ARCHITECTURE.md. Each
// module calls this once at require time with an ordered list of functions.
//
// Rules that make this safe:
//   - Migrations are append-only. Never edit one that has shipped; add the next.
//   - Each runs inside a transaction, so a failure leaves the version unchanged rather
//     than half-applied.
//   - The version is written in the SAME transaction as the change it describes.
function migrate(moduleName, migrations) {
  const row = db.prepare('SELECT version FROM schema_meta WHERE module = ?').get(moduleName);
  const current = row ? row.version : 0;

  if (current > migrations.length) {
    // The database is newer than the code — almost always an old server against a
    // migrated file. Refusing is the only safe answer; guessing corrupts data.
    throw new Error(
      `${moduleName}: database is at schema v${current} but this code only knows ${migrations.length}. ` +
      'Running an older server against a newer database is not supported.'
    );
  }

  for (let v = current; v < migrations.length; v += 1) {
    const next = v + 1;
    db.exec('BEGIN');
    try {
      migrations[v](db);
      db.prepare(
        `INSERT INTO schema_meta (module, version, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
         ON CONFLICT(module) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`
      ).run(moduleName, next);
      db.exec('COMMIT');
      console.log(`[schema] ${moduleName} -> v${next}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`${moduleName} migration v${next} failed: ${err.message}`);
    }
  }
}

module.exports = db;
module.exports.migrate = migrate;
