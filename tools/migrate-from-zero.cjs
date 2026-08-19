#!/usr/bin/env node
//
// migrate-from-zero.cjs — prove every route migration applies, in server order, to no database.
//
// The live ledger is never opened. This process creates a unique database beneath the system
// temp directory, points MC_DB_PATH at it before loading db.js, reports its schema, then closes
// and removes that exact temporary directory.
'use strict';

// Deliberately no `_run-log.cjs` here. Its own database migration loads `server/db.js`, which
// would open the live ledger before this verifier can set MC_DB_PATH and turn a safety proof
// into the exact unsafe action it is meant to rule out.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIVE_DB = path.join(ROOT, 'data', 'dashboard.db');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-migrate-zero-'));
const tempDb = path.join(tempDir, 'dashboard.db');

// db.js reads this at module load. Set it before requiring either db.js or any route.
process.env.MC_DB_PATH = tempDb;
process.env.MC_DISABLE_ACCESS_LOG = '1';

const ROUTES = [
  ['tasks', '../server/routes/tasks'],
  ['sessions', '../server/routes/sessions'],
  ['stats', '../server/routes/stats'],
  ['uptime', '../server/routes/uptime'],
  ['finance', '../server/routes/finance'],
  ['briefing', '../server/routes/briefing'],
  ['brain', '../server/routes/brain'],
  ['work', '../server/routes/work'],
  ['exercise', '../server/routes/exercise'],
  ['budget', '../server/routes/budget'],
  ['cash', '../server/routes/cash'],
  ['mail', '../server/routes/mail'],
  ['drive', '../server/routes/drive'],
  ['alerts', '../server/routes/alerts'],
  ['todo', '../server/routes/todo'],
  ['income', '../server/routes/income'],
  ['lifestyle', '../server/routes/lifestyle'],
  ['wellbeing', '../server/routes/wellbeing'],
  ['health', '../server/routes/health'],
  ['garage', '../server/routes/garage'],
  ['safety', '../server/routes/safety'],
  ['browsing', '../server/routes/browsing'],
  ['atlas', '../server/routes/atlas'],
  ['board', '../server/routes/board'],
  ['team', '../server/routes/team'],
  ['goals', '../server/routes/goals'],
  ['schedule', '../server/routes/schedule'],
  ['projects', '../server/routes/projects'],
  ['machine', '../server/routes/machine'],
  ['analytics', '../server/routes/analytics'],
];

// These are loaded by server/index.js after its route declarations. `gate` owns a migration,
// so omitting this tail would prove a different startup sequence from the real server.
const POST_ROUTE_MODULES = [
  ['heartbeat', '../server/heartbeat'],
  ['gate', '../server/gate'],
  ['provenance', '../server/provenance'],
];

function fail(message) {
  console.error(`FAIL migrate-from-zero: ${message}`);
  process.exitCode = 1;
}

let db;
try {
  if (path.resolve(tempDb) === path.resolve(LIVE_DB)) throw new Error('temporary database resolved to the live ledger');
  db = require('../server/db');
  if (path.resolve(db.databasePath) !== path.resolve(tempDb)) {
    throw new Error(`db.js opened ${db.databasePath}, not the temporary file`);
  }

  const loaded = [];
  for (const [name, route] of ROUTES) {
    require(route);
    loaded.push(name);
  }
  for (const [name, module] of POST_ROUTE_MODULES) {
    require(module);
    loaded.push(name);
  }

  const modules = db.prepare('SELECT module, version FROM schema_meta ORDER BY module').all();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (!modules.length) throw new Error('route loading produced no schema modules');
  if (!tables.length) throw new Error('route loading produced no tables');

  console.log(`TEMPORARY DATABASE: ${tempDb}`);
  console.log(`LIVE DATABASE NOT OPENED: ${LIVE_DB}`);
  console.log(`ROUTES REQUIRED IN SERVER ORDER (${loaded.length}): ${loaded.join(', ')}`);
  console.log(`MIGRATED MODULES (${modules.length}): ${modules.map((m) => `${m.module}@v${m.version}`).join(', ')}`);
  console.log(`TABLES CREATED (${tables.length}): ${tables.map((t) => t.name).join(', ')}`);
  console.log('PASS migrate-from-zero: every route loaded and its migrations completed on a fresh database.');
} catch (err) {
  fail(err.stack || err.message);
} finally {
  try { if (db) db.close(); } catch (err) { fail(`could not close temporary database: ${err.message}`); }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (err) { fail(`could not remove ${tempDir}: ${err.message}`); }
}
