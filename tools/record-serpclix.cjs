#!/usr/bin/env node
//
// record-serpclix.cjs — the SerpClix payment history, which exists nowhere else.
//
//   node tools/record-serpclix.cjs --dry
//   node tools/record-serpclix.cjs
//
// WHY THIS IS TYPED IN WHEN ALMOST NOTHING HERE IS. Measured first: SerpClix appears in none of
// 6,839 bank transactions, because PayPal pays and the bank line reads only PAYPAL; and it has
// never sent a payment email -- 5 messages in 69,000, all password resets and verification.
// There is no API without credentials. So this history is genuinely underivable, which is the
// one case CLAUDE.md allows manual capture for, and it is a ONE-OFF backfill rather than a
// surface that needs feeding: future months arrive through PayPal.
//
// EVERYTHING IS USD. SerpClix pays in dollars and the ledger is in pence. No rate is applied
// here -- the entries carry currency 'USD' and are never summed with GBP figures. Converting
// would invent a number nobody can audit, and it would be wrong by the time anyone read it.
//
// THE VISIBLE LIST IS INCOMPLETE AND THE SCRIPT PROVES IT. The page shows twelve payments and
// states a lifetime total; those two do not agree, because older payments sit behind a "Show
// earlier payments" control. The gap is computed and reported rather than glossed, so nobody
// later reads this as the whole history.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// A backfill of the owner's own payment history, transcribed from the service's page. Not 'you' -- he did not type these rows -- and not 'claude', because the figures are his rather than mine. It is data arriving from an outside source.
db.setProcessActor('import');
require('../server/routes/income');

const DRY = process.argv.includes('--dry');
const STREAM = 'serpclix';

// Read off the account's own earnings page, 18 Aug 2026. Dates are the payment dates SerpClix
// shows; it pays at the start of each month for the previous month's clicks.
const PAYMENTS = [
  ['2026-08-01', 60.45], ['2026-02-01', 7.00], ['2024-03-01', 4.35], ['2023-05-01', 4.40],
  ['2023-04-01', 5.15], ['2023-03-01', 4.35], ['2020-12-01', 10.00], ['2020-11-01', 21.65],
  ['2020-10-01', 22.40], ['2020-09-01', 27.35], ['2020-08-01', 13.45], ['2020-07-01', 19.05],
];

// Stated by the page itself, and the check that makes the residue visible.
const STATED_TOTAL_PAID = 235.60;
const UNPAID_BALANCE = 27.55;

const usd = (n) => `$${n.toFixed(2)}`;
const shown = PAYMENTS.reduce((a, p) => a + p[1], 0);
const hidden = Math.round((STATED_TOTAL_PAID - shown) * 100) / 100;

console.log(`\n  payments listed on the page : ${PAYMENTS.length}  ${usd(shown)}`);
console.log(`  lifetime total it states    : ${usd(STATED_TOTAL_PAID)}`);
console.log(`  therefore NOT yet recorded  : ${usd(hidden)} behind "Show earlier payments"`);

if (hidden < -0.005) {
  console.log('\n  The listed payments EXCEED the stated total, which means one of the two was');
  console.log('  read wrong. Not writing anything: a backfill built on a misread total is worse');
  console.log('  than no backfill, because it looks authoritative.');
  process.exit(1);
}

console.log(`\n  unpaid balance             : ${usd(UNPAID_BALANCE)}  (earned, NOT yet paid)`);
console.log('  Recorded as a note rather than an entry: it is a receivable, not income received,');
console.log('  and entering it would count it again when it is actually paid on 1 September.');

if (DRY) {
  console.log('\n  --dry: nothing written. Entries that would be created:');
  for (const [day, amt] of PAYMENTS) console.log(`    ${day}  ${usd(amt)}`);
  process.exit(0);
}

const ins = db.prepare(`
  INSERT INTO income_entries (stream_id, period, amount_pence, currency, effort_minutes, recorded_at)
  VALUES (?, ?, ?, 'USD', NULL, datetime('now'))`);

const existing = new Set(
  db.prepare("SELECT period FROM income_entries WHERE stream_id = ? AND currency = 'USD'")
    .all(STREAM).map((r) => r.period)
);

let wrote = 0, already = 0;
db.withTransaction(() => {
  for (const [day, amt] of PAYMENTS) {
    if (existing.has(day)) { already += 1; continue; }
    ins.run(STREAM, day, Math.round(amt * 100));
    wrote += 1;
  }
});

// Verify by re-reading, not by trusting the insert count.
const back = db.prepare(
  "SELECT COUNT(*) n, SUM(amount_pence) p FROM income_entries WHERE stream_id = ? AND currency = 'USD'"
).get(STREAM);

console.log(`\n  wrote ${wrote}, already held ${already}`);
console.log(`  read back: ${back.n} USD entries totalling ${usd((back.p || 0) / 100)}`);
if (Math.abs((back.p || 0) / 100 - shown) > 0.005) {
  console.log('  MISMATCH against the listed payments. Investigate before trusting any total.');
  process.exitCode = 1;
} else {
  console.log('  Matches the payments listed on the page.');
}
console.log(`\n  Still missing ${usd(hidden)} of older payments. Open "Show earlier payments"`);
console.log('  and add them here to complete the history.');
