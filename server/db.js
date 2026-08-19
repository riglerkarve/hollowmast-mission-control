const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const fs = require('node:fs');

// Tests that prove a migration can start from zero must never open the live ledger. The
// override is intentionally a complete file path, rather than a looser "test mode": a caller
// can print and inspect the exact database it created. Normal processes retain the one live
// path below.
const LIVE_DB_FILE = path.join(__dirname, '..', 'data', 'dashboard.db');
const DB_FILE = process.env.MC_DB_PATH ? path.resolve(process.env.MC_DB_PATH) : LIVE_DB_FILE;
const DATA_DIR = path.dirname(DB_FILE);
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

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

  -- Backlog #14. Infrastructure, not a module's table — it belongs beside schema_meta for
  -- the same reason: it describes the database rather than any one domain. Aggregated to
  -- one row per (day, table, actor, op) because a row per query would be a write for every
  -- read, and the question being asked is "what was touched and how often", not "list every
  -- statement".
  CREATE TABLE IF NOT EXISTS data_access_log (
    day        TEXT NOT NULL,
    table_name TEXT NOT NULL,
    actor      TEXT NOT NULL,
    op         TEXT NOT NULL,
    n          INTEGER NOT NULL DEFAULT 0,
    last_at    TEXT NOT NULL,
    PRIMARY KEY (day, table_name, actor, op)
  );
