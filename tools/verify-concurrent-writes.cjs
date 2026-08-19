#!/usr/bin/env node
//
// verify-concurrent-writes.cjs — Batch G M106: observe two node:sqlite writer
// processes reaching the same table at the same time.
//
//   node tools/verify-concurrent-writes.cjs
//
// The parent creates a new database in a named OS-temporary directory. It never
// imports server/db.js, reads, or writes data/dashboard.db. Two child processes
// wait on a release file, then each begins an IMMEDIATE transaction, inserts one
// row, holds it briefly, and commits. A lock error is a measured outcome, not a
// passing serialization claim.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const WORKER = process.argv[2] === '--worker';

function worker() {
  const [name, dbFile, releaseFile] = process.argv.slice(3);
  if (!name || !dbFile || !releaseFile) {
    console.error('worker usage: --worker <name> <temporary-db-path> <release-file>');
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(dbFile);
  const report = { name, outcome: 'unknown', error: null };
  process.stdout.write('READY\n');
  const wait = setInterval(() => {
    if (!fs.existsSync(releaseFile)) return;
    clearInterval(wait);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO concurrent_write_probe (worker, wrote_at) VALUES (?, ?)')
        .run(name, new Date().toISOString());
      // Keep the write lock long enough for the second process to encounter it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      db.exec('COMMIT');
      report.outcome = 'committed';
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction was opened */ }
      report.outcome = /database is locked|SQLITE_BUSY/i.test(error.message) ? 'locked' : 'error';
      report.error = error.message;
    } finally {
      try { db.close(); } catch { /* report the write result even if close fails */ }
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }
  }, 5);
}

function spawnWorker(name, dbFile, releaseFile) {
  const child = spawn(process.execPath, [__filename, '--worker', name, dbFile, releaseFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  let errors = '';
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${name} did not become ready`)), 5000);
    child.stdout.on('data', () => {
      if (text.includes('READY\n')) { clearTimeout(deadline); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
  });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      const record = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .find(Boolean);
      if (!record) return reject(new Error(`${name} exited ${code}; ${errors.trim() || 'no structured result'}`));
      resolve(record);
    });
  });
  return { ready, result };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-concurrent-write-'));
  const tempDb = path.join(tempDir, 'concurrent-write-probe.db');
  const release = path.join(tempDir, 'release');
  let setup = null;
  try {
    setup = new DatabaseSync(tempDb);
    setup.exec('PRAGMA journal_mode = WAL; CREATE TABLE concurrent_write_probe (worker TEXT PRIMARY KEY, wrote_at TEXT NOT NULL);');
    setup.close();
    setup = null;

    const left = spawnWorker('left', tempDb, release);
    const right = spawnWorker('right', tempDb, release);
    await Promise.all([left.ready, right.ready]);
    fs.writeFileSync(release, 'go');
    const results = await Promise.all([left.result, right.result]);

    const read = new DatabaseSync(tempDb);
    const rows = read.prepare('SELECT worker, wrote_at FROM concurrent_write_probe ORDER BY worker').all();
    read.close();
    const committed = results.filter((result) => result.outcome === 'committed').length;
    const locked = results.filter((result) => result.outcome === 'locked').length;
    const errors = results.filter((result) => result.outcome === 'error');

    console.log('Concurrent Write Verification — Batch G M106');
    console.log(`TEMP DATABASE: ${tempDb}`);
    console.log('LIVE DATABASE: never opened; both child writers and the result read used only the temporary path above.');
    for (const result of results) {
      console.log(`${result.name}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);
    }
    console.log(`ROWS COMMITTED: ${rows.length} (${rows.map((row) => row.worker).join(', ') || 'none'})`);
    if (committed === 2 && rows.length === 2) console.log('RESULT: clean serialisation — both writers committed once.');
    else if (committed === 1 && locked === 1 && rows.length === 1) console.log('RESULT: lock error — one writer committed and one received SQLITE_BUSY; no silent last-write-wins occurred.');
    else throw new Error(`unexpected outcome: ${JSON.stringify({ results, rows })}`);
  } finally {
    try { if (setup) setup.close(); } catch { /* cleanup continues */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* path is printed above if cleanup fails */ }
  }
}

if (WORKER) worker();
else main().catch((error) => {
  console.error(`FAIL concurrent write verification: ${error.message}`);
  process.exitCode = 1;
});
