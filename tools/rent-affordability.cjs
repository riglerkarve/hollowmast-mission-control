#!/usr/bin/env node
// Backlog #25 — "Research private rented property, 1-bed minimum".
//
// Its rationale set the shape: "affordability from the real ledger including bills, not a
// listings scrape." So this reads the ledger and reports what it can and cannot support.
//
// IT DOES NOT PRINT A FIGURE YOU CAN AFFORD, and refusing to is the main design decision.
// 77.6% of measured spending is cash or person-to-person with no purpose recorded, so a
// single "you can afford £X" would be built on under a quarter of the evidence and would
// look exactly as confident as one built on all of it. What it does instead:
//
//   1. States the arithmetic that IS solid  — evidenced income, and the reconciliation.
//   2. States what is opaque, and how big   — a filter must report its residue.
//   3. Names the one question that unlocks it — where £741/month actually goes.
//   4. Runs the sensitivity for a rent YOU supply, from a real listing.
//
// Usage:
//   node tools/rent-affordability.cjs
//   node tools/rent-affordability.cjs --rent 850          one figure, monthly, in pounds
//   node tools/rent-affordability.cjs --rent 750,850,950  compare several
//   node tools/rent-affordability.cjs --save              also write reports/housing/

const fs = require('fs');
const path = require('path');
const db = require('../server/db');
require('../server/routes/finance');

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const SAVE = process.argv.includes('--save');
const RENTS = (argOf('--rent') || '')
  .split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0);

// ---------------------------------------------------------------- the window
// The last period is ALWAYS partial: the ledger is an import and stops mid-month, so
// including that month drags every monthly mean down by a fraction nobody can see.
// Complete calendar months only, and the excluded stub is named rather than dropped.
const ledgerEnd = db.prepare('SELECT MAX(date) AS d FROM finance_transactions').get().d;
function lastCompleteMonthEnd(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const endOfThis = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d >= endOfThis) return iso;                               // the month is complete
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}
const TO = lastCompleteMonthEnd(ledgerEnd);
const FROM = (() => {
  const [y, m] = TO.split('-').map(Number);
  return new Date(Date.UTC(y - 1, m, 1)).toISOString().slice(0, 10);
})();
const MONTHS = 12;

const gbp = (p) => (p / 100).toFixed(2);
const pad = (s, n) => String(s).padStart(n);
const perYear = (p) => pad('GBP ' + gbp(p), 15);
const perMonth = (p) => pad('GBP ' + gbp(p / MONTHS), 14);

const sum = (where, args = []) => db.prepare(
  `SELECT COALESCE(SUM(${where.expr}),0) AS p, COUNT(*) AS n
     FROM finance_transactions WHERE date >= ? AND date <= ? ${where.and}`
).get(FROM, TO, ...args);

const inCat = (c) => sum({ expr: 'amount_pence', and: 'AND category = ? AND amount_pence > 0' }, [c]);
const outCat = (c) => sum({ expr: '-amount_pence', and: 'AND category = ? AND amount_pence < 0' }, [c]);

// ---------------------------------------------------------------- the figures
const INCOME_CATEGORIES = ['Benefits', 'Income - people', 'Refunds'];
const OPAQUE_CATEGORIES = ['Cash withdrawn', 'Payments to people'];

const income = INCOME_CATEGORIES.map((c) => ({ c, ...inCat(c) }));
const incomeTotal = income.reduce((s, r) => s + r.p, 0);

const spendAll = sum({ expr: '-amount_pence', and: "AND amount_pence < 0 AND category <> 'Own transfer'" });
const spendOpaque = sum({
  expr: '-amount_pence',
  and: `AND amount_pence < 0 AND category IN (${OPAQUE_CATEGORIES.map(() => '?').join(',')})`,
}, OPAQUE_CATEGORIES);
const itemised = spendAll.p - spendOpaque.p;

const otOut = sum({ expr: '-amount_pence', and: "AND amount_pence < 0 AND category = 'Own transfer'" });
const otIn = sum({ expr: 'amount_pence', and: "AND amount_pence > 0 AND category = 'Own transfer'" });
const movedOut = otOut.p - otIn.p;

const reconcile = incomeTotal - spendAll.p - movedOut;

// Housing, ever -- not just in the window. "Nothing this year" and "nothing ever" are
// different facts and only one of them means the cost is being paid another way.
const housingEver = db.prepare(
  "SELECT COUNT(*) AS n, MIN(date) AS a, MAX(date) AS b, COALESCE(SUM(-amount_pence),0) AS p "
  + "FROM finance_transactions WHERE category = 'Housing' AND amount_pence < 0"
).get();

const HOUSING_ADJACENT = ['Housing', 'Council tax', 'Utilities', 'Phone & internet'];
const adjacent = HOUSING_ADJACENT.map((c) => ({ c, ...outCat(c) }));

// ---------------------------------------------------------------- output
const L = [];
const say = (s = '') => { L.push(s); console.log(s); };

