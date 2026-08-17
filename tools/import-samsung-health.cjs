// Samsung Health import.
//
//   node tools/import-samsung-health.cjs --inspect <folder>   describe the export, write nothing
//   node tools/import-samsung-health.cjs --import  <folder>   import using the mapping below
//
// ------------------------------------------------------------------------------------
// MAPPING VERIFIED against a real export, 17 Aug 2026 (54 files, 2026-06-11 onward).
// The first version of this file was written from a remembered format and was wrong in
// four ways, each of which would have produced a plausible wrong number:
//
//  1. STEPS. com.samsung.shealth.step_daily_trend carries THREE rows per day — phone,
//     watch, and a reconciled total (source_type -2 / 0 / 112). Summing them gives 4,009
//     for a day that was 1,557: a 2.6x overcount that looks like a good day's walking.
//     com.samsung.shealth.activity.day_summary has exactly one row per day (95 rows,
//     95 days) and agrees with the reconciled figure. That is the source used.
//
//  2. SLEEP. sleep_duration is MINUTES — confirmed against a record's own start and end
//     times (23:09 -> 06:52 = 463, and the column says 463). No unit conversion is needed
//     and the earlier "if it looks big, divide by 60000" guess is gone. But 31 of 50
//     dates carry more than one record, because Samsung logs naps and split nights
//     separately, so records are SUMMED per date.
//
//  3. HEART RATE. There is no resting heart rate in this export. There are ~20 spot
//     readings a day. Calling the daily minimum "resting HR" would be inventing a
//     clinical measure, so the metrics are named hr_min and hr_median for what they are.
//
//  4. WEIGHT. There is no weight file in the export at all. Weight stays manual-only.
//
// Matching is on the EXACT data type, not a prefix: "com.samsung.shealth.sleep" as a
// prefix also matches sleep_combined, sleep_goal, sleep_raw_data and sleep_snoring — and
// --inspect duly offered to import snoring milliseconds as sleep minutes.
// ------------------------------------------------------------------------------------
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db');
require('../server/routes/health');

// type          the exact data type, i.e. the filename with the timestamp and .csv removed
// aggregate     how multiple rows for one date become one value
const WANTED = [
  {
    type: 'com.samsung.shealth.activity.day_summary',
    metric: 'steps', valueColumn: 'step_count', dateColumn: 'day_time',
    aggregate: 'first',   // already one row per day; 'first' asserts that rather than hiding a dupe
    note: 'one row per day, reconciled across devices',
  },
  {
    type: 'com.samsung.shealth.sleep',
    metric: 'sleep_minutes', valueColumn: 'sleep_duration',
    dateColumn: 'com.samsung.health.sleep.start_time',
    aggregate: 'sum',
    note: 'minutes; naps and split nights summed per start date',
  },
  {
    type: 'com.samsung.shealth.tracker.heart_rate',
    metric: 'hr_min', valueColumn: 'com.samsung.health.heart_rate.heart_rate',
    dateColumn: 'com.samsung.health.heart_rate.start_time',
    aggregate: 'min',
    note: 'lowest spot reading that day — NOT a resting heart rate',
  },
  {
    type: 'com.samsung.shealth.tracker.heart_rate',
    metric: 'hr_median', valueColumn: 'com.samsung.health.heart_rate.heart_rate',
    dateColumn: 'com.samsung.health.heart_rate.start_time',
    aggregate: 'median',
    note: 'median spot reading that day',
  },
];

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Samsung writes a metadata line above the column header. Line 2 is the header in every
// one of the 54 files in the verified export, but it is located rather than assumed: the
// header is the row containing the column we need.
function findHeader(rows, want) {
  const targets = [want.valueColumn.toLowerCase(), want.dateColumn.toLowerCase()];
  for (let i = 0; i < Math.min(6, rows.length); i += 1) {
    const cols = rows[i].map((c) => c.trim().replace(/^﻿/, ''));
    if (cols.some((c) => targets.includes(c.toLowerCase()))) return { index: i, columns: cols };
  }
  return null;
}

// Exact type match. The timestamp and extension are stripped; nothing is matched by prefix.
function fileFor(dir, files, type) {
  const hit = files.find((f) => f.replace(/\.\d{14}\.csv$/, '') === type);
  return hit ? path.join(dir, hit) : null;
}

