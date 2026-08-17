// Self-assessment preparation: five tax years of business-account figures.
//
//   node tools/tax-year-report.cjs            all years
//   node tools/tax-year-report.cjs 2023/2024  one year
//   node tools/tax-year-report.cjs --csv      machine-readable
//
// ------------------------------------------------------------------------------------
// THIS IS PREPARATION, NOT TAX ADVICE. It totals what the bank actually did. It does not
// decide what is allowable, and neither of us should pretend it can: that depends on
// receipts, on intent, and on rules this file does not encode. Take the figures to HMRC
// or an accountant; do not copy the groupings into a return unexamined.
//
// The honest headline, and the reason this file is shaped the way it is: TURNOVER is
// knowable from the bank with reasonable confidence. ALLOWABLE EXPENSES ARE LARGELY NOT,
// because the business account was used personally throughout and 37.7% of everything
// that left it was cash. A tool that produced a tidy expenses figure here would be
// inventing one.
// ------------------------------------------------------------------------------------
'use strict';

const db = require('../server/db');
require('../server/routes/finance');

const ACCOUNT = 'starling-business';

// UK tax year: 6 April to 5 April. Getting this boundary wrong by a day moves income
// between years, so it is computed in SQL from the date rather than from a year column.
const TAX_YEAR = `CASE WHEN date >= (substr(date,1,4) || '-04-06')
       THEN substr(date,1,4) || '/' || (CAST(substr(date,1,4) AS INTEGER) + 1)
       ELSE (CAST(substr(date,1,4) AS INTEGER) - 1) || '/' || substr(date,1,4) END`;

// How much can be said about each category, stated once so the report cannot quietly
// upgrade a guess into a deduction.
const CONFIDENCE = {
  'Income - people':    ['TURNOVER',       'Money received into the business account. High confidence it is income; what KIND of income still needs your knowledge.'],
  'Shopping':           ['MAYBE BUSINESS', 'Could be equipment or stock, could be personal. The bank cannot tell and neither can I.'],
  'Phone & internet':   ['MAYBE BUSINESS', 'Commonly part-allowable; the business/personal split is yours to state.'],
  'Transport':          ['MAYBE BUSINESS', 'Travel to jobs may be allowable; commuting generally is not.'],
  'Fuel':               ['MAYBE BUSINESS', 'Same distinction as Transport.'],
  'Travel':             ['MAYBE BUSINESS', 'Same distinction as Transport.'],
  'Fees & charges':     ['MAYBE BUSINESS', 'Bank charges on a business account are usually allowable.'],
  'Other':              ['MAYBE BUSINESS', 'Uncategorised. Needs looking at line by line.'],
  'Payments to people':  ['UNKNOWN',       'Transfers to named individuals. Could be wages, subcontractors, or personal. The direction default put them here; nothing has confirmed what they were.'],
  'Groceries':          ['LOOKS PERSONAL', 'Not normally an allowable business expense.'],
  'Eating out':         ['LOOKS PERSONAL', 'Subsistence rules are narrow; most of this will not qualify.'],
  'Entertainment':      ['LOOKS PERSONAL', 'Business entertaining is specifically disallowed; personal certainly is.'],
  'Subscriptions':      ['LOOKS PERSONAL', 'Some tools are allowable, most consumer subscriptions are not.'],
  'Gambling':           ['LOOKS PERSONAL', 'Not allowable.'],
  'Investing':          ['NOT AN EXPENSE', 'Moving money into an investment is not a cost.'],
  'Refunds':            ['REDUCES COSTS',  'Money back. Reduces the expense it came from rather than being income.'],
  'Cash withdrawn':     ['UNEVIDENCED',    'Left the account with no record of what it bought. No import will ever attribute it.'],
  'Housing':            ['MAYBE BUSINESS', 'Use-of-home rules exist but are specific.'],
};

const ORDER = ['TURNOVER', 'MAYBE BUSINESS', 'UNKNOWN', 'UNEVIDENCED', 'LOOKS PERSONAL', 'NOT AN EXPENSE', 'REDUCES COSTS'];
const gbp = (p) => (p / 100).toFixed(2);

function years() {
  return db.prepare(
    `SELECT ${TAX_YEAR} AS ty, MIN(date) a, MAX(date) b, COUNT(*) n
       FROM finance_transactions WHERE account_id = ? AND category <> 'Own transfer'
      GROUP BY ty ORDER BY ty`
  ).all(ACCOUNT);
}

function rows(ty) {
  return db.prepare(
    // n is the category total and is what the printed report shows. n_in / n_out are
    // per-direction, added for the CSV: it emits one row per direction, and repeating the
    // category total on both would state 56 transactions twice for the same 56.
    `SELECT category,
            SUM(CASE WHEN amount_pence > 0 THEN amount_pence ELSE 0 END) inn,
            SUM(CASE WHEN amount_pence < 0 THEN -amount_pence ELSE 0 END) out,
            COUNT(*) n,
            SUM(CASE WHEN amount_pence > 0 THEN 1 ELSE 0 END) n_in,
            SUM(CASE WHEN amount_pence < 0 THEN 1 ELSE 0 END) n_out
       FROM finance_transactions
      WHERE account_id = ? AND category <> 'Own transfer' AND ${TAX_YEAR} = ?
      GROUP BY category`
  ).all(ACCOUNT, ty);
}

