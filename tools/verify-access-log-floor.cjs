#!/usr/bin/env node
'use strict';

// verify-access-log-floor.cjs — demonstrate the finance access counter is not total access.
//
// It opens data/dashboard.db directly and READ-ONLY, counts finance rows, then checks whether
// the instrumented access-log total changed. A direct reader must leave it unchanged; if a
// concurrent request changes it, the result is INCONCLUSIVE rather than a false pass.
// No _run-log here: that would open the live database through the writable chokepoint and
// turn a read-only proof into a write.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dashboard.db');

function accessTotal(db) {
  return Number(db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM data_access_log WHERE table_name LIKE 'finance_%'").get().n);
}

function directReaders() {
  // The complete candidates are discovered, not assumed. Classification stays conservative:
  // a direct database opener whose source does not prove it reads finance is named as such,
  // never filed as a bypass just because it imported node:sqlite.
  const roots = ['tools', 'scripts'];
  const out = [];
  for (const root of roots) {
    const dir = path.join(ROOT, root);
    for (const name of fs.readdirSync(dir).filter((entry) => /\.(?:cjs|js)$/.test(entry))) {
      const relative = `${root}/${name}`;
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      if (!/new\s+DatabaseSync\s*\(/.test(source) || !/dashboard\.db/.test(source)) continue;
      let scope = 'direct dashboard reader, finance scope not proven from source';
      if (relative === 'scripts/backup.js') scope = 'copies the whole live database (therefore reads finance tables)';
      if (relative === 'tools/restore-backup.cjs') scope = 'counts every live table read-only, including finance tables';
      if (relative === 'tools/verify-access-log-floor.cjs') scope = 'this proof directly counts finance_transactions read-only';
      out.push({ relative, scope });
    }
  }
  return out;
}

let db;
try {
  if (!fs.existsSync(DB_PATH)) throw new Error(`live database absent: ${DB_PATH}`);
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  const before = accessTotal(db);
  const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM finance_transactions').get().n);
  const after = accessTotal(db);

  console.log(`LIVE DATABASE OPENED READ-ONLY: ${DB_PATH}`);
  console.log(`DIRECT finance_transactions COUNT read: ${rows} row(s) (no values read or printed)`);
  console.log(`INSTRUMENTED finance access total: ${before} before, ${after} after`);
  if (after === before) console.log('PASS floor claim: this direct finance read was invisible to the instrumented access log.');
  else {
    console.log('INCONCLUSIVE: the access total changed during the proof, possibly due to another process.');
    process.exitCode = 2;
  }

  console.log('\nCURRENT DIRECT DATABASE PATHS');
  for (const reader of directReaders()) console.log(`  ${reader.relative} — ${reader.scope}`);
  console.log('These paths are outside server/db.js. The access log is therefore a floor, not a total.');
} catch (error) {
  console.error(`COULD NOT PROVE access-log floor: ${error.message}`);
  process.exitCode = 2;
} finally {
  try { if (db) db.close(); } catch { /* read-only handle cleanup */ }
}
