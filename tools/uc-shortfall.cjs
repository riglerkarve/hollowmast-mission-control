#!/usr/bin/env node
'use strict';
//
// uc-shortfall.cjs — for every statement whose total does not match the bank, show the gap
// and what element it equals.
//
// WHY. tools/uc-reconcile.cjs found 10 statements in 2024 where the statement total exceeds
// what the ledger received. That is not a misread: the internal arithmetic of all 32
// statements agrees exactly, and the gaps are suspiciously round — each equals a single named
// entitlement line. The likely story is retrospective correction: nine 2024 statements carry
// "The statement was corrected on 10 December 2024", and a corrected statement describes the
// entitlement as it was FINALLY assessed, not what was actually paid at the time.
//
// THIS TOOL DOES NOT CONCLUDE THAT MONEY IS OWED. It states the gap, names the element it
// matches, and lists the DWP credits that look like arrears, so the owner can ask DWP a
// specific question. Deciding that a benefit was underpaid from a bank export is exactly the
// kind of claim this project refuses to make on the owner's behalf.
//
// Usage: node tools/uc-shortfall.cjs data/uc-statements.jsonl

require('./_run-log.cjs').record();
const fs = require('node:fs');
const db = require('../server/db');
db.setProcessActor('claude');

const file = process.argv[2] || 'data/uc-statements.jsonl';
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  .sort((a, b) => a.ap_end.localeCompare(b.ap_end));

const credits = db.prepare(`
  SELECT date, amount_pence, counterparty FROM finance_transactions
  WHERE category = 'Benefits' AND upper(counterparty) LIKE '%DWP UC%'
  ORDER BY date`).all();
const ledgerEnd = db.prepare('SELECT MAX(date) d FROM finance_transactions').get().d;

const p = (n) => Math.round(Number(n) * 100);
const money = (c) => `£${(c / 100).toFixed(2)}`;
const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

// Wider window than the reconciler: a correction is topped up weeks later, not days, and the
// point here is to find the money rather than to prove a clean match.
const WINDOW = 20;
const used = new Set();
let totalGap = 0;
const gaps = [];

for (const r of rows) {
  if ((r.paid || []).every((x) => x.date > ledgerEnd)) continue;
  let got = 0;
  const matched = [];
  for (const inst of r.paid || []) {
    let best = null;
    for (let i = 0; i < credits.length; i++) {
      if (used.has(i)) continue;
      const d = days(credits[i].date, inst.date);
      if (d <= WINDOW && (!best || d < best.d)) best = { i, d };
    }
    if (best) { used.add(best.i); got += credits[best.i].amount_pence; matched.push(`${credits[best.i].date} ${money(credits[best.i].amount_pence)}`); }
  }
  const want = p(r.total_payment);
  if (got === want) continue;

  // Which single entitlement or deduction line equals the gap? Naming it is the difference
  // between "the numbers differ" and "this element was not paid".
  const gap = want - got;
  const named = [...(r.entitlement_lines || []), ...(r.deduction_lines || [])]
    .filter((l) => p(l.amount) === Math.abs(gap)).map((l) => l.label);
  totalGap += gap;
  gaps.push({ r, gap, matched, named });
}

console.log(`statements compared : ${rows.length}   window ±${WINDOW} days\n`);
for (const g of gaps) {
  console.log(`${g.r.ap_start} .. ${g.r.ap_end}   ${g.r.file}`);
  console.log(`   statement ${money(p(g.r.total_payment))}   ledger ${money(p(g.r.total_payment) - g.gap)}   GAP ${money(g.gap)}`
    + (g.named.length ? `  = "${g.named.join('" / "')}"` : '  (matches no single line)'));
  console.log(`   credits: ${g.matched.join(' + ') || '(none in window)'}`
    + (g.r.corrected_on ? `\n   statement was corrected on ${g.r.corrected_on}` : ''));
}
console.log(`\nTOTAL GAP across ${gaps.length} statement(s): ${money(totalGap)}`);

// Credits that look like arrears rather than a scheduled instalment.
console.log('\nDWP credits that are NOT scheduled UC instalments (candidates for arrears):');
db.prepare(`SELECT date, counterparty, amount_pence FROM finance_transactions
  WHERE category='Benefits' AND (upper(counterparty) LIKE '%RFD%' OR upper(counterparty) LIKE '%COL%')
  ORDER BY date`).all()
  .forEach((r) => console.log(`   ${r.date}  ${money(r.amount_pence).padStart(10)}  ${r.counterparty}`));

console.log('\nThis is a GAP, not a verdict. It could be arrears paid into another account, paid');
console.log('outside the imported window, or offset against a debt. Ask DWP; do not assume.');