function report() {
  const ys = years();
  const only = process.argv.slice(2).find((a) => /^\d{4}\/\d{4}$/.test(a));

  console.log('SELF-ASSESSMENT PREPARATION — business account, five tax years');
  console.log('Figures are what the bank did. Nothing here decides what is allowable.\n');

  const summary = [];

  for (const y of ys) {
    if (only && y.ty !== only) continue;
    const rs = rows(y.ty);
    const turnover = rs.filter((r) => (CONFIDENCE[r.category] || [])[0] === 'TURNOVER')
      .reduce((s, r) => s + r.inn, 0);
    const outTotal = rs.reduce((s, r) => s + r.out, 0);

    const byBand = new Map();
    for (const r of rs) {
      const band = (CONFIDENCE[r.category] || ['UNKNOWN'])[0];
      if (!byBand.has(band)) byBand.set(band, []);
      byBand.get(band).push(r);
    }

    console.log(`${'='.repeat(74)}`);
    console.log(`TAX YEAR ${y.ty}    ${y.n} transactions, ${y.a} to ${y.b}`);
    console.log(`${'='.repeat(74)}`);
    console.log(`  TURNOVER (money in)                              GBP ${gbp(turnover).padStart(11)}`);
    console.log(`  Everything that left the account                 GBP ${gbp(outTotal).padStart(11)}\n`);

    for (const band of ORDER) {
      const list = (byBand.get(band) || []).filter((r) => r.out > 0 || (band === 'TURNOVER' && r.inn > 0));
      if (!list.length) continue;
      const total = list.reduce((s, r) => s + (band === 'TURNOVER' ? r.inn : r.out), 0);
      console.log(`  ${band}   GBP ${gbp(total)}`);
      for (const r of list.sort((a, b) => b.out - a.out)) {
        const v = band === 'TURNOVER' ? r.inn : r.out;
        console.log(`      ${r.category.padEnd(20)} GBP ${gbp(v).padStart(10)}  (${r.n} rows)`);
      }
      console.log('');
    }

    const cash = (byBand.get('UNEVIDENCED') || []).reduce((s, r) => s + r.out, 0);
    const personal = (byBand.get('LOOKS PERSONAL') || []).reduce((s, r) => s + r.out, 0);
    const maybe = (byBand.get('MAYBE BUSINESS') || []).reduce((s, r) => s + r.out, 0);
    const unknown = (byBand.get('UNKNOWN') || []).reduce((s, r) => s + r.out, 0);

    console.log(`  WHAT THIS YEAR CAN AND CANNOT SUPPORT`);
    console.log(`      Turnover, well evidenced                     GBP ${gbp(turnover).padStart(11)}`);
    console.log(`      Costs that might be allowable, need receipts GBP ${gbp(maybe).padStart(11)}`);
    console.log(`      Transfers to people, purpose unknown         GBP ${gbp(unknown).padStart(11)}`);
    console.log(`      Cash, unattributable by any import           GBP ${gbp(cash).padStart(11)}   ${outTotal ? ((100 * cash) / outTotal).toFixed(1) : '0'}% of outgoings`);
    console.log(`      Personal spend on the business account       GBP ${gbp(personal).padStart(11)}\n`);

    summary.push({ ty: y.ty, turnover, outTotal, maybe, unknown, cash, personal });
  }

  if (only) return;

  console.log('='.repeat(74));
  console.log('FIVE YEARS AT A GLANCE');
  console.log('='.repeat(74));
  console.log('  year        turnover      out    maybe-biz    unknown       cash   personal');
  for (const s of summary) {
    console.log(`  ${s.ty}  ${gbp(s.turnover).padStart(10)} ${gbp(s.outTotal).padStart(9)} ${gbp(s.maybe).padStart(11)} ${gbp(s.unknown).padStart(10)} ${gbp(s.cash).padStart(10)} ${gbp(s.personal).padStart(10)}`);
  }
  const t = (k) => summary.reduce((a, b) => a + b[k], 0);
  console.log(`  ${'TOTAL'.padEnd(10)} ${gbp(t('turnover')).padStart(10)} ${gbp(t('outTotal')).padStart(9)} ${gbp(t('maybe')).padStart(11)} ${gbp(t('unknown')).padStart(10)} ${gbp(t('cash')).padStart(10)} ${gbp(t('personal')).padStart(10)}`);

  console.log(`
WHAT TO DO WITH THIS

  1. Turnover is the figure you can most nearly stand behind. Check it against invoices —
     the bank shows money arriving, not what it was for.

  2. Do NOT treat "maybe business" as an expenses total. It is a shortlist to go through
     with receipts, and some of it will not survive.

  3. GBP ${gbp(t('cash'))} of cash is the single largest thing here and no software will
     ever attribute it. If any of it was business spending, only receipts or your own
     records can show that.

  4. GBP ${gbp(t('personal'))} of clearly personal spending went out of the business
     account. That is not a tax deduction and it is the argument for separating the two.

  5. Transfers to named people, GBP ${gbp(t('unknown'))}, are the biggest genuine unknown.
     Wages and subcontractor payments are treated very differently from personal transfers,
     and only you know which these were.

This file totals transactions. It does not know what is allowable, whether you are within
any allowance, or which years remain open to amend. Check those with HMRC or an accountant.`);
}


