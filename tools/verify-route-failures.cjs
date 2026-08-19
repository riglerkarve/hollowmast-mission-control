#!/usr/bin/env node
//
// verify-route-failures.cjs — Batch D (M89–M93): prove a database read failure
// cannot become a successful empty response at the route boundary.
//
// This starts the complete Express application against a new database in a named
// OS-temporary directory. It never opens data/dashboard.db, even read-only. Once the
// routes have migrated the temporary database, db.prepare is replaced with a throwing
// accessor for one representative GET endpoint per route module.
//
// The deliberate fault is broader than a renamed column: every ordinary query fails,
// so a route that catches one particular SQLite error but swallows another cannot pass by
// matching the planted error text. Results distinguish a route with no database query from
// a route that saw the fault and reported it.
//
//   node tools/verify-route-failures.cjs
//
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { inventory } = require('./route-inventory.cjs');

const ROOT = path.join(__dirname, '..');
const groups = {
  M89: ['alerts', 'analytics', 'atlas', 'board', 'brain', 'briefing'],
  M90: ['browsing', 'budget', 'cash', 'drive', 'exercise', 'finance'],
  M91: ['garage', 'goals', 'health', 'income', 'lifestyle', 'machine'],
  M92: ['mail', 'projects', 'safety', 'schedule', 'sessions', 'stats'],
  M93: ['tasks', 'team', 'todo', 'uptime', 'wellbeing', 'work'],
};

function endpointOptions() {
  const byFile = new Map();
  for (const endpoint of inventory().endpoints) {
    if (endpoint.file === 'gate' || endpoint.path.includes(':')) continue;
    if (endpoint.path.includes('*') && endpoint.file !== 'garage') continue;
    const resolved = endpoint.file === 'garage' ? '/garage/index.html' : endpoint.path;
    byFile.set(endpoint.file, [...(byFile.get(endpoint.file) || []), { ...endpoint, path: resolved }]);
  }
  for (const endpoints of byFile.values()) endpoints.sort((a, b) => (a.route === '/' ? -1 : 0) - (b.route === '/' ? -1 : 0));
  return byFile;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function request(base, route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
  const type = response.headers.get('content-type') || '';
  const text = await response.text();
  let body = null;
  if (type.includes('application/json') && text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
  const explicitError = !!(body && typeof body === 'object' && !Array.isArray(body)
    && (body.state === 'error' || typeof body.error === 'string' || Array.isArray(body.errors)));
  return { status: response.status, type, bytes: Buffer.byteLength(text), keys, explicitError };
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-route-failure-'));
  const tempDb = path.join(tempDir, 'route-failure-probe.db');
  let server = null;
  let db = null;
  try {
    // These are set before the first require of server/index.js. server/db.js therefore creates
    // and migrates only this empty temporary file. The live dashboard database is never opened.
    process.env.MC_DB_PATH = tempDb;
    process.env.MC_DISABLE_ACCESS_LOG = '1';
    process.env.MC_ACTOR = 'route-failure-probe';

    const app = require('../server/index');
    db = require('../server/db');
    const originalPrepare = db.prepare.bind(db);
    const endpoints = endpointOptions();
    // Express's default development error page is an HTML stack trace. It is an explicit 500,
    // but it makes a deterministic report noisy and can expose implementation paths. This
    // test-only handler converts only injected route errors to a compact, explicit JSON error.
    app.use((err, req, res, next) => {
      if (res.headersSent) return next(err);
      return res.status(500).json({ state: 'error', error: 'intentional database read failure during route probe' });
    });
    server = http.createServer(app);
    const base = `http://127.0.0.1:${await listen(server)}`;

    console.log('Route Failure Verification — Batch D (M89–M93)');
    console.log(`TEMP DATABASE: ${tempDb}`);
    console.log('LIVE DATABASE: never opened; all migrations and faulted reads use the temporary path above.');

    const failures = [];
    const noQuery = [];
    for (const [batch, files] of Object.entries(groups)) {
      console.log(`\n${batch}`);
      for (const file of files) {
        const options = endpoints.get(file) || [];
        if (!options.length) {
          failures.push(`${file}: no resolvable GET endpoint to fault`);
          console.log(`  ${file}: COULD NOT LOOK — no resolvable GET endpoint registered.`);
          continue;
        }
        let selected = null;
        const noQueryPaths = [];
        for (const endpoint of options) {
          let attempts = 0;
          db.prepare = function faultedPrepare() {
            attempts += 1;
            throw new Error('BATCH_D_INTENTIONAL_DATABASE_READ_FAILURE');
          };
          let result;
          try {
            result = await request(base, endpoint.path);
          } catch (error) {
            result = { requestError: error.name };
          } finally {
            db.prepare = originalPrepare;
          }
          if (attempts) { selected = { endpoint, result }; break; }
          noQueryPaths.push(endpoint.path);
        }
        if (!selected) {
          noQuery.push(`${file} (${noQueryPaths.join(', ')})`);
          console.log(`  ${file}: NO DATABASE QUERY on ${noQueryPaths.join(', ')} — fault did not apply; route is not offered as a failure-handling pass.`);
          continue;
        }
        const { endpoint, result } = selected;
        if (result.requestError) {
          failures.push(`${file}: request ${result.requestError}`);
          console.log(`  ${file} ${endpoint.path}: REQUEST FAILURE ${result.requestError}.`);
          continue;
        }
        const explicit = result.status >= 500 || result.explicitError;
        const description = `status=${result.status}; bytes=${result.bytes}; jsonKeys=${result.keys.length ? result.keys.join(',') : '-'}; ${result.explicitError ? 'explicit-error-body' : 'no-explicit-error-body'}`;
        if (!explicit) {
          failures.push(`${file}: fault returned ${result.status} without an explicit error`);
          console.log(`  ${file} ${endpoint.path}: MASKED FAILURE — ${description}`);
        } else {
          console.log(`  ${file} ${endpoint.path}: EXPLICIT FAILURE — ${description}`);
        }
      }
    }

    console.log(`\nRESULT: ${failures.length} masked/request/unresolved failure(s); ${noQuery.length} route(s) made no database query (${noQuery.join(', ') || 'none'}).`);
    if (failures.length) {
      console.error(`FAILURES:\n  ${failures.join('\n  ')}`);
      process.exitCode = 1;
    }
  } finally {
    if (server) await close(server);
    if (db) db.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(`TEMP CLEANUP: removed ${tempDir}`);
    } catch (error) {
      console.error(`TEMP CLEANUP FAILED: ${tempDir} (${error.code || error.name})`);
    }
  }
})().catch((error) => {
  console.error(`UNEXPECTED TEST FAILURE: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
