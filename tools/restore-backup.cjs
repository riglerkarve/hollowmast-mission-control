#!/usr/bin/env node
//
// restore-backup.cjs — restore the newest database snapshot into temp and compare it read-only.
//
// This deliberately does not use server/db.js or _run-log.cjs: either would open the live
// database through the application's writable connection. The two SQLite handles below are
// explicitly read-only; the sole write is copying a backup into a unique system-temp directory.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const LIVE_DB = path.join(ROOT, 'data', 'dashboard.db');
const BACKUPS = path.join(ROOT, 'backups');

function newestBackup() {
  const candidates = fs.readdirSync(BACKUPS)
    .filter((name) => /^dashboard-.*\.db$/i.test(name))
    .map((name) => {
      const file = path.join(BACKUPS, name);
      return { file, stat: fs.statSync(file) };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!candidates.length) throw new Error(`no dashboard backups found in ${BACKUPS}`);
  return candidates[0];
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
}

function counts(db, names) {
  return new Map(names.map((name) => [name, db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(name)}`).get().n]));
}

function closeQuietly(db) {
  try { if (db) db.close(); } catch { /* cleanup is reported by the caller's filesystem check */ }
}

let live;
let restored;
let tempDir;
try {
  if (!fs.existsSync(LIVE_DB)) throw new Error(`live database is absent: ${LIVE_DB}`);
  const backup = newestBackup();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-restore-'));
  const restoredDb = path.join(tempDir, 'dashboard.db');
  if (path.resolve(restoredDb) === path.resolve(LIVE_DB)) throw new Error('temporary restore resolved to the live database');
  fs.copyFileSync(backup.file, restoredDb);

  // `readOnly: true` is the construction proof: neither query handle can modify its file.
  live = new DatabaseSync(LIVE_DB, { readOnly: true });
  restored = new DatabaseSync(restoredDb, { readOnly: true });
  const integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`restored backup integrity check: ${integrity}`);

  const liveTables = tableNames(live);
  const restoredTables = tableNames(restored);
  const liveSet = new Set(liveTables);
  const restoredSet = new Set(restoredTables);
  const allTables = [...new Set([...liveTables, ...restoredTables])].sort();
  const liveCounts = counts(live, liveTables);
  const restoredCounts = counts(restored, restoredTables);

  console.log(`BACKUP RESTORED TO TEMPORARY PATH: ${restoredDb}`);
  console.log(`BACKUP SOURCE: ${backup.file} (${backup.stat.size} bytes, ${backup.stat.mtime.toISOString()})`);
  console.log(`LIVE DATABASE OPENED READ-ONLY: ${LIVE_DB}`);
  console.log('RESTORED DATABASE OPENED READ-ONLY: true');
  console.log(`INTEGRITY CHECK: ${integrity}`);
  console.log(`TABLES only in live (${liveTables.filter((name) => !restoredSet.has(name)).length}): ${liveTables.filter((name) => !restoredSet.has(name)).join(', ') || '(none)'}`);
  console.log(`TABLES only in backup (${restoredTables.filter((name) => !liveSet.has(name)).length}): ${restoredTables.filter((name) => !liveSet.has(name)).join(', ') || '(none)'}`);
  console.log('ROW COUNTS (backup -> live; difference is live minus backup, not a failure):');
  for (const name of allTables) {
    const before = restoredCounts.get(name);
    const now = liveCounts.get(name);
    const difference = before == null || now == null ? 'n/a' : now - before;
    console.log(`  ${name}: ${before == null ? '(absent)' : before} -> ${now == null ? '(absent)' : now}; difference ${difference}`);
  }
  console.log('PASS restore-backup: the newest snapshot is readable after restoration; differences are reported above.');
} catch (err) {
  console.error(`FAIL restore-backup: ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  closeQuietly(restored);
  closeQuietly(live);
  try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch (err) {
    console.error(`FAIL restore-backup cleanup: ${err.message}`);
    process.exitCode = 1;
  }
}