function readMapped(dir, files, want) {
  const file = fileFor(dir, files, want.type);
  if (!file) return { want, error: 'no file of that exact data type in the export' };

  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const head = findHeader(rows, want);
  if (!head) return { want, file, error: `no header row contains ${want.valueColumn} or ${want.dateColumn}` };

  const vi = head.columns.indexOf(want.valueColumn);
  const di = head.columns.indexOf(want.dateColumn);
  if (vi < 0) return { want, file, error: `value column "${want.valueColumn}" not in header` };
  if (di < 0) return { want, file, error: `date column "${want.dateColumn}" not in header` };

  const byDate = new Map();
  let skipped = 0;
  for (let i = head.index + 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.length <= Math.max(vi, di)) { skipped += 1; continue; }
    const date = String(r[di] || '').slice(0, 10);
    const v = Number(String(r[vi]).trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(v)) { skipped += 1; continue; }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(v);
  }

  const values = new Map();
  let collisions = 0;
  for (const [date, vs] of byDate) {
    let out;
    if (want.aggregate === 'sum') out = vs.reduce((a, b) => a + b, 0);
    else if (want.aggregate === 'min') out = Math.min(...vs);
    else if (want.aggregate === 'median') { const s = [...vs].sort((a, b) => a - b); out = s[Math.floor(s.length / 2)]; }
    else { out = vs[0]; if (vs.length > 1) collisions += 1; }   // 'first'
    values.set(date, Math.round(out));
  }

  return { want, file, values, skipped, collisions, rowsRead: rows.length - head.index - 1 };
}

function inspect(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv')); }
  catch (err) {
    console.error(`Cannot read ${dir}: ${err.message}`);
    console.error('Point this at the UNZIPPED Samsung Health export folder.');
    process.exit(2);
  }

  console.log(`folder     ${dir}`);
  console.log(`csv files  ${files.length}\n`);

  const ok = [];
  for (const want of WANTED) {
    const r = readMapped(dir, files, want);
    if (r.error) {
      console.log(`  FAIL  ${want.metric.padEnd(14)} ${want.type}`);
      console.log(`        ${r.error}`);
      continue;
    }
    const dates = [...r.values.keys()].sort();
    const vals = [...r.values.values()].sort((a, b) => a - b);
    console.log(`  OK    ${want.metric.padEnd(14)} ${dates.length} days  ${dates[0]}..${dates[dates.length - 1]}`);
    console.log(`        ${want.aggregate} of ${r.rowsRead} rows · min ${vals[0]} median ${vals[Math.floor(vals.length / 2)]} max ${vals[vals.length - 1]}`);
    console.log(`        ${want.note}`);
    // A filter must report its residue.
    if (r.skipped) console.log(`        skipped ${r.skipped} rows with an unusable date or value`);
    if (r.collisions) console.log(`        WARNING: ${r.collisions} dates had more than one row but aggregate is 'first' — the extras were DROPPED`);
    ok.push(r);
  }

  console.log(`\nimportable: ${ok.length} of ${WANTED.length} metrics`);
  return ok;
}

function doImport(dir) {
  const ready = inspect(dir);
  if (!ready.length) { console.error('\nNothing importable.'); process.exit(1); }

  // A hand-entered value is never overwritten by an import — same precedence as the ledger.
  const ins = db.prepare(
    `INSERT INTO health_metrics (date, metric, value, source) VALUES (?, ?, ?, 'samsung')
     ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value, source = 'samsung',
       recorded_at = datetime('now','localtime')
     WHERE health_metrics.source <> 'manual'`
  );

  let written = 0;
  db.exec('BEGIN');
  try {
    for (const r of ready) {
      for (const [date, value] of r.values) { ins.run(date, r.want.metric, value); written += 1; }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('IMPORT FAILED, rolled back:', err.message);
    process.exit(1);
  }
  console.log(`\nwritten ${written} daily values`);
}

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: node tools/import-samsung-health.cjs --inspect|--import <folder>');
  process.exit(2);
}
if (args.includes('--import')) doImport(dir);
else inspect(dir);
