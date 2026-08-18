// Imports Starling CSV exports into the finance ledger.
//
//   node tools/import-starling.cjs <dir> --account <id> --label "<name>" --kind personal|business
//                                   [--suffix " (1)"] [--dry]
//
// THE FILENAME DOES NOT IDENTIFY THE ACCOUNT. Both Starling accounts export as
// StarlingStatement_YYYY-MM.csv, so the second download is only distinguishable by the
// browser's " (1)" suffix. --account is therefore required, never inferred.
//
// Idempotent: re-importing the same export updates rows rather than duplicating them,
// and never overwrites a category you set by hand.
//
// Verified against the real five-year history, 63 monthly files, 2021-06 to 2026-08:
//   4,133 rows, no gaps, one header shape throughout, no malformed rows.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('import');
require('../server/routes/finance');   // required for its migrations

const EXPECTED_HEADER = 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes';

// --- CSV -------------------------------------------------------------------------
// A real parser, even though none of the 63 current files contain a quoted field. A
// reference containing a comma would silently shift every later column, and the symptom
// would be wrong amounts rather than an error.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- money -----------------------------------------------------------------------
// Parsed from the STRING, never via parseFloat * 100. 12.34 is not representable in
// binary floating point, so `Math.round(parseFloat(s) * 100)` is right until the day a
// value lands on the wrong side of a half-penny and a five-year total drifts.
function toPence(raw) {
  const s = String(raw).trim().replace(/[^0-9.\-]/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace(/-/g, '').split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  const pence = (Number(whole || 0) * 100) + Number(`${frac}00`.slice(0, 2));
  return neg ? -pence : pence;
}

// The check that makes the above trustworthy: format it back and compare to the source.
function penceToString(p) {
  const neg = p < 0;
  const a = Math.abs(p);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

function normaliseAmountString(raw) {
  const s = String(raw).trim().replace(/[^0-9.\-]/g, '');
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace(/-/g, '').split('.');
  return `${neg ? '-' : ''}${String(Number(whole || 0))}.${`${frac}00`.slice(0, 2)}`;
}

// --- dates -----------------------------------------------------------------------
// Starling exports DD/MM/YYYY. Read as MM/DD/YYYY this silently succeeds for every day
// of the month up to the 12th and produces a ledger where a third of the dates are wrong.
function toIso(raw) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(raw).trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

// --- import ----------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--')) || 'C:/Users/jcwhi/Downloads';
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const accountId = flag('account');
  const label = flag('label', accountId);
  const kind = flag('kind', 'personal');
  const suffix = flag('suffix', '');
  const DRY = args.includes('--dry');

  if (!accountId) {
    console.error('--account is required. The filename cannot tell the two Starling accounts apart.');
    process.exit(1);
  }

  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target)
        // Exact suffix match, not a substring test: with suffix '' the personal files
        // must NOT also swallow the business set's " (1)" files, and vice versa.
        .filter((f) => f === `StarlingStatement_${f.slice(18, 25)}${suffix}.csv`
          && /^StarlingStatement_\d{4}-\d{2}/.test(f))
        .sort()
        .map((f) => path.join(target, f))
    : [target];

  if (!files.length) { console.error(`no Starling exports found in ${target}`); process.exit(1); }

  if (!DRY) {
    db.prepare(
      `INSERT INTO finance_accounts (id, label, kind) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(accountId, label, kind);
  }

  const insert = db.prepare(`
    INSERT INTO finance_transactions
      (account_id, import_key, date, counterparty, reference, type, amount_pence, balance_pence, bank_category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(import_key) DO UPDATE SET
      date = excluded.date, counterparty = excluded.counterparty, reference = excluded.reference,
      type = excluded.type, amount_pence = excluded.amount_pence, balance_pence = excluded.balance_pence,
      bank_category = excluded.bank_category
  `);

  let read = 0, written = 0;
  const problems = [];
  const before = db.prepare('SELECT COUNT(*) AS c FROM finance_transactions').get().c;

  if (!DRY) db.exec('BEGIN');
  try {
    for (const file of files) {
      const base = path.basename(file);
      const rows = parseCsv(fs.readFileSync(file, 'utf8'));
      const header = rows[0].join(',').replace(/\uFEFF/g, '').trim();

      // A changed export format must stop the import, not import wrong columns quietly.
      if (header !== EXPECTED_HEADER) {
        problems.push(`${base}: unexpected header\n    got      ${header}\n    expected ${EXPECTED_HEADER}`);
        continue;
      }

      for (let r = 1; r < rows.length; r += 1) {
        const row = rows[r];
        if (row.length === 1 && row[0].trim() === '') continue;
        if (row.length !== rows[0].length) { problems.push(`${base} row ${r}: ${row.length} columns`); continue; }

        read += 1;
        const [dateRaw, cp, ref, type, amtRaw, balRaw, bankCat] = row;

        const date = toIso(dateRaw);
        const pence = toPence(amtRaw);
        const balance = toPence(balRaw);

        if (!date) { problems.push(`${base} row ${r}: unparseable date "${dateRaw}"`); continue; }
        if (pence == null) { problems.push(`${base} row ${r}: unparseable amount "${amtRaw}"`); continue; }

        // Round-trip every amount. A conversion that is wrong for one row in 4,133 is
        // exactly the kind of thing that never surfaces until a total is questioned.
        if (penceToString(pence) !== normaliseAmountString(amtRaw)) {
          problems.push(`${base} row ${r}: amount round-trip "${amtRaw}" -> ${pence}p -> "${penceToString(pence)}"`);
          continue;
        }

        if (!DRY) {
          insert.run(accountId, `${base}:${r}`, date, cp.trim(), ref.trim(), type.trim(), pence, balance, bankCat.trim() || null);
        }
        written += 1;
      }
    }
    if (!DRY) db.exec('COMMIT');
  } catch (err) {
    if (!DRY) db.exec('ROLLBACK');
    console.error('IMPORT FAILED, rolled back:', err.message);
    process.exit(1);
  }

  const after = DRY ? before : db.prepare('SELECT COUNT(*) AS c FROM finance_transactions').get().c;
  const range = DRY ? null : db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM finance_transactions').get();

  console.log(`\nfiles        ${files.length}`);
  console.log(`rows read    ${read}`);
  console.log(`rows written ${written}${DRY ? '  (dry run, nothing written)' : ''}`);
  if (!DRY) console.log(`table        ${before} -> ${after}  (${after - before} new, ${written - (after - before)} updated in place)`);
  if (range) console.log(`date range   ${range.a} .. ${range.b}`);

  // Silence is not success. Say so either way, or a broken parser reads as a clean run.
  if (problems.length) {
    console.log(`\nPROBLEMS (${problems.length}) — these rows were NOT imported:`);
    problems.slice(0, 20).forEach((p) => console.log(`  ${p}`));
    if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
    process.exitCode = 1;
  } else {
    console.log(`\nno problems: every row parsed, and every amount round-tripped to its source string`);
  }
}

main();
