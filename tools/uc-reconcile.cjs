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
// How far AFTER the last stated instalment a corrected top-up may still arrive. Feb 2024 was
// corrected on 4 March and topped up on 6 March, nine days after its stated pay date.
const FORWARD = 20;

// Chronological, because the window clamp below needs to know the NEXT statement's first
// instalment. Fed an unsorted file, the clamp would compare against an arbitrary neighbour.
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  .sort((a, b) => a.ap_end.localeCompare(b.ap_end));

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

for (let idx = 0; idx < rows.length; idx++) {
  const r = rows[idx];
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
  // A payment cannot be negative. When the Minimum Income Floor applies, deductions exceed
  // the whole entitlement — July and August 2023 deduct £775.99 from a £368.74 award — and
  // the statement pays £0 rather than a negative figure. Comparing the raw subtraction would
  // report those as arithmetic failures, which is a checker crying wolf at correct data.
  const derived = Math.max(0, entitlement - deductions);
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
  //
  // Claim EVERY unclaimed credit in this statement's window, not one per stated instalment.
  // The one-credit-per-instalment rule produced a false alarm on the Feb 2024 statement: it
  // was corrected on 4 March and the missing housing element was paid as a separate £598.51
  // top-up on 6 March, so the period really was paid in full — as £277.03 + £598.51 — and
  // the matcher reported a £598.51 shortfall because it stopped after the first credit. A
  // corrected award arrives as a top-up weeks later, so the window has to be able to hold
  // more than one payment.
  //
  // The window runs from just before the first stated instalment to well after the last,
  // but is CLAMPED to end before the next statement's first instalment. Without that clamp
  // a generous forward window would swallow the following period's payment and turn a real
  // shortfall into an apparent match — failing in the flattering direction, which is the
  // one that never gets investigated.
  const paid = r.paid || [];
  if (paid.every((x) => x.date > ledgerEnd)) { future++; continue; }

  // One nearest credit per stated instalment, within ±WINDOW days.
  let matchedPence = 0;
  const matches = [];
  for (const inst of paid) {
    let best = null;
    for (let i = 0; i < credits.length; i++) {
      if (used.has(i)) continue;
      const d = days(credits[i].date, inst.date);
      if (d <= WINDOW && (!best || d < best.d)) best = { i, d };
    }
    if (!best) continue;
    used.add(best.i);
    matchedPence += credits[best.i].amount_pence;
    matches.push(`${credits[best.i].date} ${money(credits[best.i].amount_pence)}`);
  }

  // A CORRECTED statement is topped up separately, weeks later. Feb 2024 was corrected on
  // 4 March and the missing £598.51 housing element arrived on 6 March as its own credit.
  // So if the period is short, look forward for a single unclaimed credit that closes the
  // gap EXACTLY, bounded by the next statement's first instalment.
  //
  // Exactly, and one credit — not "any credits in a wide window". The greedy version of
  // this was worse than the bug: it claimed neighbouring periods' payments and turned 21
  // agreements into 7. A rule that only fires when it fully explains the difference cannot
  // manufacture a match out of unrelated money.
  const shortfall = p(r.total_payment) - matchedPence;
  if (shortfall > 0 && paid.length) {
    const lastPaid = new Date(paid.map((x) => x.date).sort().slice(-1)[0]);
    let limit = new Date(lastPaid.getTime() + FORWARD * 86400000);
    const next = rows[idx + 1];
    if (next && next.paid && next.paid.length) {
      const clamp = new Date(new Date(next.paid.map((x) => x.date).sort()[0]).getTime() - 86400000);
      if (clamp < limit) limit = clamp;
    }
    for (let i = 0; i < credits.length; i++) {
      if (used.has(i)) continue;
      const d = new Date(credits[i].date);
      if (d <= lastPaid || d > limit) continue;
      if (credits[i].amount_pence !== shortfall) continue;
      used.add(i);
      matchedPence += credits[i].amount_pence;
      matches.push(`${credits[i].date} ${money(credits[i].amount_pence)} (top-up)`);
      break;
    }
  }

  if (!matches.length) { noData++; continue; }
  if (matchedPence === p(r.total_payment)) recOk++;
  else {
    recBad++;
    problems.push(`${r.file}  LEDGER`
      + `\n    statement total ${money(p(r.total_payment))} vs ledger ${money(matchedPence)}`
      + `\n    matched: ${matches.join(' + ') || '(none)'}`
      + (r.corrected_on ? `\n    NOTE: this statement was corrected on ${r.corrected_on} — it describes the entitlement as finally assessed, which is not necessarily what was paid at the time.` : ''));
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
