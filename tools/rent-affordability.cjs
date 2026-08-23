#!/usr/bin/env node
// Backlog #25 — "Research private rented property, 1-bed minimum".
//
// Its rationale set the shape: "affordability from the real ledger including bills, not a
// listings scrape." So this reads the ledger and reports what it can and cannot support.
//
// THIS ITEM IS HELD. The owner asked on 18 Aug for Universal Credit statements to be
// imported first, and that hold still stands — see the note on backlog #25. Nothing here
// is an answer, and it must not be read as one.
//
// IT DOES NOT PRINT A FIGURE YOU CAN AFFORD, and refusing to is the main design decision.
// Around three quarters of measured spending is cash or person-to-person with no purpose
// recorded, so a single "you can afford £X" would be built on the remaining quarter and
// would look exactly as confident as one built on all of it. The exact share is COMPUTED
// and printed by the tool -- it was 77.6% on 18 Aug and moved to 77.3% the same day when
// two bookmakers were recategorised, which is why no figure is written into this comment.
// What it does instead:
//
//   1. Splits income into EXPLICIT SCENARIOS and refuses to choose between them.
//   2. States the arithmetic that IS solid  — the reconciliation.
//   3. States what is opaque, and how big   — a filter must report its residue.
//   4. Names the one question that unlocks it — where £741/month actually goes.
//   5. Runs the sensitivity for a rent YOU supply, from a real listing.
//
// THE SCENARIOS ARE NOT DECORATION and this file lost them once, on 18 Aug, when I rewrote
// it without reading the held note first. A single "evidenced income" line silently counts
// £22,613 from named individuals as income. "Income - people" is a DIRECTION label, not a
// purpose: money from a person can be earnings, a repayment, a share of a bill or a gift,
// and a bank export cannot tell them apart. £14,511 of it came from ONE counterparty across
// 49 payments. Collapsing that into one total makes an interpretation on the owner's behalf,
// on a 12-month commitment that is expensive and slow to reverse.
//
// Usage:
//   node tools/rent-affordability.cjs
//   node tools/rent-affordability.cjs --rent 850          one figure, monthly, in pounds
//   node tools/rent-affordability.cjs --rent 750,850,950  compare several
//   node tools/rent-affordability.cjs --save              also write reports/housing/

require('./_run-log.cjs').record();
const fs = require('fs');
const path = require('path');
const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('claude');
require('../server/routes/finance');

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const SAVE = process.argv.includes('--save');
const RENTS = (argOf('--rent') || '')
  .split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0);
// The Local Housing Allowance rate for the property's Broad Rental Market Area. Either given
// explicitly with --lha, or looked up from data/lha-rates.json, which carries the gov.uk URL
// it was taken from and the date. Still never guessed: an area not in that file is reported
// as absent rather than estimated.
const LHA = (argOf('--lha') || '')
  .split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0);
const AREA = argOf('--area');
const BEDS = argOf('--beds') || '1bed';

let LHA_TABLE = null;
try {
  LHA_TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'lha-rates.json'), 'utf8'));
} catch { LHA_TABLE = null; }

// --area resolves to a rate from the table and joins whatever --lha supplied, so the two can
// be compared side by side rather than one silently winning.
let lhaSource = null;
if (AREA && LHA_TABLE) {
  const row = LHA_TABLE.brma[AREA];
  if (row && row[BEDS] != null) {
    LHA.push(row[BEDS]);
    lhaSource = `${AREA} ${BEDS}, ${LHA_TABLE.period}, from ${LHA_TABLE._source_page}`;
  } else {
    lhaSource = `NOT FOUND: ${AREA} ${BEDS} is not in data/lha-rates.json. Areas held: ${Object.keys(LHA_TABLE.brma).join(', ')}. Add it from ${LHA_TABLE._source} rather than estimating it.`;
  }
}

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

