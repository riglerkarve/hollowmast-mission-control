#!/usr/bin/env node
//
// import-paypal.cjs — PayPal activity CSV into the finance ledger.
//
//   node tools/import-paypal.cjs <file-or-dir> --account paypal --label "PayPal" --kind personal
//   node tools/import-paypal.cjs <file-or-dir> --account paypal --dry
//
// WHY THIS EXISTS. The bank only ever sees a line reading "PAYPAL". At that layer a SerpClix
// payout and a shop refund are the same string, so the rule that categorises them has to guess,
// and it guessed "Refunds" for 54 credits totalling £648.46 across five years, none of which a
// human has ever reviewed (backlog M67). PayPal's own export carries the SENDER, which is the
// only place that distinction exists. Backlog #72.
//
// THE DOUBLE-COUNTING TRAP, and it is the reason this file is careful rather than short.
// A withdrawal from PayPal to the bank is ONE movement of money that appears TWICE: once here
// as a withdrawal, and once in the Starling statement as a PAYPAL credit. Importing both as
// income counts the same pounds twice and silently inflates every total downstream. So
// withdrawals are imported and categorised 'Own transfer', which is the category the ledger
// already uses for money moving between the owner's own accounts. They are recorded because
// omitting them would leave the PayPal balance unexplainable, not because they are income.
//
// CURRENCY IS NEVER CONVERTED. PrintProfit sells in USD and the ledger is in pence. A rate
// invented here would be a number nobody can audit and it would be wrong by the time anyone
// read it. Non-GBP rows are imported with their currency recorded and are EXCLUDED from the
// GBP totals this prints; converting them is a separate, deliberate decision.
//
// ONLY 'Completed' ROWS COUNT. Pending, Denied and Reversed rows describe money that did not
// move. They are skipped and counted in the residue, never silently dropped.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
require('../server/routes/finance');   // for its migrations

// ---- CSV, quoted-field aware. PayPal descriptions contain commas routinely. ---------------
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
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const money = (s) => {
  const clean = String(s || '').replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (!clean || clean === '-') return null;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

// PayPal exports dd/mm/yyyy in UK locale. Ambiguous with mm/dd/yyyy, so this REFUSES rather
// than guessing when a file contains no day above 12 to disambiguate with.
function dateShape(rows, idx) {
  let sawHighFirst = false, sawHighSecond = false;
  for (const r of rows) {
    const m = String(r[idx] || '').match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) sawHighFirst = true;
    if (Number(m[2]) > 12) sawHighSecond = true;
  }
  if (sawHighFirst && !sawHighSecond) return 'dmy';
  if (sawHighSecond && !sawHighFirst) return 'mdy';
  return null;
}

