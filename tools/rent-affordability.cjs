#!/usr/bin/env node
//
// rent-affordability.cjs — what the ledger can and cannot say about affording rent.
//
//   node tools/rent-affordability.cjs            12-month view
//   node tools/rent-affordability.cjs --months 6
//
// Backlog #25, and its rationale was the design: "affordability from the real ledger
// including bills, not a listings scrape."
//
// ------------------------------------------------------------------------------------
// THIS DOES NOT PRODUCE A NUMBER YOU CAN AFFORD, AND THE REASON IS IN YOUR OWN DATA.
//
// Over the last 12 months the ledger shows about £40k arriving. It splits in two, and the
// halves are not the same kind of thing:
//
//   Benefits          predictable, recurring, and safely called income
//   Income - people   money that arrived FROM A NAMED PERSON
//
// That second label is a DIRECTION, not a purpose — the same trap the whole ledger has:
// the bank's own categories are mostly mechanism and sign. Money from a person can be
// earnings, a repayment of something you lent, a share of a household bill, or a gift, and
// nothing in a bank export distinguishes them. Roughly £22.6k of the £40k is in that state,
// concentrated on a handful of counterparties.
//
// A single "you can afford £X" figure would have to silently pick one interpretation. On a
// tenancy — a 12-month commitment that is expensive and slow to reverse — a number that
// confident, resting on an assumption nobody stated, is the worst thing this file could
// produce. So it computes the arithmetic under EXPLICIT scenarios and leaves the judgement
// where it belongs.
// ------------------------------------------------------------------------------------
'use strict';

const db = require('../server/db');
require('../server/routes/finance');

const args = process.argv.slice(2);
const mi = args.indexOf('--months');
const MONTHS = mi >= 0 ? Math.max(3, Math.min(60, Number(args[mi + 1]) || 12)) : 12;

