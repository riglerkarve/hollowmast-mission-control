#!/usr/bin/env node
//
// fetch-honeygain.cjs — Honeygain earnings, without a daily obligation on anyone.
//
//   node tools/fetch-honeygain.cjs            read and report
//   node tools/fetch-honeygain.cjs --record   also write payouts as income entries
//
// THE TOKEN LIVES IN data/honeygain-token.txt AND IS NEVER PRINTED. That path was added to
// .gitignore BEFORE the file could exist, and the ignore was proved with a decoy: a credential
// committed once is committed for good, and the dangerous window is the minute between creating
// the file and remembering to ignore it. Nothing here echoes the token, including in errors —
// a failure report that quotes a secret has leaked it a second time.
//
// WHY THIS AND NOT DAILY SCREENSHOTS. A screenshot a day is 365 obligations a year and two ways
// to lapse: the owner must send it and a session must be running to read it. Worse, when it
// lapses the series has holes, and a gap is indistinguishable from a genuinely zero day. This
// needs nothing from anybody once the token is in place.
//
// AN EXPIRED TOKEN MUST NOT LOOK LIKE ZERO EARNINGS, which is the whole reason this file is
// longer than a fetch. A 401 is reported as "could not look" and exits non-zero; only a real
// answer from the API is ever recorded. Tokens expire, so this WILL happen, and the day it does
// the record must not quietly gain a run of zeroes.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, 'data', 'honeygain-token.txt');
const RECORD = process.argv.includes('--record');
const BASE = 'https://dashboard.honeygain.com/api/v1';

function token() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim().replace(/^Bearer\s+/i, '');
  return t.length > 20 ? t : null;
}

async function get(pathname, tok) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported below as a shape problem */ }
  return { status: res.status, json, raw: text.slice(0, 200) };
}

