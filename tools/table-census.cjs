#!/usr/bin/env node
'use strict';
//
// table-census.cjs — for every table: how many rows, who reads it, who writes it,
// and which of the five reasons an empty one is empty.
//
// WHY THIS EXISTS
//
// On 23 Aug 2026 two sessions argued for a day about which of Mission Control's
// 19 empty tables were dead. Both of us held the rule that a row count cannot
// justify deleting anything. Both of us then agreed on exactly one deletion --
// `browsing_news_*` -- on exactly a row count, and neither checked whether
// anything read them. They had a panel, a route, an importer and a test. The
// deletion was filed and withdrawn one message before it happened.
//
// The lesson is not "check readers". It is that AGREEMENT IS WHERE THE CHECK
// GETS SKIPPED: we had just finished arguing, so the one thing we concurred on
// was the one thing neither of us examined. A tool does not get tired of
// agreeing with itself, which is the only reason to write this down rather than
// remember it.
//
// AN EMPTY TABLE HAS AT LEAST FIVE CAUSES AND THEY NEED OPPOSITE RESPONSES.
// A row count distinguishes none of them:
//
//   NEVER NEEDED         gate_attempts 0 -- nobody was ever locked out. GOOD NEWS.
//   NO WRITE PATH        team_arbitrations -- schema exists, no INSERT anywhere.
//   WRONG SHAPE          lifestyle_intake 0 beside foods 25 / chores 16 in the
//                        SAME module: the recurring half of a live feature.
//   BUILT, TESTED, NEVER RUN   browsing_news_* -- complete CRUD, a test asserts
//                        on it, no row has ever arrived.
//   GENUINELY UNWANTED   no confirmed member. That is the finding.
//
// USAGE
//   node tools/table-census.cjs                 every table
//   node tools/table-census.cjs --empty         only tables with 0 rows
//   node tools/table-census.cjs browsing_news   tables matching a substring
//   node tools/table-census.cjs --self-test     controls only, then exit
//
// IT REFUSES TO REPORT IF ITS OWN CONTROLS FAIL. A census whose pattern matches
// nothing returns "no readers" for everything, which reads as a spectacular
// finding and is a broken grep. That exact failure happened twice on 23 Aug --
// once a heredoc ate a backslash, once a regex required a leading slash on a
// path that is sometimes relative. Both printed a clean, confident, wrong sweep.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'reports', 'backups']);
const EXT = /\.(js|cjs|mjs|ts|ps1|py|html|sql)$/i;

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    // EXCLUDE THIS FILE. The comments above name half a dozen tables as
    // examples, so without this the census counts itself as a reader of every
    // table it discusses -- and it did: the first run reported
    // `team_arbitrations` as having a reader, which was this file's own header.
    // An instrument that appears in its own measurement is the shape it exists
    // to catch, one level up.
    else if (EXT.test(e.name) && p !== __filename) out.push(p);
  }
  return out;
}

// A reference is SCHEMA if it only creates or alters the table. Those do not
// keep a table alive -- they are what makes an unused table look used.
const SCHEMA_RE = /CREATE\s+(TABLE|INDEX|UNIQUE)|ALTER\s+TABLE|DROP\s+TABLE|addColumn/i;
const WRITE_RE = /\bINSERT\s+(OR\s+\w+\s+)?INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b/i;

// A READER IS NOT EVIDENCE OF DEMAND, AND THIS DISTINCTION COST A WRONG
// CONCLUSION THE HOUR THIS TOOL SHIPPED.
//
// The census reported `team_arbitrations` as having readers, and I wrote "so
// something already expects rows there -- build the route". The reader was
// `tools/verify-liveness-rule.cjs:291`:
//
//     add('8e', 'team_arbitrations (the only true orphan)', 0,
//         () => n('SELECT count(*) c FROM team_arbitrations'), false,
//         'the one table the report says is safe to delete');
//
// The `0` is the EXPECTED value. That reader asserts the table is EMPTY and its
// own note calls it safe to delete -- the exact opposite of expecting rows. The
// count was right; the meaning I attached to it was inverted.
//
// So a reader inside a checker may be asserting ABSENCE. This tool cannot parse
// intent and does not try: it flags such readers separately and prints the line,
// because the fix for "good at counting, unreliable at what the count means" is
// to make the reader look, not to guess better.
const ASSERT_FILE_RE = /(^|\/)(tools|scripts)\/[^/]*(verify|check|test|audit|census|probe)[^/]*\.(c?js|mjs|ps1)$/i;

function scan(files, table) {
  const refs = [];
  // Word-boundary either side so `browsing_news_topics` never matches
  // `browsing_news_topics_v2`, and a substring of a longer name never counts.
  const re = new RegExp('(?<![A-Za-z0-9_])' + table + '(?![A-Za-z0-9_])');
  for (const f of files) {
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!s.includes(table)) continue;
    s.split(/\r?\n/).forEach((line, i) => {
      if (!re.test(line)) return;
      refs.push({
        file: path.relative(ROOT, f).replace(/\\/g, '/'),
        line: i + 1,
        schema: SCHEMA_RE.test(line),
        write: WRITE_RE.test(line),
        text: line.trim().slice(0, 120),
      });
    });
  }
  return refs;
}

