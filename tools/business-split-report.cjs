// Todo 14 evidence: what is sitting in the wrong account, and what the business account
// cannot evidence. Facts and totals only — this is not tax advice and does not decide
// what is deductible.
//
//   node tools/business-split-report.cjs
'use strict';

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('claude');
require('../server/routes/finance');

const gbp = (p) => `GBP ${(p / 100).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);

console.log('BUSINESS / PERSONAL SPLIT — evidence for moving the business banking\n');
console.log('The business flag currently comes from the ACCOUNT the money left, which is the');
console.log('strongest evidence available and still only an assumption. Anything below that');
console.log('contradicts it is a row worth a decision.\n');

// ---------------------------------------------------------------------------------
// 1. Business-looking spend paid from the PERSONAL account.
// Evidence-led, not guessed: a merchant counts only if the BUSINESS account has also
// paid it, or it is unambiguously trade licensing. That control matters — without it
// this is a list of things that merely sound work-related.
// ---------------------------------------------------------------------------------
// FIRST ATTEMPT WAS WRONG AND IS WORTH RECORDING. The test was "the business account has
// also paid this merchant", which produced 200+ rows — because for a sole trader both
// accounts buy from Amazon, CeX and Argos. It was a correct answer to a far broader
// question than the one asked, and it looked like a finding.
//
// The test that means something is SKEW: a merchant the business account pays and the
// personal account essentially does not. Overlap is normal life; skew is a signal.
const skew = db.prepare(
  `SELECT LOWER(TRIM(counterparty)) AS cp,
          SUM(CASE WHEN account_id = 'starling-business' THEN 1 ELSE 0 END) AS biz,
          SUM(CASE WHEN account_id = 'starling-personal' THEN 1 ELSE 0 END) AS per
     FROM finance_transactions
    WHERE amount_pence < 0 AND category <> 'Own transfer'
    GROUP BY cp`
).all();

const MIN_BIZ = 3;        // one purchase is not a pattern
const MIN_SHARE = 0.8;    // at least 4 in 5 of this merchant's rows are on the business card
const bizMerchants = new Set(
  skew.filter((r) => r.biz >= MIN_BIZ && r.biz / (r.biz + r.per) >= MIN_SHARE).map((r) => r.cp)
);
const excludedOverlap = skew.filter((r) => r.biz > 0 && !bizMerchants.has(r.cp)).length;

const personalOut = db.prepare(
  `SELECT id, date, counterparty, reference, category, amount_pence
   FROM finance_transactions
   WHERE account_id = 'starling-personal' AND amount_pence < 0 AND category <> 'Own transfer'
     AND category <> 'Cash withdrawn'
   ORDER BY amount_pence ASC`
).all();

const LICENSING = /securit(y)? industry|get licensed|sia |dbs |licen[cs]/i;

const misplaced = personalOut.filter((t) => {
  const cp = t.counterparty.trim().toLowerCase();
  return bizMerchants.has(cp) || LICENSING.test(t.counterparty) || LICENSING.test(t.reference || '');
});

console.log('1. BUSINESS-LOOKING SPEND PAID FROM THE PERSONAL ACCOUNT');
console.log(`   Test: trade licensing, or a merchant with >=${MIN_BIZ} business rows and`);
console.log(`   >=${MIN_SHARE * 100}% of its rows on the business account.\n`);
let mTotal = 0;
misplaced.slice(0, 40).forEach((t) => {
  console.log(`   ${t.date}  ${pad(gbp(-t.amount_pence), 12)}${pad(t.category, 18)}${t.counterparty.slice(0, 34)}`);
});
misplaced.forEach((t) => { mTotal += -t.amount_pence; });
if (misplaced.length > 40) console.log(`   ... and ${misplaced.length - 40} more`);
console.log(`   ${'-'.repeat(72)}`);
console.log(`   ${misplaced.length} rows, ${gbp(mTotal)} over five years`);

// A filter that drops candidates must say what it dropped, or the survivors look cleaner
// than they are. And it must say what it does NOT key on.
console.log(`\n   RESIDUE: ${excludedOverlap} merchants appear on BOTH accounts but failed the skew`);
console.log('   test, so they are excluded here. That is normal overlap, not evidence of');
console.log('   anything — Amazon, CeX and Argos are on both because life overlaps.');
console.log('   NOT keyed on: amount, date, or what was actually bought. A business laptop and');
console.log('   a personal one from the same shop are indistinguishable to this test.\n');

// ---------------------------------------------------------------------------------
// 2. The reverse. Mixing runs both ways and only naming one direction would flatter it.
// ---------------------------------------------------------------------------------
const personalCats = new Set(['Groceries', 'Eating out', 'Entertainment', 'Gambling', 'Subscriptions']);
const reverse = db.prepare(
  `SELECT date, counterparty, category, amount_pence
   FROM finance_transactions
   WHERE account_id = 'starling-business' AND amount_pence < 0
   ORDER BY amount_pence ASC`
).all().filter((t) => personalCats.has(t.category));

const revByCat = new Map();
reverse.forEach((t) => revByCat.set(t.category, (revByCat.get(t.category) || 0) + -t.amount_pence));
const revTotal = [...revByCat.values()].reduce((a, b) => a + b, 0);

console.log('2. PERSONAL-LOOKING SPEND PAID FROM THE BUSINESS ACCOUNT');
[...revByCat].sort((a, b) => b[1] - a[1]).forEach(([c, v]) =>
  console.log(`   ${pad(c, 20)}${gbp(v)}`));
console.log(`   ${'-'.repeat(72)}`);
console.log(`   ${reverse.length} rows, ${gbp(revTotal)}\n`);

// ---------------------------------------------------------------------------------
// 3. The one that dwarfs both.
// ---------------------------------------------------------------------------------
const cash = db.prepare(
  `SELECT COUNT(*) n, SUM(-amount_pence) p, MIN(date) a, MAX(date) b
   FROM finance_transactions
   WHERE account_id = 'starling-business' AND category = 'Cash withdrawn' AND amount_pence < 0`
).get();
const bizSpend = db.prepare(
  `SELECT SUM(-amount_pence) p FROM finance_transactions
   WHERE account_id = 'starling-business' AND amount_pence < 0 AND category <> 'Own transfer'`
).get().p;

console.log('3. CASH OUT OF THE BUSINESS ACCOUNT — unattributed by construction');
console.log(`   ${cash.n} withdrawals, ${gbp(cash.p)}, ${cash.a} to ${cash.b}`);
console.log(`   That is ${((100 * cash.p) / bizSpend).toFixed(1)}% of all business outgoings.`);
console.log('   The ledger cannot say what any of it bought, and no import ever will.');
console.log('   It is larger than every other finding here combined.\n');

// ---------------------------------------------------------------------------------
// 4. Per tax year, for whoever does the self-assessment.
// ---------------------------------------------------------------------------------
console.log('4. BUSINESS ACCOUNT BY UK TAX YEAR (6 April to 5 April)');
console.log(`   ${pad('year', 12)}${pad('money in', 14)}${pad('money out', 14)}${pad('of which cash', 14)}`);
db.prepare(
  `SELECT CASE WHEN date >= (CAST(substr(date,1,4) AS INTEGER) || '-04-06')
               THEN substr(date,1,4) || '/' || (CAST(substr(date,1,4) AS INTEGER) + 1)
               ELSE (CAST(substr(date,1,4) AS INTEGER) - 1) || '/' || substr(date,1,4) END AS ty,
          SUM(CASE WHEN amount_pence > 0 THEN amount_pence ELSE 0 END) inn,
          SUM(CASE WHEN amount_pence < 0 THEN -amount_pence ELSE 0 END) out,
          SUM(CASE WHEN amount_pence < 0 AND category = 'Cash withdrawn' THEN -amount_pence ELSE 0 END) cash
     FROM finance_transactions
    WHERE account_id = 'starling-business' AND category <> 'Own transfer'
    GROUP BY ty ORDER BY ty`
).all().forEach((r) => console.log(
  `   ${pad(r.ty, 12)}${pad(gbp(r.inn), 14)}${pad(gbp(r.out), 14)}${pad(gbp(r.cash), 14)}`));

console.log('\nNOTE: figures exclude Own transfer, which is movement between your two accounts');
console.log('and would otherwise be counted twice. Nothing here decides what is deductible.');