`);

// ---------------------------------------------------------------------------------------
// ACCESS LOGGING — backlog #14, "personal finance data is ALLOWED to a frontier model,
// kept under review". The item's own words: under review means nothing without a log of
// which finance data left the machine and when, or it is only a good intention.
//
// INSTRUMENTED HERE, NOT ON THE ROUTES, AND THAT CHOICE IS THE WHOLE POINT. A route-level
// log would have looked immaculate and been mostly wrong: on 18 Aug I read this ledger
// three ways in one session — through /api/finance, through `require('../server/db')` in
// tools/tax-year-report.cjs, and through a bare node -e script. Only the first goes through
// a route. Everything in this repo that touches the database goes through THIS module, so
// this is the chokepoint that sees the server and every tool alike.
//
// WHAT IT STILL CANNOT SEE, stated here because a governance log that quietly under-reports
// is worse than no log at all — it manufactures confidence:
//
//   - `new DatabaseSync('data/dashboard.db')` in a standalone script bypasses this entirely.
//     I did exactly that earlier the same day. Nothing in-process can catch it.
//   - Reading the .db file, a backup, or a WAL segment with any other tool.
//   - What was DONE with the rows once read. This records access, never purpose.
//
// It is therefore a floor: real exposure is at least this, never less. That is the useful
// direction for this kind of log, and it is why it deliberately errs toward over-counting
// (see the prepare() note below).
const actorStore = new AsyncLocalStorage();
let processActor = process.env.MC_ACTOR || 'unknown';

// Whether withTransaction currently holds a transaction on the shared connection. One
// connection process-wide means this is a true global, not per-request state.
let inTransaction = false;

// Which tables are worth recording. Finance is what #14 asked for. Adding health_ or
// wellbeing_ here is a one-line change and needs no migration.
// gmail_ joins finance_ the moment the tables exist rather than later: the log answers
// 'who has read this', and mail metadata with subject lines is the second most sensitive
// thing in this database. Adding it after the first import would leave exactly the window
// the log is for.
const SENSITIVE_PREFIXES = ['finance_', 'gmail_'];
const SENSITIVE_RE = new RegExp(`\\b(?:${SENSITIVE_PREFIXES.join('|')})[a-z0-9_]+`, 'gi');

// Aggregated in memory and flushed, so a burst of reads is one write rather than hundreds.
const pending = new Map();

// Captured BEFORE db.prepare is replaced, and declared above every function that uses it.
// flush() only runs from a timer so a later `const` would not actually throw — but a
// use-before-declaration that survives purely on call ordering is the temporal-dead-zone
// shape that took out the whole wellbeing panel on 17 Aug. Ordered so it cannot recur.
const rawPrepare = db.prepare.bind(db);

function currentActor() {
  return actorStore.getStore() || processActor;
}

function note(sql) {
  // A read-only caller (currently briefing.cjs --dry) must not turn its reads into a
  // persistent access-log write. The flag is process-local and opt-in, so normal audit
  // coverage is unchanged.
  if (process.env.MC_DISABLE_ACCESS_LOG === '1') return;
  const found = String(sql).match(SENSITIVE_RE);
  if (!found) return;

  // Reads and writes are counted separately: "Claude read the ledger" and "the importer
  // wrote to it" are different events and collapsing them would hide both.
  const op = /^\s*(?:select|with)\b/i.test(sql) ? 'read' : 'write';
  const actor = currentActor();
  const day = new Date().toLocaleDateString('en-CA');
  const at = new Date().toISOString();

  for (const table of new Set(found.map((t) => t.toLowerCase()))) {
    // NUL joins the key because it is the one byte that cannot occur in a date, a table
    // name, an actor or an op, so no combination of values can collide. Written as an
    // ESCAPE, never as a raw byte: a raw NUL is invisible to anyone editing this line and
    // is silently rewritten by tools that normalise text, which would split one days
    // aggregate into two rows with no error.
    const key = `${day}\u0000${table}\u0000${actor}\u0000${op}`;
    const row = pending.get(key);
    if (row) { row.n += 1; row.last_at = at; } else {
      pending.set(key, { day, table_name: table, actor, op, n: 1, last_at: at });
    }
  }
}

function flush() {
  if (!pending.size) return;
  const rows = [...pending.values()];
  pending.clear();
  try {
    const up = rawPrepare.call(db,
      `INSERT INTO data_access_log (day, table_name, actor, op, n, last_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, table_name, actor, op)
       DO UPDATE SET n = n + excluded.n, last_at = excluded.last_at`);
    for (const r of rows) up.run(r.day, r.table_name, r.actor, r.op, r.n, r.last_at);
  } catch (err) {
    // Never let bookkeeping take down a request. Losing counts is a degraded log; throwing
    // here would be a broken dashboard.
    console.error(`[access-log] flush failed, ${rows.length} row(s) lost: ${err.message}`);
  }
}

// flush() uses rawPrepare (captured above) rather than the wrapper, or writing the log
// would itself be an access worth logging and the counter would chase its own tail.
db.prepare = function prepare(sql) {
  // Recorded at PREPARE, not at execution. A prepared statement that is never run would be
  // counted anyway — which over-reports slightly, and over-reporting is the safe direction
  // for an egress log. Hooking every get/all/run to be exact would wrap a hot path for a
  // rounding error.
  try { note(sql); } catch { /* logging must never break a query */ }
  return rawPrepare(sql);
};

// unref'd so a short-lived tool is not held open by the timer, and flushed on exit so its
// counts still land. The exit handler is the one that matters for tools: they typically
// run and exit inside a single flush interval.
const FLUSH_MS = 10_000;
const timer = setInterval(flush, FLUSH_MS);
if (typeof timer.unref === 'function') timer.unref();
process.on('exit', flush);

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

// Run fn with a request-scoped actor. AsyncLocalStorage rather than a module-level
// variable: an async route handler can yield between setting an actor and running its
// query, and a plain variable would then attribute one request's reads to another.
function runAs(actor, fn) {
  return actorStore.run(actor || 'unknown', fn);
}

// For tools and scripts, which have no request. `MC_ACTOR=claude node tools/whatever.cjs`
// does the same thing without a code change.
function setProcessActor(actor) { processActor = actor || 'unknown'; }

// The accessor. db.js owns the table AND the reads of it, so no module has to know the
// schema — same shape as migrate(). Returns the pending in-memory counts folded in, or a
// caller checking immediately after a read would see nothing and conclude wrongly that
// nothing was recorded.
function accessLog({ days = 30, prefix = null } = {}) {
  flush();
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA');
  const rows = rawPrepare.call(db,
    `SELECT day, table_name, actor, op, n, last_at
       FROM data_access_log
      WHERE day >= ? ${prefix ? 'AND table_name LIKE ?' : ''}
      ORDER BY day DESC, n DESC`
  ).all(...(prefix ? [since, `${prefix}%`] : [since]));

  return {
    rows,
    days,
    watching: SENSITIVE_PREFIXES,
    // Carried with the data rather than written into a panel, so it cannot drift away from
    // the thing it qualifies. See ARCHITECTURE.md on filters reporting their residue.
    blindTo: [
      'A standalone script opening data/dashboard.db directly with new DatabaseSync — nothing in-process can see that.',
      'Reading the .db file, a backup, or a WAL segment with any other tool.',
      'What was done with the rows once read. This records access, never purpose.',
    ],
    isFloor: true,
  };
}

// The ONLY place BEGIN should appear. node:sqlite hands out one connection process-wide,
// so two overlapping transactions throw "cannot start a transaction within a transaction"
// — and the naive catch that follows a bare BEGIN rolls back whichever transaction is
// actually open, discarding writes the failing caller never made. That was a real defect
// in the todo PATCH on 18 Aug; removing its guard destroyed an outer write, 1 -> 0.
//
// THE RULE THIS ENCODES, which was previously true and written down nowhere: `fn` must be
// FULLY SYNCHRONOUS. Await anything inside a transaction and the event loop can run another
// request between BEGIN and COMMIT, which is exactly the overlap that breaks. An async fn is
// refused here rather than left to fail later somewhere else.
function withTransaction(fn) {
  if (typeof fn !== 'function') throw new TypeError('withTransaction needs a function');
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    throw new TypeError(
      'withTransaction refuses an async function: awaiting inside a transaction lets another '
      + 'request start one on the same connection. Do the async work first, then call this '
      + 'with the synchronous writes.',
    );
  }
  if (inTransaction) {
    // Nested call. Join the outer transaction rather than starting a second one, and let the
    // outermost caller decide the outcome — a nested COMMIT would publish half a unit of work.
    return fn();
  }
  db.exec('BEGIN');
  inTransaction = true;
  let out;
  try {
    out = fn();
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* connection already unwound it */ }
    inTransaction = false;
    throw err;
  }
  // A promise here means fn was async in all but name (e.g. an arrow returning a promise),
  // which the constructor check above cannot see. Refuse it the same way, and roll back.
  if (out && typeof out.then === 'function') {
    try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
    inTransaction = false;
    throw new TypeError('withTransaction callback returned a promise; the transaction was rolled back');
  }
  db.exec('COMMIT');
  inTransaction = false;
  return out;
}

module.exports = db;
module.exports.withTransaction = withTransaction;
module.exports.migrate = migrate;
module.exports.runAs = runAs;
module.exports.setProcessActor = setProcessActor;
module.exports.accessLog = accessLog;
module.exports.flushAccessLog = flush;
module.exports.databasePath = DB_FILE;