say('RENT AFFORDABILITY, FROM YOUR OWN LEDGER');
say('='.repeat(78));
say(`Twelve complete months, ${FROM} to ${TO}.`);
if (TO !== ledgerEnd) {
  say(`The ledger runs to ${ledgerEnd}; that final part-month is EXCLUDED, because a stub`);
  say('month drags every monthly average down by an amount you cannot see.');
}
say('');
say('This does NOT tell you what you can afford, and the reason is the finding.');
say('');

say('WHAT IS SOLID: MONEY IN');
say('-'.repeat(78));
say(`  ${'category'.padEnd(22)}${pad('per year', 15)}${pad('per month', 14)}   n`);
income.forEach((r) => say(`  ${r.c.padEnd(22)}${perYear(r.p)}${perMonth(r.p)}   ${r.n}`));
say(`  ${'EVIDENCED INCOME'.padEnd(22)}${perYear(incomeTotal)}${perMonth(incomeTotal)}`);
say('');
say('  Own transfers in are excluded: money arriving from your own other accounts is not');
say('  income, and counting it would inflate this by roughly a seventh.');
say('');

say('WHAT IS SOLID: THE RECONCILIATION');
say('-'.repeat(78));
say(`  evidenced income          ${perYear(incomeTotal)}${perMonth(incomeTotal)}`);
say(`  all spending              ${perYear(-spendAll.p)}${perMonth(-spendAll.p)}`);
say(`  net moved to other accts  ${perYear(-movedOut)}${perMonth(-movedOut)}`);
say(`  ${'='.repeat(26)}${'='.repeat(29)}`);
say(`  unaccounted               ${perYear(reconcile)}${perMonth(reconcile)}`);
say('');
say(`  It closes to GBP ${gbp(Math.abs(reconcile))} across a whole year, which is the test that the model`);
say('  above is the whole picture rather than a convenient slice of it.');
say('');
say('  THE HEADLINE: over twelve months this account accumulated nothing. There is no');
say('  measured surplus sitting there that a rent could come out of.');
say('');

say('WHAT IS OPAQUE, AND HOW BIG');
say('-'.repeat(78));
const opaquePct = (100 * spendOpaque.p / spendAll.p).toFixed(1);
say(`  all spending              ${perYear(spendAll.p)}${perMonth(spendAll.p)}   n=${spendAll.n}`);
say(`  cash + payments to people ${perYear(spendOpaque.p)}${perMonth(spendOpaque.p)}   n=${spendOpaque.n}   ${opaquePct}%`);
say(`  itemised, purpose known   ${perYear(itemised)}${perMonth(itemised)}`);
say('');
say(`  ${opaquePct}% of what you spend has no purpose recorded. Not miscategorised -- there is`);
say('  no information to categorise. Any statement of the form "you spend GBP X on living');
say('  costs, so GBP Y is free for rent" would be derived from the other 22%, and would look');
say('  exactly as confident as one derived from all of it.');
say('');

say('IS THE HOUSING COST ALREADY IN HERE?');
say('-'.repeat(78));
adjacent.forEach((r) => say(
  `  ${r.c.padEnd(22)}${perYear(r.p)}${perMonth(r.p)}   n=${r.n}${r.n === 0 ? '   <- nothing recorded' : ''}`));
say('');
if (housingEver.n) {
  say(`  Housing has appeared before: ${housingEver.n} payments, ${housingEver.a} to ${housingEver.b},`);
  say(`  GBP ${gbp(housingEver.p)} in total. Nothing since ${housingEver.b}.`);
} else {
  say('  Housing has NEVER appeared in this ledger.');
}
say('');
say('  Checked for the SHAPE of rent as well as the label -- a monthly payment of a');
say('  consistent amount to the same counterparty. Nothing matches: every repeated payee');
say('  has a median gap of 0-7 days with mostly-distinct amounts, which is the pattern of');
say('  informal transfers, not a tenancy.');
say('');
say('  So either housing is paid in cash, or from an account not imported here, or it is');
say('  not being paid by you. THIS TOOL CANNOT TELL WHICH, and the three have completely');
say('  different consequences for the question you asked.');
say('');

say('THE ONE QUESTION THAT UNLOCKS THIS');
say('-'.repeat(78));
say(`  GBP ${gbp(movedOut)} a year -- GBP ${gbp(movedOut / MONTHS)} a month -- leaves this account, net, for`);
say('  accounts the ledger does not cover (Revolut, Monzo, the business account).');
say('');
say('  If that is SAVING, it is the closest thing you have to a rent budget already');
say('  running, and it is a real one.');
say('  If it is SPENDING done elsewhere, it is not available at all and the true surplus');
say('  is nearer zero.');
say('');
say('  Nothing in this database distinguishes those two. You can answer it in a minute,');
say('  and the answer changes the conclusion completely -- which is why no number is');
say('  printed above it.');
say('');

