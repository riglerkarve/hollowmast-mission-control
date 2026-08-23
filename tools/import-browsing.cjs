#!/usr/bin/env node
//
// import-browsing.cjs — Edge history into browsing_domains. Backlog #12.
//
//   node tools/import-browsing.cjs         import
//   node tools/import-browsing.cjs --dry   show what would be imported, write nothing
//
// DOMAINS AND COUNTS ONLY. This file never reads a URL into the database and never touches
// page titles. See server/routes/browsing.js for why: the database is served on 0.0.0.0
// behind one shared secret and already holds the bank ledger, so a full URL history would
// make a single leaked key far more expensive than it already is.
//
// TWO MACHINE FACTS THIS DEPENDS ON, both found the hard way:
//
//   1. THE HISTORY FILE IS LOCKED WHILE EDGE RUNS, and Edge runs as ~14 processes. Opening
//      it directly fails or reads a partial page. So it is COPIED first and the copy is
//      read read-only — the standard approach, and the reason this works without asking
//      you to close the browser.
//
//   2. TIMESTAMPS ARE WINDOWS FILETIME, microseconds since 1601-01-01. A raw value is about
//      1.34e16, which is larger than Number.MAX_SAFE_INTEGER, and node:sqlite throws
//      ERR_OUT_OF_RANGE rather than silently rounding. The conversion to unix seconds is
//      therefore done IN SQL, so the oversized number never reaches JavaScript at all.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('import');
require('../server/routes/browsing');    // ensures the table exists via its migration

const DRY = process.argv.includes('--dry');

const SOURCES = [
  ['edge', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'History')],
  ['chrome', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History')],
];

// Chromium epoch offset: seconds between 1601-01-01 and 1970-01-01.
const EPOCH = 11644473600;
const UNIX = `(last_visit_time/1000000 - ${EPOCH})`;
const VISIT_UNIX = `(v.visit_time/1000000 - ${EPOCH})`;

// Domain out of a URL, in SQL, so no URL is ever selected into this process.
//
// TAKES A QUALIFIER, AND THAT IS NOT TIDINESS. M346.
//
// This was a bare `url`, which is unambiguous in `FROM urls` and AMBIGUOUS the
// moment a query joins `visits`, because Chromium's `visits` table also has a
// column called `url` -- an INTEGER foreign key, not the text. SQLite refuses the
// join with "ambiguous column name: url" AT PREPARE TIME.
//
// That is what has kept browsing_domain_days empty since 20 Aug. The daily query
// added in 033f1e0 has never returned a row because it has never been prepared,
// and the importer has not been run since: every browsing_domains row still
// carries imported_at 2026-08-18 01:38:27, from the version before the daily
// query existed.
//
// The failure is worse than an empty table, and it is still latent. The throw
// happens before the transaction opens, so running the importer today writes
// NOTHING -- it would not merely fail to fill browsing_domain_days, it would
// abandon the browsing_domains refresh too. The commit that introduced it is
// titled "commit working block".
const domainExpr = (q = '') => `
  CASE WHEN instr(substr(${q}url, instr(${q}url,'://')+3), '/') > 0
       THEN substr(substr(${q}url, instr(${q}url,'://')+3), 1, instr(substr(${q}url, instr(${q}url,'://')+3), '/')-1)
       ELSE substr(${q}url, instr(${q}url,'://')+3) END`;
const DOMAIN = domainExpr();        // FROM urls -- one table, no qualifier needed
const DOMAIN_U = domainExpr('u.');  // FROM visits v JOIN urls u -- MUST be qualified