(async () => {
  const tok = token();
  if (!tok) {
    console.log('\n  COULD NOT LOOK: no usable token at data/honeygain-token.txt');
    console.log('  This is not "zero earnings". Put the bearer token in that file — it is');
    console.log('  already gitignored, and the ignore was verified with a decoy.');
    process.exit(2);
  }

  const balances = await get('/users/balances', tok);

  if (balances.status === 401 || balances.status === 403) {
    console.log(`\n  COULD NOT LOOK: Honeygain answered ${balances.status}. The token is expired or revoked.`);
    console.log('  Nothing was recorded. An expired token must never be filed as a run of zero');
    console.log('  earning days — replace the token and run again.');
    process.exit(2);
  }
  if (balances.status !== 200 || !balances.json) {
    console.log(`\n  COULD NOT LOOK: unexpected reply ${balances.status}.`);
    console.log(`  First bytes: ${balances.raw.replace(/\s+/g, ' ')}`);
    console.log('  Reporting the shape rather than guessing at it.');
    process.exit(2);
  }

  // The API's shape is not guaranteed stable, so read defensively and SAY when a field is
  // missing rather than defaulting it to zero.
  const d = balances.json.data || balances.json;
  const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null) return o[k]; } return null; };
  const payout = pick(d, 'payout') || {};
  const realtime = pick(d, 'realtime') || {};

  const cents = pick(payout, 'usd_cents');
  const credits = pick(payout, 'credits');
  const rtCents = pick(realtime, 'usd_cents');

  console.log('');
  if (cents == null && credits == null) {
    console.log('  The reply parsed but carried no payout balance in the expected fields.');
    console.log(`  Keys seen: ${Object.keys(d).join(', ') || '(none)'}`);
    console.log('  Not recording anything: a missing field is not a zero.');
    process.exit(2);
  }
  if (cents != null) console.log(`  payout balance   : $${(cents / 100).toFixed(2)}${credits != null ? `  (${credits} credits)` : ''}`);
  if (rtCents != null) console.log(`  realtime balance : $${(rtCents / 100).toFixed(2)}`);

  // Payout history, which is the only thing that is actually income. The balance is an
  // accrual: recording it as earnings would count the same money again when it is paid.
  const hist = await get('/payouts', tok);
  const rows = (hist.json && (hist.json.data || hist.json.payouts)) || [];
  if (hist.status !== 200) {
    console.log(`\n  payout history unavailable (${hist.status}) — balance above is still good.`);
  } else if (!Array.isArray(rows)) {
    console.log('\n  payout history came back in an unexpected shape; not recording it.');
  } else {
    // THE FIELD NAMES WERE GUESSED WRONG FIRST TIME, and the guard is why that was visible
    // rather than silent: every row printed "(no amount)" instead of "$0.00". Honeygain's
    // actual shape is { method, status, requested_amount, created_at }.
    //
    // requested_amount is in CREDITS, not cents. The ratio is 1000 credits to the dollar,
    // confirmed against the account's own dashboard: 20,478.35 credits displayed as $20.48.
    // So cents = credits / 10. Anything that assumed cents would have reported a payout as
    // a hundred times its real value.
    const payoutCents = (r) => {
      const c = pick(r, 'requested_amount');
      return c == null ? null : Math.round(Number(c) / 10);
    };
    console.log(`\n  payouts on record: ${rows.length}`);
    let missing = 0;
    for (const r of rows.slice(0, 10)) {
      const when = String(pick(r, 'created_at', 'date', 'paid_at') || '').slice(0, 10);
      const amt = payoutCents(r);
      if (amt == null) missing += 1;
      console.log(`    ${when || '(no date)'}  ${amt != null ? `$${(amt / 100).toFixed(2)}`.padStart(8) : '(no amount)'}`
        + `  ${pick(r, 'status') || ''}  via ${pick(r, 'method') || '(unknown)'}`);
    }
    const paid = rows.map(payoutCents).filter((c) => c != null).reduce((a, c) => a + c, 0);
    console.log(`    ${'-'.repeat(46)}`);
    console.log(`    lifetime paid: $${(paid / 100).toFixed(2)} across ${rows.length} payouts`
      + (missing ? `  (${missing} with no readable amount)` : ''));

    // Where the money actually lands decides whether any of this can ever be automatic.
    const methods = [...new Set(rows.map((r) => pick(r, 'method')).filter(Boolean))];
    if (methods.length) {
      console.log(`\n  paid via: ${methods.join(', ')}`);
      if (!methods.some((m) => /paypal/i.test(m))) {
        console.log('  NOT PayPal — so these payouts will never appear in the PayPal export,');
        console.log('  and the bank sees only whatever that processor finally deposits.');
      }
    }

    if (RECORD) {
      const db = require('../server/db');
      const income = require('../server/routes/income');

      // THE BALANCE IS A DAILY SNAPSHOT, NOT INCOME. It is money that has accrued and has not
      // been paid; recording it as earnings would count the same dollars again on payout day.
      // One row per stream per day, so a briefing that runs twice cannot invent a second day.
      if (cents != null) {
        const day = new Date().toISOString().slice(0, 10);
        income.recordBalance('honeygain', day, cents, 'USD', 'honeygain-api');
        console.log(`\n  balance snapshot recorded for ${day}: $${(cents / 100).toFixed(2)}`);

        const rate = income.earningRate('honeygain', 30);
        if (rate.state === 'ok' && rate.perDayAvg != null) {
          const gaps = rate.gapsSkipped ? `, ${rate.gapsSkipped} gap(s) skipped` : '';
          console.log(`  earning rate: $${(rate.perDayAvg / 100).toFixed(4)}/day over ${rate.cleanDays} whole day(s)${gaps}`);
        } else {
          console.log(`  earning rate: ${rate.why || 'not yet computable'}`);
        }
      }

      const ins = db.prepare(`INSERT INTO income_entries (stream_id, period, amount_pence, currency, recorded_at)
                              VALUES ('honeygain', ?, ?, 'USD', datetime('now'))`);
      const have = new Set(db.prepare("SELECT period FROM income_entries WHERE stream_id='honeygain'").all().map((r) => r.period));
      let wrote = 0, skipped = 0;
      db.withTransaction(() => {
        for (const r of rows) {
          const when = String(pick(r, 'created_at', 'date', 'paid_at') || '').slice(0, 10);
          const amt = payoutCents(r);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(when) || amt == null) { skipped += 1; continue; }
          if (have.has(when)) { skipped += 1; continue; }
          ins.run(when, amt);
          wrote += 1;
        }
      });
      const back = db.prepare("SELECT COUNT(*) n, SUM(amount_pence) p FROM income_entries WHERE stream_id='honeygain'").get();
      console.log(`\n  wrote ${wrote}, skipped ${skipped} (already held, or missing a date or amount)`);
      console.log(`  read back: ${back.n} entries totalling $${((back.p || 0) / 100).toFixed(2)}`);
    } else {
      console.log('\n  Report only. Add --record to write payouts as income entries.');
    }
  }

  console.log('\n  USD, never converted. The balance is an accrual and is deliberately not');
  console.log('  recorded as income: it would be counted twice when it is actually paid.');
})().catch((e) => {
  // Deliberately does not print the error object, which could carry the request headers.
  console.log(`\n  COULD NOT LOOK: ${String(e && e.message || e).slice(0, 120)}`);
  process.exit(2);
});
