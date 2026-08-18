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
    console.log(`\n  payouts on record: ${rows.length}`);
    for (const r of rows.slice(0, 8)) {
      const when = String(pick(r, 'created_at', 'date', 'paid_at') || '').slice(0, 10);
      const amt = pick(r, 'usd_cents', 'amount_cents');
      console.log(`    ${when || '(no date)'}  ${amt != null ? `$${(amt / 100).toFixed(2)}` : '(no amount)'}  ${pick(r, 'status') || ''}`);
    }

    if (RECORD) {
      const db = require('../server/db');
      require('../server/routes/income');
      const ins = db.prepare(`INSERT INTO income_entries (stream_id, period, amount_pence, currency, recorded_at)
                              VALUES ('honeygain', ?, ?, 'USD', datetime('now'))`);
      const have = new Set(db.prepare("SELECT period FROM income_entries WHERE stream_id='honeygain'").all().map((r) => r.period));
      let wrote = 0, skipped = 0;
      db.withTransaction(() => {
        for (const r of rows) {
          const when = String(pick(r, 'created_at', 'date', 'paid_at') || '').slice(0, 10);
          const amt = pick(r, 'usd_cents', 'amount_cents');
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