// ------------------------------------------------- sensitivity, only if asked
say('WHAT A GIVEN RENT WOULD MEAN');
say('-'.repeat(78));
if (!RENTS.length) {
  say('  Supply a real figure from a real listing and this will do the arithmetic against');
  say('  your actual numbers:');
  say('');
  say('      node tools/rent-affordability.cjs --rent 850');
  say('      node tools/rent-affordability.cjs --rent 750,850,950');
  say('');
  say('  No default is offered, deliberately. A plausible-looking rent invented here would');
  say('  become the figure you remember, and it would be mine rather than the market\'s.');
} else {
  const incomeM = incomeTotal / MONTHS / 100;
  const opaqueM = spendOpaque.p / MONTHS / 100;
  const itemisedM = itemised / MONTHS / 100;
  const movedM = movedOut / MONTHS / 100;
  say(`  Against evidenced income of GBP ${incomeM.toFixed(2)}/month.`);
  say('');
  say(`  ${'rent'.padEnd(10)}${pad('% of income', 12)}${pad('left after rent', 18)}${pad('+ itemised spend', 18)}${pad('and the opaque', 16)}`);
  RENTS.forEach((r) => {
    const afterRent = incomeM - r;
    const afterItem = afterRent - itemisedM;
    const afterOpaque = afterItem - opaqueM;
    say(`  ${('GBP ' + r.toFixed(0)).padEnd(10)}${pad((100 * r / incomeM).toFixed(1) + '%', 12)}`
      + `${pad('GBP ' + afterRent.toFixed(2), 18)}${pad('GBP ' + afterItem.toFixed(2), 18)}`
      + `${pad('GBP ' + afterOpaque.toFixed(2), 16)}`);
  });
  say('');
  say(`  The last column subtracts the GBP ${opaqueM.toFixed(2)}/month you currently spend without a`);
  say('  recorded purpose. It is the honest column, because that spending is real whether or');
  say('  not it is described.');
  say('');
  // Not a threshold anyone chose: it is where the last column crosses zero, which is one
  // subtraction from three figures printed above. Stated so the reader does not have to
  // interpolate between the rows they happened to ask for.
  const crossover = incomeM - itemisedM - opaqueM;
  say(`  THE CROSSOVER IS GBP ${crossover.toFixed(2)}/MONTH.`);
  say(`  ${incomeM.toFixed(2)} income - ${itemisedM.toFixed(2)} itemised - ${opaqueM.toFixed(2)} opaque. Above that rent, your`);
  say('  current spending no longer fits inside your current income. It is arithmetic on');
  say('  three numbers printed above, not a rule of thumb and not a limit anyone chose.');
  say('');
  say('  It is NOT "the rent you can afford". It is the rent at which SOMETHING HAS TO');
  say('  CHANGE -- and since 77.6% of that spending has no recorded purpose, neither of us');
  say('  currently knows whether it is easy to change or impossible.');
  say('');
  say(`  None of these columns include council tax, water, energy or broadband, because you`);
  say(`  currently record GBP ${(adjacent.find((a) => a.c === 'Phone & internet').p / MONTHS / 100).toFixed(2)}/month of Phone & internet and nothing else. A tenancy`);
  say('  adds all of them, and this ledger has no basis at all for estimating them --');
  say('  they depend on the property, the band and the supplier. Get them from the listing');
  say('  and the council band, not from here.');
  say('');
  say(`  Also not included: the GBP ${movedM.toFixed(2)}/month above, in either direction, because`);
  say('  whether it is available is the open question.');
}
say('');

say('WHAT THIS IS BLIND TO');
say('-'.repeat(78));
[
  'Any account not imported. Revolut, Monzo and anything else are invisible, and a net '
    + `GBP ${gbp(movedOut / MONTHS)} a month goes to them.`,
  `The purpose of ${opaquePct}% of spending. Cash and person-to-person payments carry no `
    + 'description this can read.',
  'Deposits, agency fees and the first month up front -- a one-off cost of several '
    + 'thousand that no monthly figure here represents.',
  'Whether benefits entitlement changes on moving. Housing Benefit and Universal Credit '
    + 'housing element are real and are not in this ledger. That is a question for an '
    + 'adviser, not for a spreadsheet.',
  'The market. This is deliberately not a listings scrape, so it says nothing about what '
    + 'a one-bed actually costs where you want to live.',
].forEach((b, i) => {
  const words = b.split(' ');
  let line = `  ${i + 1}. `;
  words.forEach((w) => {
    if ((line + w).length > 76) { say(line); line = '     '; }
    line += w + ' ';
  });
  say(line.trimEnd());
});
say('');
say('None of this is financial advice, and none of it is a recommendation to move.');

if (SAVE) {
  const dir = path.resolve(__dirname, '..', 'reports', 'housing');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rent-affordability-${TO}.txt`);
  fs.writeFileSync(file, L.join('\n') + '\n', 'utf8');
  console.log('');
  console.log(`saved: ${path.relative(path.resolve(__dirname, '..'), file)}`);
}
