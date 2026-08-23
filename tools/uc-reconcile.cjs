#!/usr/bin/env node
'use strict';
//
// uc-reconcile.cjs — check figures read off the Universal Credit statements against the bank
// ledger, so a misread digit fails loudly instead of entering the dashboard as a plausible
// number.
//
// WHY THIS EXISTS. The UC statements carry no text layer — every glyph is a filled vector
// path — so the only way to the figures is to render each page and READ it. That is accurate
// but it is not verifiable on its own, and a money figure nobody can check is exactly the
// unauditable number this project refuses elsewhere. The bank ledger is an INDEPENDENT
// record of the same event: whatever the statement says it paid must equal what actually
// landed. Two sources, one fact, and they were produced by different systems.
//
// WHAT IT CHECKS, per statement: the statement's own arithmetic (entitlement minus deductions
// equals the total payment), and the total payment against the sum of the matching UC credits
// in the ledger.
//
// DATES DO NOT MATCH EXACTLY and must not be required to. The statement names the date DWP
// released the payment; the ledger records the date the bank posted it, typically a day or
// two earlier or later. So credits are matched within a window and the window is stated. A
// reconciliation that demanded an exact date would fail on every row and prove nothing.
//
// Usage:
//   node tools/uc-reconcile.cjs <parsed.jsonl>
//   node tools/uc-reconcile.cjs <parsed.jsonl> --window 8

require('./_run-log.cjs').record();
const fs = require('node:fs');
const db = require('../server/db');
db.setProcessActor('claude');

const file = process.argv[2];
if (!file) { console.error('usage: uc-reconcile.cjs <parsed.jsonl> [--window N]'); process.exit(2); }
const wi = process.argv.indexOf('--window');
const WINDOW = wi === -1 ? 6 : Number(process.argv[wi + 1]);

const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// Every UC credit in the ledger, as pence. PIP is excluded: it is a different benefit and
// including it would let a UC statement reconcile against a payment it has no claim on.
const credits = db.prepare(`
  SELECT date, amount_pence, counterparty FROM finance_transactions
  WHERE category = 'Benefits' AND upper(counterparty) LIKE '%DWP UC%'
  ORDER BY date`).all();
const ledgerEnd = db.prepare('SELECT MAX(date) d FROM finance_transactions').get().d;

const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
const p = (n) => Math.round(Number(n) * 100);
const money = (pence) => `£${(pence / 100).toFixed(2)}`;

let arithOk = 0, arithBad = 0, recOk = 0, recBad = 0, future = 0, noData = 0;
const problems = [];
const used = new Set();

for (const r of rows) {
  // ---- 1. the statement's own arithmetic
  //
  // Both sides are ARRAYS of labelled lines, not a fixed set of fields. The first version of
  // this used named columns (advance, child maintenance, landlord) and would have silently
  // dropped 'Tax Credits recovery' the moment it appeared in July 2025 — the components
  // would then have summed short, and the mismatch would have been blamed on a misread
  // figure rather than on a category the schema could not hold. A total that omits a line it
  // never had a slot for is the worst kind of wrong: self-consistent and quiet.
  const sum = (list) => (list || []).reduce((a, x) => a + p(x.amount), 0);
  const entitlement = sum(r.entitlement_lines);
  const deductions = sum(r.deduction_lines);
  const derived = entitlement - deductions;
  const entOk = entitlement === p(r.total_entitlement);
  const dedOk = deductions === p(r.total_deductions);
  const payOk = derived === p(r.total_payment);
  if (entOk && dedOk && payOk) arithOk++;
  else {
    arithBad++;
    problems.push(`${r.file}  ARITHMETIC`
      + (entOk ? '' : `\n    entitlement: components ${money(entitlement)} vs stated ${money(p(r.total_entitlement))}`)
      + (dedOk ? '' : `\n    deductions:  components ${money(deductions)} vs stated ${money(p(r.total_deductions))}`)
      + (payOk ? '' : `\n    payment:     ${money(entitlement)} - ${money(deductions)} = ${money(derived)} vs stated ${money(p(r.total_payment))}`));
  }

  // ---- 2. against the ledger
  const paid = r.paid || [];
  if (paid.every((x) => x.date > ledgerEnd)) { future++; continue; }

  let matchedPence = 0;
  const matches = [];
  let missing = 0;
  for (const inst of paid) {
    // Nearest unused UC credit within the window.
    let best = null;
    for (let i = 0; i < credits.length; i++) {
      if (used.has(i)) continue;
      const d = days(credits[i].date, inst.date);
      if (d <= WINDOW && (!best || d < best.d)) best = { i, d, row: credits[i] };
    }
    if (!best) { missing++; continue; }
    used.add(best.i);
    matchedPence += best.row.amount_pence;
    matches.push(`${best.row.date} ${money(best.row.amount_pence)}`);
  }

  if (missing === paid.length) { noData++; continue; }
  if (matchedPence === p(r.total_payment)) recOk++;
  else {
    recBad++;
    problems.push(`${r.file}  LEDGER`
      + `\n    statement total ${money(p(r.total_payment))} vs ledger ${money(matchedPence)}`
      + `\n    matched: ${matches.join(' + ') || '(none)'}${missing ? `  [${missing} instalment(s) had no credit within ${WINDOW} days]` : ''}`);
  }
}

console.log(`statements read      : ${rows.length}`);
console.log(`ledger UC credits    : ${credits.length}   ledger ends ${ledgerEnd}`);
console.log(`match window         : ±${WINDOW} days\n`);
console.log(`internal arithmetic  : ${arithOk} agree, ${arithBad} disagree`);
console.log(`against the ledger   : ${recOk} agree, ${recBad} disagree`);
console.log(`not yet payable      : ${future}  (both instalments fall after the ledger ends)`);
console.log(`no matching credit   : ${noData}  (looked, found nothing in window — not the same as disagreeing)`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n`);
  problems.forEach((t) => console.log('  ' + t + '\n'));
} else {
  console.log('\nEvery statement that could be checked agrees with the bank.');
}
process.exitCode = (arithBad || recBad) ? 1 : 0;