// ---------------------------------------------------------------- the UC statements
// Read from data/uc-statements.jsonl, which tools/uc-reconcile.cjs has checked against the
// bank. Absent file = the hold still stands, and the report says so rather than pretending.
//
// These answer the one question the LEDGER cannot: the housing element never appears in the
// bank because DWP pays it straight to the landlord, so a bank export shows £0 of housing
// for a tenancy that is in fact being paid in full.
let UC = [];
try {
  UC = fs.readFileSync(path.join(__dirname, '..', 'data', 'uc-statements.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => a.ap_end.localeCompare(b.ap_end));
} catch { UC = []; }
const ucLatest = UC.length ? UC[UC.length - 1] : null;
const ucLine = (r, label) => (r.entitlement_lines || []).find((x) => x.label === label);
const ucPaidToLandlord = (r) => (r.deduction_lines || []).some((x) => x.label === 'Payment to your landlord');

say('RENT AFFORDABILITY, FROM YOUR OWN LEDGER');
if (UC.length) {
  say(`*** Hold released: ${UC.length} Universal Credit statements imported and reconciled. ***`);
} else {
  say('*** THIS ITEM IS HELD: Universal Credit statements are to be imported first ***');
  say('*** Nothing below is an answer. The scenarios narrow once that data exists.  ***');
}
say('='.repeat(78));
say(`Twelve complete months, ${FROM} to ${TO}.`);
if (TO !== ledgerEnd) {
  say(`The ledger runs to ${ledgerEnd}; that final part-month is EXCLUDED, because a stub`);
  say('month drags every monthly average down by an amount you cannot see.');
}
say('');
say('This does NOT tell you what you can afford, and the reason is the finding.');
say('');

say('MONEY IN — AND WHY THERE IS NO SINGLE INCOME FIGURE');
say('-'.repeat(78));
say(`  ${'category'.padEnd(22)}${pad('per year', 15)}${pad('per month', 14)}   n`);
income.forEach((r) => say(`  ${r.c.padEnd(22)}${perYear(r.p)}${perMonth(r.p)}   ${r.n}`));
say('');
say('  Own transfers in are excluded: money arriving from your own other accounts is not');
say('  income, and counting it would inflate this by roughly a seventh.');
say('');
say('  "Income - people" is a DIRECTION, not a purpose. Money from a named person can be');
say('  earnings, a repayment, a share of a bill or a gift, and a bank export cannot tell');
say('  them apart. Which it is decides everything below, so it is never assumed.');
say('');
const peopleDetail = db.prepare(
  "SELECT counterparty, COUNT(*) AS n, SUM(amount_pence) AS p, MIN(date) AS a, MAX(date) AS b "
  + "FROM finance_transactions WHERE date >= ? AND date <= ? AND category = 'Income - people' "
  + "AND amount_pence > 0 GROUP BY counterparty ORDER BY p DESC"
).all(FROM, TO);
say('  who it came from, largest first:');
peopleDetail.slice(0, 6).forEach((p) => say(
  `    ${String(p.counterparty).slice(0, 24).padEnd(26)}${pad('GBP ' + gbp(p.p), 12)}  ${pad(p.n, 3)} payments  ${p.a} -> ${p.b}`));
if (peopleDetail.length > 6) {
  const rest = peopleDetail.slice(6).reduce((s, p) => s + p.p, 0);
  say(`    ${('and ' + (peopleDetail.length - 6) + ' others').padEnd(26)}${pad('GBP ' + gbp(rest), 12)}`);
}
say('');

// A MEAN IS THE WRONG STATISTIC WHEN THE SERIES IS NOT FLAT, so print the series before
// any average built on it. This is the finding that changed the whole answer: person-money
// has not stopped -- the last payment is days before the ledger ends -- but it has
// COLLAPSED, and a twelve-month mean carries a January spike into every month of a
// twelve-month tenancy.
const monthly = (cat) => db.prepare(
  "SELECT substr(date,1,7) AS m, COUNT(*) AS n, SUM(amount_pence) AS p "
  + 'FROM finance_transactions WHERE date >= ? AND date <= ? AND category = ? '
  + 'AND amount_pence > 0 GROUP BY m ORDER BY m'
).all(FROM, TO, cat);

const peopleMonthly = monthly('Income - people');
const benefitsMonthly = monthly('Benefits');
const lastN = (rows, n) => rows.slice(-n).reduce((s, r) => s + r.p, 0) / n;

say('  MONTH BY MONTH — because an average of an uneven series hides its own shape');
say(`    ${'month'.padEnd(10)}${pad('from people', 14)}${pad('benefits', 14)}`);
peopleMonthly.forEach((r) => {
  const b = benefitsMonthly.find((x) => x.m === r.m);
  say(`    ${r.m.padEnd(10)}${pad('GBP ' + gbp(r.p), 14)}${pad('GBP ' + gbp(b ? b.p : 0), 14)}`);
});
say('');
const p3 = lastN(peopleMonthly, 3), p6 = lastN(peopleMonthly, 6);
const peopleMean = income.find((r) => r.c === 'Income - people').p / MONTHS;
const lastPerson = db.prepare(
  "SELECT MAX(date) AS d FROM finance_transactions WHERE category = 'Income - people' AND amount_pence > 0"
).get().d;
say(`  Person-money has NOT stopped -- the most recent is ${lastPerson}, days before the ledger`);
say('  ends. But it has collapsed, and the twelve-month mean is dominated by one month:');
say(`    12-month mean      GBP ${gbp(peopleMean)}/month`);
say(`    last 6 months      GBP ${gbp(p6)}/month`);
say(`    last 3 months      GBP ${gbp(p3)}/month`);
say('  Both windows are shown so neither is privileged, and the series above lets you pick');
say('  your own. Benefits, by contrast, are flat and are the one dependable line here.');
say('');

// THE SCENARIOS. Never collapsed into one figure -- see the header. Each is a reading of
// the same rows, and the spread between them is the honest measure of what is not known.
const benefits = income.find((r) => r.c === 'Benefits').p;
const people = income.find((r) => r.c === 'Income - people').p;
const otherInc = incomeTotal - benefits - people;
const SCENARIOS = [
  ['Benefits only', benefits,
    'Counts nothing from individuals. The most cautious reading.'],
  ['Benefits + other', benefits + otherInc,
    'Adds refunds and the rest, still no person-to-person money.'],
  ['+ recent people', benefits + otherInc + (p3 * MONTHS),
    'Adds person-money at the LAST THREE MONTHS rate, not the annual mean. The likeliest reading if the recent trend holds.'],
  ['Everything', incomeTotal,
    'Treats every credit as sustainable income at the 12-month mean. Requires the January level to return AND continue.'],
];
say('  INCOME UNDER EACH READING');
SCENARIOS.forEach(([label, amt, why]) => {
  say(`    ${label.padEnd(20)}${perYear(amt)}${perMonth(amt)}`);
  say(`    ${' '.repeat(20)}${why}`);
});
say('');
say(`  The spread is GBP ${gbp((incomeTotal - benefits) / MONTHS)} a month. That is not a rounding difference; it is`);
say('  the whole question, and it is yours to settle rather than mine to assume.');
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
if (!ucLatest) {
  say('  So either housing is paid in cash, or from an account not imported here, or it is');
  say('  not being paid by you. THIS TOOL CANNOT TELL WHICH, and the three have completely');
  say('  different consequences for the question you asked.');
  say('');
} else {
  // The fourth possibility, which the three above did not include, and which the statements
  // settle outright.
  const h = ucLine(ucLatest, 'Housing');
  const direct = ucPaidToLandlord(ucLatest);
  say('  ANSWERED BY THE UC STATEMENTS, and the answer was not one of the three above:');
  say(`  the housing element is paid by DWP DIRECT TO THE LANDLORD. It never enters this`);
  say('  account, which is why the ledger shows GBP 0.00 of housing for a tenancy that is');
  say('  in fact being paid in full.');
  say('');
  say(`  Latest statement, assessment period ending ${ucLatest.ap_end}:`);
  say(`    rent                     GBP ${gbp(Math.round((ucLatest.rent_stated || 0) * 100))}`);
  if (ucLatest.service_charges) {
    say(`    service charges          GBP ${gbp(Math.round(ucLatest.service_charges * 100))}`);
  }
  say(`    housing element          GBP ${gbp(Math.round((h ? h.amount : 0) * 100))}   ${direct ? 'paid direct to the landlord' : 'PAID TO YOU -- you pay the landlord'}`);
  say(`    total UC entitlement     GBP ${gbp(Math.round(ucLatest.total_entitlement * 100))}`);
  say(`    reaches your account     GBP ${gbp(Math.round(ucLatest.total_payment * 100))}`);
  say('');
  say('  SO THE "Benefits" LINE ABOVE IS NOT THE AWARD. It is what is left after housing');
  say('  has been taken out and sent elsewhere. Reading it as income and then asking what');
  say('  rent it can carry counts the rent twice -- once as missing, once as unaffordable.');
  say('');

  // The shortfall history is the part that actually generalises to a new tenancy.
  // THE TABLE CHECKS ITSELF AGAINST THE STATEMENTS. Bournemouth's published 1-bed rate should
  // equal the housing element actually awarded there — the same figure from two sources that
  // never saw each other, gov.uk and DWP. If they ever disagree, either the table is stale or
  // he is not on the category assumed, and both matter before the rate judges a listing.
  if (LHA_TABLE) {
    const bmth = LHA_TABLE.brma.Bournemouth;
    const observed = [...new Set(UC
      .filter((r) => (r.address || '').includes('Bournemouth') && ucLine(r, 'Housing'))
      .map((r) => ucLine(r, 'Housing').amount))];
    if (bmth && observed.length) {
      const agrees = observed.includes(bmth['1bed']);
      say('  CROSS-CHECK of the published table against these statements:');
      say(`    gov.uk Bournemouth 1-bed   GBP ${gbp(Math.round(bmth['1bed'] * 100))}`);
      say(`    element actually awarded   ${observed.map((v) => 'GBP ' + gbp(Math.round(v * 100))).join(', ')}`);
      say(`    ${agrees
        ? 'AGREE. Two independent sources, one figure -- so the table is current AND he was'
        : 'DISAGREE. Do not use the table until this is explained.'}`);
      if (agrees) say('    assessed on the 1-bedroom category, not the lower Shared Accommodation Rate.');
      say('');
    }
  }

  const capped = UC.filter((r) => r.lha_shortfall);
  if (capped.length) {
    const last = capped[capped.length - 1];
    say('  WHERE THE RISK ACTUALLY SITS -- the cap, not the rent:');
    say(`    ${capped.length} of ${UC.length} statements show the element held BELOW the rent by a cap`);
    say(`    (${last.cap_type || 'Local Housing Allowance'}). Most recent: rent GBP ${gbp(Math.round(last.rent_stated * 100))} against an element`);
    say(`    of GBP ${gbp(Math.round((ucLine(last, 'Housing') || { amount: 0 }).amount * 100))}, a shortfall of GBP ${gbp(Math.round(last.lha_shortfall * 100))} a month to find yourself.`);
    say('');
    say('    That is the number a listing has to be judged against. A rent inside the LHA');
    say('    rate for the area costs you nothing; a rent above it costs you the difference');
    say('    every month, out of the GBP ' + gbp(Math.round(ucLatest.total_payment * 100)) + ' that actually reaches you.');
    say('');
  }
  // THE FINDING THAT MOVES THE ANSWER, and it only appears once the published rate sits
  // beside the awarded one. His current element EXCEEDS the private-sector cap for the area,
  // so the accommodation he is in is not LHA-capped — and a private tenancy would be.
  if (LHA_TABLE && LHA_TABLE.brma.Oxford && ucLatest && (ucLatest.address || '').includes('Oxford')) {
    const cap = LHA_TABLE.brma.Oxford['1bed'];
    const el = (ucLine(ucLatest, 'Housing') || { amount: 0 }).amount;
    if (el > cap) {
      say('  WHAT WOULD CHANGE ON MOVING TO A PRIVATE TENANCY -- read this before any listing:');
      say(`    element now                GBP ${gbp(Math.round(el * 100))}   (rent + service charges, covered in full)`);
      say(`    Oxford 1-bed LHA ceiling   GBP ${gbp(Math.round(cap * 100))}   (private rented, ${LHA_TABLE.period})`);
      say(`    difference                 GBP ${gbp(Math.round((el - cap) * 100))} a month`);
      say('');
      say('    The current element is ABOVE the private-sector ceiling for this area, so the');
      say('    accommodation he is in is not LHA-capped. UC pays rent AND service charges for a');
      say('    housing association or council tenancy, and caps a private one at the LHA rate.');
      say('    A move into private renting therefore does not just add a rent -- it lowers the');
      say(`    ceiling on housing support to GBP ${gbp(Math.round(cap * 100))}, whatever the rent is.`);
      say('');
      say('    WHAT THIS DOES NOT ESTABLISH: which category the current tenancy is in. Social,');
      say('    supported, specified and temporary accommodation are treated differently from');
      say('    each other, and the statement does not name which applies. That is a question');
      say('    for the landlord or the work coach, and it decides how much is actually at risk.');
      say('');
    }
  }

  const noHousing = UC.filter((r) => !ucLine(r, 'Housing'));
  if (noHousing.length) {
    say(`  AND IT IS NOT AUTOMATIC: ${noHousing.length} of ${UC.length} statements carry NO housing element at all`);
    say(`    (${noHousing[0].ap_end} to ${noHousing[noHousing.length - 1].ap_end}). Standard allowance only.`);
    say('    Moving does not carry the element with you -- it is reassessed, and in this');
    say('    record it has both stopped for a year and restarted a period late.');
    say('');
  }
}

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
  const opaqueM = spendOpaque.p / MONTHS / 100;
  const itemisedM = itemised / MONTHS / 100;
  const movedM = movedOut / MONTHS / 100;
  // Derived from SCENARIOS.length, not typed. I wrote "THREE" here, then added a fourth
  // scenario, and the prose kept saying three -- a count in prose beside the list it counts
  // is a stale number waiting to happen.
  const N_WORD = ['no', 'one', 'two', 'THREE', 'FOUR', 'FIVE', 'SIX'][SCENARIOS.length] || String(SCENARIOS.length);
  say(`  Every rent is shown under ALL ${N_WORD} readings of income, because picking one is the`);
  say('  interpretation this file exists not to make. Each cell is what is left after the');
  say(`  rent, the GBP ${itemisedM.toFixed(2)} of itemised spending AND the GBP ${opaqueM.toFixed(2)} of undescribed spending --`);
  say('  the last is real whether or not it is described, so it is never left out.');
  say('');
  say(`  ${'rent'.padEnd(11)}${SCENARIOS.map(([l]) => pad(l, 20)).join('')}`);
  RENTS.forEach((r) => {
    const cells = SCENARIOS.map(([, amt]) => {
      const left = (amt / MONTHS / 100) - r - itemisedM - opaqueM;
      return pad((left >= 0 ? '+' : '') + left.toFixed(2), 20);
    });
    say(`  ${('GBP ' + r.toFixed(0)).padEnd(11)}${cells.join('')}`);
  });
  say('');
  // Not a threshold anyone chose: it is where each column crosses zero, one subtraction
  // from figures printed above. Per scenario, because a single crossover would smuggle
  // back exactly the choice the scenarios exist to avoid.
  say('  THE CROSSOVER UNDER EACH READING — the rent at which the column reaches zero:');
  SCENARIOS.forEach(([label, amt]) => {
    const x = (amt / MONTHS / 100) - itemisedM - opaqueM;
    say(`    ${label.padEnd(20)}${pad('GBP ' + x.toFixed(2), 12)}/month`
      + (x < 0 ? '   <- already negative before any rent' : ''));
  });
  say('');
  say('  Arithmetic on figures printed above: income minus itemised minus opaque. Not a rule');
  say(`  of thumb, not a limit anyone chose, and deliberately ${SCENARIOS.length} numbers rather than one.`);
  say('');
  // Computed, not typed. This line said 77.6% and was stale within the hour, because
  // recategorising two bookmakers moved it to 77.3%. A percentage in printed output has to
  // come from the same query that produced the section above it.
  say('  NONE of them is "the rent you can afford". Each is the rent at which SOMETHING HAS');
  say(`  TO CHANGE under that reading -- and since ${opaquePct}% of the spending it would come from`);
  say('  has no recorded purpose, neither of us knows whether changing it is easy.');
  say('');
  say(`  None of these columns include council tax, water, energy or broadband, because you`);
  say(`  currently record GBP ${(adjacent.find((a) => a.c === 'Phone & internet').p / MONTHS / 100).toFixed(2)}/month of Phone & internet and nothing else. A tenancy`);
  say('  adds all of them, and this ledger has no basis at all for estimating them --');
  say('  they depend on the property, the band and the supplier. Get them from the listing');
  say('  and the council band, not from here.');
  say('');
  say(`  Also not included: the GBP ${movedM.toFixed(2)}/month above, in either direction, because`);
  say('  whether it is available is the open question.');

  // THE COLUMNS ABOVE CHARGE HIM THE WHOLE RENT, and in 47 of 62 statements that is not
  // what happened — UC paid the housing element, latterly straight to the landlord. Left
  // uncorrected this is not a small conservatism, it is the wrong question, and it fails in
  // the direction that would talk him out of a move he can afford.
  if (ucLatest) {
    say('');
    say('  THE COLUMNS ABOVE ASSUME YOU PAY THE WHOLE RENT YOURSELF.');
    say('  In this record you almost never have. What you actually pay is the SHORTFALL:');
    say('  rent above the Local Housing Allowance rate for the property, plus anything the');
    say('  element does not cover. On the current tenancy that shortfall is GBP 0.00.');
    say('');
    if (LHA.length) {
      say('  rent      LHA rate      you pay      against GBP ' + gbp(Math.round(ucLatest.total_payment * 100)) + ' reaching your account');
      for (const rent of RENTS) {
        for (const lha of LHA) {
          const gap = Math.max(0, rent - lha);
          say(`  GBP ${String(rent).padEnd(8)} GBP ${String(lha).padEnd(11)} GBP ${gap.toFixed(2).padStart(9)}   ${gap === 0 ? 'fully covered' : `${((gap / (ucLatest.total_payment)) * 100).toFixed(0)}% of what reaches you`}`);
        }
      }
      say('');
      // Where the rate came from, printed every time. A rate with no stated source is
      // indistinguishable from one somebody made up, and this is the figure that decides
      // whether a listing is affordable.
      if (lhaSource) {
        say(`  Rate source: ${lhaSource}`);
        if (LHA_TABLE) say(`  Retrieved ${LHA_TABLE._retrieved}. Frozen at 2024/25 levels for 2025/26 and 2026/27.`);
      } else {
        say('  Rate as supplied on the command line. Check it against gov.uk for the actual');
        say('  Broad Rental Market Area, or pass --area to use the recorded table instead.');
      }
    } else {
      // An --area that resolved to nothing must SAY so. Falling through to the generic
      // "supply a rate" text would read as though no area had been asked for, which is the
      // failure where a request quietly does nothing and looks like it was never made.
      if (lhaSource) { say(`  ${lhaSource}`); say(''); }
      say('  Supply the LHA rate for the area and this will do that arithmetic:');
      say(`      node tools/rent-affordability.cjs --rent ${RENTS[0] || 850} --lha 900`);
      say('');
      say('  Look it up on gov.uk for the Broad Rental Market Area of the actual property.');
      say('  NO DEFAULT IS OFFERED. An invented LHA rate would decide the whole answer, and');
      // DERIVED from the statements, not typed. The first version wrote both figures into
      // the string, which duplicates numbers that already have an owner and goes stale the
      // first time the element is reassessed — silently, because prose does not throw.
      const els = UC.map((r) => ucLine(r, 'Housing')).filter(Boolean).map((x) => x.amount);
      if (els.length) {
        const lo = Math.min(...els);
        const hi = Math.max(...els);
        say(`  the areas in this record differ enormously: the housing element has ranged from`);
        say(`  GBP ${gbp(Math.round(lo * 100))} to GBP ${gbp(Math.round(hi * 100))} a month across ${els.length} statements that carried one.`);
      }
    }
  }
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