// ------------------------------------------------------------------------------------
// ITEM 34 — "limited company compliant within 2 years, urgency scales by income".
// Answered with the user's OWN criterion rather than an opinion about incorporation.
// ------------------------------------------------------------------------------------
function incorporationCheck() {
  const rows = db.prepare(
    `SELECT ${TAX_YEAR} AS ty,
            SUM(CASE WHEN amount_pence > 0 THEN amount_pence ELSE 0 END) inn,
            COUNT(CASE WHEN amount_pence > 0 THEN 1 END) n
       FROM finance_transactions
      WHERE account_id = ? AND category <> 'Own transfer'
      GROUP BY ty ORDER BY ty`
  ).all(ACCOUNT);

  const last = db.prepare(
    `SELECT date FROM finance_transactions
      WHERE account_id = ? AND amount_pence > 0 AND category <> 'Own transfer'
      ORDER BY date DESC LIMIT 1`
  ).get(ACCOUNT);

  const daysSince = Math.round((Date.now() - new Date(last.date).getTime()) / 86400000);

  console.log('\n' + '='.repeat(74));
  console.log('LIMITED COMPANY — YOUR RULE WAS "URGENCY SCALES WITH INCOME"');
  console.log('='.repeat(74));
  rows.forEach((r) => {
    const bar = '#'.repeat(Math.round((r.inn / 100) / 500));
    console.log(`  ${r.ty}  GBP ${gbp(r.inn).padStart(9)}  ${String(r.n).padStart(3)} payments  ${bar}`);
  });
  console.log(`
  Last money into the business account: ${last.date} — ${daysSince} days ago.`);
  console.log(`
  Applying your own criterion: turnover fell from GBP ${gbp(rows[0].inn)} to
  GBP ${gbp(rows[rows.length - 1].inn)} across five years, and nothing has come in for
  ${daysSince} days. Urgency scales with income; there is currently no income to scale it
  with, so by the rule you set the urgency is nil.

  Incorporating a company that is not trading does not reduce work — it adds annual
  accounts, a confirmation statement and a corporation tax return whether or not the
  company earns anything, and those obligations start immediately.

  The figure that would change this is turnover returning. That is worth a trigger rather
  than a date: revisit when the business account takes in money again, not in two years
  because a note said so. Nothing here is tax or company-law advice — check the position
  with an accountant before acting either way.`);
}

// The machine-readable form, for handing to an accountant or opening in a spreadsheet.
// It was in this file's usage text from the start and was never implemented — the flag
// was accepted and silently ignored, so `--csv` printed the human report and looked like
// it had worked.
//
// It reads years() and rows() — the SAME functions the printed report uses — rather than
// running its own queries. A second query here would be a second owner for every figure,
// and the two would drift the first time either was touched.
function csv() {
  const only = process.argv.slice(2).find((a) => /^\d{4}\/\d{4}$/.test(a));
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const out = [[
    'tax_year', 'period_from', 'period_to', 'category', 'confidence',
    'direction', 'amount_gbp', 'transactions', 'what_it_means',
  ].map(cell).join(',')];

  for (const y of years()) {
    if (only && y.ty !== only) continue;
    for (const r of rows(y.ty)) {
      const [bucket, note] = CONFIDENCE[r.category] || ['UNKNOWN', 'No confidence rule for this category.'];
      // In and out are emitted as separate rows. Netting them would hide a category that
      // both received and spent, and refunds are exactly that case.
      for (const [dir, pence, count] of [['in', r.inn, r.n_in], ['out', r.out, r.n_out]]) {
        if (!pence) continue;
        out.push([y.ty, y.a, y.b, r.category, bucket, dir, gbp(pence), count, note].map(cell).join(','));
      }
    }
  }

  // A CSV cannot carry the caveats the printed report leads with, and those caveats are
  // the difference between preparation and a filing. So it says so in its own last row
  // rather than letting a tidy grid imply more certainty than the data supports.
  out.push('');
  out.push(cell('NOTE: figures are what the bank did. Nothing here decides what is allowable. '
    + 'Cash withdrawals are unattributable, the business account was used personally throughout, '
    + 'and "maybe business" is a shortlist to check against receipts, not an expenses total. '
    + 'Run the tool without --csv for the full caveats.'));

  process.stdout.write('﻿' + out.join('\r\n') + '\r\n');
}

if (process.argv.includes('--csv')) {
  csv();
} else {
  report();
  // Only on the all-years run: the check is about the trend, so a single-year view would
  // show it against one point.
  if (!process.argv.slice(2).find((a) => /^\d{4}\/\d{4}$/.test(a))) incorporationCheck();
}