function toIso(s, shape) {
  const m = String(s || '').match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!m) return null;
  const a = m[1].padStart(2, '0'), b = m[2].padStart(2, '0');
  return shape === 'mdy' ? `${m[3]}-${a}-${b}` : `${m[3]}-${b}-${a}`;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const dry = args.includes('--dry');
  const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--account'
    && args[args.indexOf(a) - 1] !== '--label' && args[args.indexOf(a) - 1] !== '--kind');
  const accountId = flag('account');

  if (!target || !accountId) {
    console.error('  usage: node tools/import-paypal.cjs <file-or-dir> --account paypal [--label "PayPal"] [--kind personal] [--dry]');
    console.error('  --account is required and never inferred: a filename cannot identify an account.');
    process.exit(2);
  }

  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith('.csv')).map((f) => path.join(target, f))
    : [target];
  if (!files.length) { console.error(`  no .csv found at ${target}`); process.exit(2); }

  if (!dry) {
    db.prepare('INSERT INTO finance_accounts (id, label, kind) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(accountId, flag('label', 'PayPal'), flag('kind', 'personal'));
  }

  const stmt = db.prepare(`
    INSERT INTO finance_transactions
      (account_id, import_key, date, counterparty, reference, type, amount_pence, bank_category,
       category, category_source, reviewed, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paypal-import', 0, datetime('now'))
    ON CONFLICT(import_key) DO UPDATE SET
      date = excluded.date, counterparty = excluded.counterparty, reference = excluded.reference,
      amount_pence = excluded.amount_pence, bank_category = excluded.bank_category`);

  let imported = 0, updated = 0;
  const skipped = { notCompleted: 0, noDate: 0, noAmount: 0, nonGbp: 0 };
  const senders = new Map();
  let gbpIn = 0, gbpOut = 0, transfers = 0;

  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    if (rows.length < 2) { console.log(`  ${path.basename(file)}: no data rows`); continue; }

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
    const iDate = col('date');
    const iName = col('name', 'from email address', 'counterparty');
    const iType = col('type', 'transaction type');
    const iStatus = col('status');
    const iCur = col('currency');
    const iNet = col('net');
    const iGross = col('gross');
    const iFee = col('fee');
    const iId = col('transaction id', 'transaction reference id');

    // A header that is not what we expect must stop the import and SAY SO. Guessing column
    // positions on a changed export is how a file imports cleanly with wrong amounts.
    const missing = [];
    if (iDate < 0) missing.push('Date');
    if (iStatus < 0) missing.push('Status');
    if (iNet < 0 && iGross < 0) missing.push('Net or Gross');
    if (iId < 0) missing.push('Transaction ID');
    if (missing.length) {
      console.error(`  ${path.basename(file)}: missing column(s): ${missing.join(', ')}`);
      console.error(`  header seen: ${rows[0].join(' | ').slice(0, 200)}`);
      console.error('  Not importing. A guessed column mapping produces wrong amounts, not an error.');
      process.exit(1);
    }

    const body = rows.slice(1);
    const shape = dateShape(body, iDate);
    if (!shape) {
      console.error(`  ${path.basename(file)}: cannot tell dd/mm from mm/dd — no row has a day above 12.`);
      console.error('  Refusing rather than guessing: half the dates would be silently wrong.');
      process.exit(1);
    }

    for (const r of body) {
      const status = String(r[iStatus] || '').trim().toLowerCase();
      if (status && status !== 'completed') { skipped.notCompleted += 1; continue; }

      const iso = toIso(r[iDate], shape);
      if (!iso) { skipped.noDate += 1; continue; }

      const cur = (iCur >= 0 ? String(r[iCur] || '').trim().toUpperCase() : 'GBP') || 'GBP';
      const net = money(iNet >= 0 ? r[iNet] : r[iGross]);
      if (net === null) { skipped.noAmount += 1; continue; }
      if (cur !== 'GBP') skipped.nonGbp += 1;

      const name = String(iName >= 0 ? r[iName] : '').trim() || '(no name given)';
      const type = String(iType >= 0 ? r[iType] : '').trim();
      const fee = iFee >= 0 ? money(r[iFee]) : null;
      const key = `paypal:${String(r[iId] || '').trim()}`;

      // A withdrawal to the bank is the SAME money as the Starling PAYPAL credit. Categorised
      // as a transfer so it can never be counted as income twice.
      const isWithdrawal = /withdraw|transfer to bank|general withdrawal/i.test(type);
      const category = isWithdrawal ? 'Own transfer' : null;

      const ref = [type, cur !== 'GBP' ? `${cur} ${(net / 100).toFixed(2)}` : null,
        fee ? `fee ${(fee / 100).toFixed(2)}` : null].filter(Boolean).join(' · ');

      if (!dry) {
        const before = db.prepare('SELECT 1 FROM finance_transactions WHERE import_key = ?').get(key);
        stmt.run(accountId, key, iso, name, ref, type || null, net, type || null, category);
        if (before) updated += 1; else imported += 1;
      } else if (!db.prepare('SELECT 1 FROM finance_transactions WHERE import_key = ?').get(key)) imported += 1;
      else updated += 1;

      if (cur === 'GBP') {
        if (isWithdrawal) transfers += net;
        else if (net > 0) gbpIn += net;
        else gbpOut += net;
      }
      if (net > 0 && !isWithdrawal && cur === 'GBP') {
        senders.set(name, (senders.get(name) || 0) + net);
      }
    }
  }

  const gbp = (p) => `£${(p / 100).toFixed(2)}`;
  console.log(`\n  ${dry ? 'WOULD IMPORT' : 'imported'} ${imported} new, ${updated} already held`);
  console.log(`  GBP in (excluding transfers): ${gbp(gbpIn)}   out: ${gbp(gbpOut)}   withdrawals to bank: ${gbp(transfers)}`);

  // A filter must report its residue.
  const dropped = Object.entries(skipped).filter(([, n]) => n);
  if (dropped.length) {
    console.log('\n  Rows not counted as GBP income, and why:');
    for (const [k, n] of dropped) console.log(`    ${k}: ${n}`);
  }

  if (senders.size) {
    console.log('\n  Who actually paid you (GBP, excluding transfers):');
    [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .forEach(([n, p]) => console.log(`    ${gbp(p).padStart(10)}  ${n}`));
  }

  console.log('\n  Withdrawals are categorised "Own transfer" so the same money is not counted');
  console.log('  twice: each one is already in the bank as a PAYPAL credit.');
  console.log('  Non-GBP rows are stored but never converted — no rate is invented here.');
}

main();