function main() {
  const argv = process.argv.slice(2);
  const selfTest = argv.includes('--self-test');
  const emptyOnly = argv.includes('--empty');
  const filter = argv.find(a => !a.startsWith('--'));

  const files = sourceFiles(ROOT);

  // ---- controls, both directions, before any finding is printed --------------
  // POSITIVE: a table known to be referenced must come back referenced.
  // NEGATIVE: a name that cannot exist must come back at zero. Without the
  // negative, a pattern that matches everything scores every table as live.
  const POS = 'team_decisions', NEG = 'zzz_no_such_table_' + Date.now();
  const pos = scan(files, POS).length;
  const neg = scan(files, NEG).length;
  const posOk = pos > 0, negOk = neg === 0;

  console.log('table-census — ' + files.length + ' source files under ' + path.basename(ROOT) + '/');
  console.log('  control +  ' + POS + ': ' + pos + ' refs   ' + (posOk ? 'ok' : 'FAIL — pattern matches nothing'));
  console.log('  control -  <nonexistent>: ' + neg + ' refs   ' + (negOk ? 'ok' : 'FAIL — pattern matches everything'));
  if (!posOk || !negOk) {
    console.error('\n  REFUSING TO REPORT. A census with a broken pattern returns a clean sweep,');
    console.error('  which is indistinguishable from good news. Fix the controls first.');
    process.exit(2);
  }
  if (selfTest) { console.log('\n  self-test passed; no census run.'); return; }

  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(ROOT, 'data', 'dashboard.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map(r => r.name).filter(n => n !== 'sqlite_sequence');
  if (filter) tables = tables.filter(t => t.includes(filter));

  const rowsOf = t => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return -1; } };

  console.log('');
  console.log('  rows  readers  writers  asserts  table');
  console.log('  ----  -------  -------  -------  ' + '-'.repeat(30));

  const flagged = [];
  for (const t of tables) {
    const n = rowsOf(t);
    if (emptyOnly && n !== 0) continue;
    const refs = scan(files, t);
    const real = refs.filter(r => !r.schema);
    const writers = real.filter(r => r.write);
    const allReaders = real.filter(r => !r.write);
    // Split, because they mean opposite things. A consumer reader is evidence
    // the table is wanted; an assertion reader may be evidence it is not.
    const asserts = allReaders.filter(r => ASSERT_FILE_RE.test(r.file));
    const readers = allReaders.filter(r => !ASSERT_FILE_RE.test(r.file));
    console.log(
      String(n).padStart(6) + String(readers.length).padStart(9) + String(writers.length).padStart(9) +
      String(asserts.length ? asserts.length : '').padStart(8) + '  ' + t
    );
    if (n === 0) flagged.push({ t, readers: readers.length, writers: writers.length, asserts, refs: real });
  }

  if (!flagged.length) return;
  console.log('');
  console.log('  EMPTY TABLES — the cause, not the count');
  console.log('  ' + '-'.repeat(60));
  for (const f of flagged) {
    let cause;
    if (f.writers === 0 && f.readers === 0) cause = 'NO CODE AT ALL — schema only. Drop it or explain it.';
    else if (f.writers === 0) cause = 'NO WRITE PATH — readers exist, nothing can fill it. Build the writer or drop the table.';
    else cause = 'HAS A WRITER THAT HAS NEVER PRODUCED A ROW — does the write run and fail, or never run? Nothing records an attempt, so nothing can tell them apart.';
    console.log('  ' + f.t);
    console.log('    ' + cause);
    if (f.writers) f.refs.filter(r => r.write).slice(0, 3)
      .forEach(r => console.log('      writer  ' + r.file + ':' + r.line));
    if (f.readers) f.refs.filter(r => !r.write && !ASSERT_FILE_RE.test(r.file)).slice(0, 3)
      .forEach(r => console.log('      reader  ' + r.file + ':' + r.line));
    // Printed with the line, never as a bare count. An assertion reader may be
    // asserting the table stays EMPTY, in which case it is evidence against the
    // table rather than for it -- and it will FAIL the day the table is used.
    if (f.asserts.length) {
      console.log('      ASSERTION READER(S) — read the line before treating these as demand:');
      f.asserts.slice(0, 3).forEach(r => console.log('        ' + r.file + ':' + r.line + '  ' + r.text));
      console.log('        if one expects 0, the first row ever written will fail it. Update it in the same change.');
    }
    console.log('');
  }
  console.log('  A table with readers is NOT a deletion candidate however empty it is.');
  console.log('  Deleting browsing_domain_days would have broken the browsing-recall panel.');
}

main();
