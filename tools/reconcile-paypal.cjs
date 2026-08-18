#!/usr/bin/env node
//
// reconcile-paypal.cjs — match the bank's "PAYPAL" credits against PayPal's own withdrawals.
//
//   node tools/reconcile-paypal.cjs                 report only
//   node tools/reconcile-paypal.cjs --apply         recategorise the ones that matched
//
// THE QUESTION THIS ANSWERS. The Starling ledger holds 56 credits reading PAYPAL, 54 of them
// categorised "Refunds" by a rule, none ever reviewed (M67). Most are probably not refunds at
// all: they are WITHDRAWALS of the owner's own money out of PayPal, which is a transfer between
// two accounts he owns and not income of any kind. The bank cannot tell those apart because the
// line says PAYPAL either way. PayPal's export can, because it records the withdrawal.
//
// SO THE MATCH IS THE EVIDENCE. A bank credit with a PayPal withdrawal of the same amount a day
// or two earlier is the same money arriving. One without a partner is something else — possibly
// a genuine refund, possibly a direct payment — and stays untouched and named.
//
// IT DOES NOT GUESS AT THE UNMATCHED. Recategorising a row because it failed to match would be
// asserting a fact from an absence, which is the error this whole exercise exists to correct.
// Unmatched rows are listed for a human and left exactly as they are.
'use strict';

const db = require('../server/db');
require('../server/routes/finance');

const APPLY = process.argv.includes('--apply');
const WINDOW_DAYS = 4;        // PayPal quotes 1-3 working days; 4 covers a weekend
const gbp = (p) => `£${(p / 100).toFixed(2)}`;
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

// The bank side: money IN, from PayPal.
const bank = db.prepare(`
  SELECT id, date, counterparty, amount_pence, category, reviewed
  FROM finance_transactions
  WHERE amount_pence > 0 AND account_id NOT LIKE 'paypal%'
    AND (counterparty LIKE '%paypal%' OR reference LIKE '%paypal%')
  ORDER BY date`).all();

// The PayPal side: money OUT of PayPal, which is what lands in the bank. Negative amounts.
const withdrawals = db.prepare(`
  SELECT id, date, amount_pence, reference
  FROM finance_transactions
  WHERE account_id LIKE 'paypal%' AND amount_pence < 0
    AND (type LIKE '%withdraw%' OR reference LIKE '%withdraw%' OR category = 'Own transfer')
  ORDER BY date`).all();

console.log(`\n  bank credits reading PAYPAL : ${bank.length}  ${gbp(bank.reduce((a, r) => a + r.amount_pence, 0))}`);
console.log(`  PayPal withdrawals imported : ${withdrawals.length}  ${gbp(withdrawals.reduce((a, r) => a + r.amount_pence, 0))}`);

if (!withdrawals.length) {
  console.log('\n  No PayPal withdrawals are in the ledger, so there is nothing to match against.');
  console.log('  Run tools/import-paypal.cjs first. This is "could not look", not "no matches".');
  process.exit(2);
}

const used = new Set();
const matched = [];
const unmatched = [];

for (const b of bank) {
  // Nearest withdrawal of the same amount, at or before the credit, inside the window.
  const cand = withdrawals
    .filter((w) => !used.has(w.id)
      && Math.abs(w.amount_pence) === b.amount_pence
      && Date.parse(w.date) <= Date.parse(b.date)
      && days(w.date, b.date) <= WINDOW_DAYS)
    .sort((x, y) => days(y.date, b.date) - days(x.date, b.date));
  const hit = cand[cand.length - 1];
  if (hit) { used.add(hit.id); matched.push({ b, w: hit }); } else unmatched.push(b);
}

console.log(`\n  MATCHED ${matched.length} of ${bank.length} — same amount, within ${WINDOW_DAYS} days:`);
for (const m of matched.slice(0, 20)) {
  console.log(`    ${m.b.date}  ${gbp(m.b.amount_pence).padStart(9)}  currently "${m.b.category}"  <- withdrawal ${m.w.date}`);
}
if (matched.length > 20) console.log(`    ... and ${matched.length - 20} more`);

console.log(`\n  UNMATCHED ${unmatched.length} — left alone, because an absence is not evidence:`);
for (const u of unmatched.slice(0, 20)) {
  console.log(`    ${u.date}  ${gbp(u.amount_pence).padStart(9)}  "${u.category}"  no withdrawal of that amount nearby`);
}
if (unmatched.length > 20) console.log(`    ... and ${unmatched.length - 20} more`);

const wrong = matched.filter((m) => m.b.category !== 'Own transfer');
console.log(`\n  Of the matched, ${wrong.length} are currently NOT labelled "Own transfer".`);
console.log(`  Those are the owner's own money moving between his own accounts, so calling them`);
console.log(`  "Refunds" both invents a refund that never happened and hides the transfer.`);

if (!APPLY) {
  console.log(`\n  Report only. Re-run with --apply to set those ${wrong.length} to "Own transfer".`);
  console.log('  Nothing has been changed.');
  process.exit(0);
}

// Snapshot before, so the claim "n changed" is a diff and not a .changes count -- .changes
// reports rows MATCHED, which is the same number an inert run would print.
const before = new Map(wrong.map((m) => [m.b.id, m.b.category]));
const upd = db.prepare("UPDATE finance_transactions SET category = 'Own transfer', category_source = 'paypal-reconcile' WHERE id = ?");
db.withTransaction(() => { for (const m of wrong) upd.run(m.b.id); });

let changed = 0;
for (const [id, was] of before) {
  const now = db.prepare('SELECT category FROM finance_transactions WHERE id = ?').get(id);
  if (now && now.category === 'Own transfer' && was !== 'Own transfer') changed += 1;
}
console.log(`\n  ${changed} row(s) actually changed value, verified by re-reading each one.`);
console.log('  The unmatched rows were not touched.');