const gbp = (p) => `£${(p / 100).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

const SINCE = `date('now','localtime','-${MONTHS} months')`;

// Committed living costs: things that would still be paid in a new flat. Deliberately does
// NOT include Housing — the point of the exercise is what housing you could add, and the
// ledger's Housing rows stop in 2023 anyway.
const LIVING = ['Groceries', 'Phone & internet', 'Transport', 'Fuel', 'Fees & charges'];

function monthlyMedian(categories) {
  // MEDIAN of the monthly totals, not the mean. One expensive month should not set a
  // baseline you would never actually hit — the same reasoning the budget module uses.
  const rows = db.prepare(`
    SELECT substr(date,1,7) m, SUM(-amount_pence) total
      FROM finance_transactions
     WHERE amount_pence < 0 AND date >= ${SINCE}
       AND category IN (${categories.map(() => '?').join(',')})
     GROUP BY m ORDER BY total`).all(...categories);
  if (!rows.length) return { medianPence: 0, months: 0 };
  return { medianPence: rows[Math.floor(rows.length / 2)].total, months: rows.length };
}

function incomeByCategory() {
  return db.prepare(`
    SELECT category, COUNT(*) n, SUM(amount_pence) total
      FROM finance_transactions
     WHERE amount_pence > 0 AND category IS NOT NULL AND category <> 'Own transfer'
       AND date >= ${SINCE}
     GROUP BY category ORDER BY total DESC`).all();
}

function peopleDetail() {
  return db.prepare(`
    SELECT counterparty, COUNT(*) n, SUM(amount_pence) total,
           MIN(date) a, MAX(date) b
      FROM finance_transactions
     WHERE amount_pence > 0 AND category = 'Income - people' AND date >= ${SINCE}
     GROUP BY counterparty ORDER BY total DESC`).all();
}

function main() {
  const inc = incomeByCategory();
  if (!inc.length) {
    console.error(`No income in the last ${MONTHS} months of the ledger. Nothing to compute.`);
    process.exit(1);
  }

  const total = inc.reduce((s, r) => s + r.total, 0);
  const benefits = inc.filter((r) => r.category === 'Benefits').reduce((s, r) => s + r.total, 0);
  const people = inc.filter((r) => r.category === 'Income - people').reduce((s, r) => s + r.total, 0);
  const other = total - benefits - people;

  const living = monthlyMedian(LIVING);

  console.log('='.repeat(78));
  console.log(`RENT AFFORDABILITY — what the ledger supports, over ${MONTHS} months`);
  console.log('Preparation, not advice. It does not decide what you can afford.');
  console.log('='.repeat(78));

  console.log('\nWHERE MONEY CAME FROM\n');
  for (const r of inc) {
    console.log(`  ${pad(r.category, 20)} ${rpad(gbp(r.total), 12)}  ${rpad(r.n, 4)} credits  ${rpad(gbp(Math.round(r.total / MONTHS)), 10)}/month`);
  }
  console.log(`  ${pad('TOTAL', 20)} ${rpad(gbp(total), 12)}                ${rpad(gbp(Math.round(total / MONTHS)), 10)}/month`);

  console.log('\nCOMMITTED LIVING COSTS, EXCLUDING HOUSING\n');
  console.log(`  Median month across ${living.months} months: ${gbp(living.medianPence)}`);
  console.log(`  (${LIVING.join(', ')} — median, not mean, so one heavy month does not set the baseline.)`);
  console.log('  Housing is excluded deliberately: the question is what housing could be ADDED,');
  console.log('  and the ledger\'s last Housing row is from 2023 anyway.');

  console.log('\nTHE PART ONLY YOU CAN SETTLE\n');
  console.log(`  ${gbp(people)} arrived from named individuals over these ${MONTHS} months.`);
  console.log('  "Income - people" is a DIRECTION, not a purpose. Money from a person can be');
  console.log('  earnings, a repayment, a share of a bill, or a gift, and a bank export cannot');
  console.log('  tell them apart. Which it is decides everything below.\n');
  for (const p of peopleDetail().slice(0, 6)) {
    console.log(`    ${pad(String(p.counterparty).slice(0, 24), 26)} ${rpad(gbp(p.total), 11)}  ${rpad(p.n, 3)} payments  ${p.a} -> ${p.b}`);
  }

  console.log('\nWHAT IS LEFT FOR RENT AND BILLS, UNDER EACH ASSUMPTION\n');
  const scenarios = [
    ['Benefits only', benefits, 'Treats nothing from individuals as income. The most cautious reading.'],
    ['Benefits + other', benefits + other, 'Adds refunds and the rest, but still no person-to-person money.'],
    ['Everything', total, 'Treats every credit as sustainable income. Only true if those payments are earnings AND continue.'],
  ];
  for (const [label, amount, why] of scenarios) {
    const perMonth = Math.round(amount / MONTHS);
    const left = perMonth - living.medianPence;
    console.log(`  ${pad(label, 20)} ${rpad(gbp(perMonth), 11)}/month  less living ${rpad(gbp(living.medianPence), 10)}  =  ${rpad(gbp(left), 11)} for rent + bills`);
    console.log(`  ${' '.repeat(20)} ${why}`);
  }

  console.log('\nWHAT THIS DELIBERATELY DOES NOT DO\n');
  console.log('  - It does not pick a scenario. The spread between them is wide, and the choice');
  console.log('    rests on facts about those payments that only you hold.');
  console.log('  - It applies no affordability multiple. Letting agents commonly use their own');
  console.log('    rules of thumb; this file will not quote one it cannot source.');
  console.log('  - "For rent + bills" is not "for rent". Council tax, water, energy and contents');
  console.log('    insurance are not in the ledger because you are not currently paying them,');
  console.log('    and every one is a real cost in a flat of your own.');
  console.log('  - A tenancy is usually a 12-month commitment. Being wrong here is expensive and');
  console.log('    slow to undo, which is why nothing above rounds up in your favour.\n');
}

main();