function readSource(label, file) {
  if (!fs.existsSync(file)) return { label, present: false, rows: [], dailyRows: [] };

  // Copy first — the live file is locked by the running browser.
  const tmp = path.join(os.tmpdir(), `mc-history-${label}-${process.pid}.db`);
  fs.copyFileSync(file, tmp);

  try {
    const src = new DatabaseSync(tmp, { readOnly: true });
    const rows = src.prepare(`
      SELECT ${DOMAIN} AS domain,
             SUM(visit_count) AS visits,
             COUNT(*)         AS pages,
             date(MIN(${UNIX}), 'unixepoch') AS first_seen,
             date(MAX(${UNIX}), 'unixepoch') AS last_seen
        FROM urls
       WHERE url LIKE 'http%' AND last_visit_time > 0
       GROUP BY domain
       HAVING domain <> ''
       ORDER BY visits DESC`).all();
    // visits is the Chromium visit table, rather than url.visit_count: the latter is a
    // current counter, while this preserves the day each visit occurred. DOMAIN stays in
    // SQL, so a URL never crosses into JavaScript or the Mission Control database.
    const dailyRows = src.prepare(`
      SELECT ${DOMAIN_U} AS domain,
             date(${VISIT_UNIX}, 'unixepoch') AS day,
             COUNT(*) AS visits,
             COUNT(DISTINCT u.id) AS pages
        FROM visits v
        JOIN urls u ON u.id = v.url
       WHERE u.url LIKE 'http%' AND v.visit_time > 0
       GROUP BY domain, day
      HAVING domain <> '' AND day IS NOT NULL
       ORDER BY day ASC, domain ASC`).all();
    src.close();
    return { label, present: true, rows, dailyRows };
  } finally {
    // The copy holds the same private data as the original. Remove it even if the read threw.
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

function main() {
  const found = SOURCES.map(([label, file]) => readSource(label, file));
  const present = found.filter((f) => f.present);

  if (!present.length) {
    // Absence and failure must look different: no browser installed is not a broken import.
    console.error('No browser history found. Looked for:');
    for (const [, file] of SOURCES) console.error(`  ${file}`);
    process.exit(1);
  }

  for (const f of found) {
    if (!f.present) { console.log(`  ${f.label.padEnd(7)} not installed`); continue; }
    console.log(`  ${f.label.padEnd(7)} ${f.rows.length} domains, ${f.rows.reduce((s, r) => s + r.visits, 0)} visits, ${f.dailyRows.length} daily domain rows`);
  }

  const all = present.flatMap((f) => f.rows.map((r) => ({ ...r, source: f.label })));
  const daily = present.flatMap((f) => f.dailyRows.map((r) => ({ ...r, source: f.label })));

  if (DRY) {
    console.log('\n--dry: nothing written. Top 12 by visits:\n');
    for (const r of all.sort((a, b) => b.visits - a.visits).slice(0, 12)) {
      console.log(`  ${String(r.visits).padStart(6)} visits  ${String(r.pages).padStart(5)} pages  ${r.first_seen} -> ${r.last_seen}  ${r.domain}`);
    }
    return;
  }

  const ins = db.prepare(`
    INSERT INTO browsing_domains (domain, visits, pages, first_seen, last_seen, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      visits = excluded.visits, pages = excluded.pages,
      first_seen = MIN(browsing_domains.first_seen, excluded.first_seen),
      last_seen = MAX(browsing_domains.last_seen, excluded.last_seen),
      imported_at = datetime('now','localtime')`);
  const dailyIns = db.prepare(`
    INSERT INTO browsing_domain_days (source, domain, day, visits, pages)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, domain, day) DO UPDATE SET
      visits = excluded.visits, pages = excluded.pages,
      imported_at = datetime('now','localtime')`);

  db.exec('BEGIN');
  try {
    for (const r of all) ins.run(r.domain, r.visits, r.pages, r.first_seen, r.last_seen, r.source);
    for (const r of daily) dailyIns.run(r.source, r.domain, r.day, r.visits, r.pages);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('import failed, nothing written:', err.message);
    process.exit(1);
  }

  const n = db.prepare('SELECT COUNT(*) c, SUM(visits) v FROM browsing_domains').get();
  console.log(`\nimported: ${n.c} domains, ${n.v} visits total.`);
  console.log(`daily trend data: ${daily.length} source/domain/day rows.`);
  console.log('Domains and counts only — no URLs and no page titles were read into the database.');
}

main();
