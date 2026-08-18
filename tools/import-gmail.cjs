#!/usr/bin/env node
//
// import-gmail.cjs — pull Gmail METADATA into dashboard.db. Backlog #M37.
//
//   node tools/import-gmail.cjs                 newest first, default budget
//   node tools/import-gmail.cjs --max 2000      how many messages to fetch this run
//   node tools/import-gmail.cjs --account <a>   one mailbox instead of all
//   node tools/import-gmail.cjs --dry           fetch nothing, report what it would do
//
// ---------------------------------------------------------------------------------------
// IT LOOPS ACCOUNTS. There are two, and an importer written against "the" account would
// index one mailbox and report success — the shape of failure this project keeps meeting.
// Every account is reported SEPARATELY; there is no aggregate "done".
//
// IT NEVER CLAIMS COMPLETENESS. 65,565 messages in one mailbox is ~660 batched requests, so
// a run is bounded and the bound is stated. Each run records a high-water mark and reports
// COVERAGE — held / mailbox estimate — because an importer that says "finished" while
// holding 3% is exactly the flattering filter this codebase has been bitten by.
//
// SUBJECTS ARE STORED (owner decision, 18 Aug) and are loopback-only on the way OUT; that is
// enforced in server/routes/mail.js, not here. This file's job is to fetch and record.
// The scope is gmail.metadata, so a body cannot be returned even if this asked for one.
// ---------------------------------------------------------------------------------------
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('import');
require('../server/routes/mail');           // ensures the migration has run
const ga = require('./google-auth.cjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const DRY = args.includes('--dry');
const MAX = Number(flag('--max', 1500));
const ONLY = flag('--account', null);

// 25, not Gmail's documented 100. A 100-item batch is 100 CONCURRENT requests to Gmail and
// it 429s the excess -- measured, 41 of 100 throttled. The cap that matters is concurrency,
// not the documented batch size, and they are not the same number.
const BATCH = 25;
const PAGE = 500;                           // Gmail's cap for messages.list

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A single batch request carrying up to 100 messages.get calls. One round trip instead of a
// hundred; without this a 1,500-message run is 1,500 requests and minutes of latency.
async function getBatch(token, ids) {
  const boundary = 'mc_' + Math.abs(ids.length * 2654435761 % 1e9).toString(36);
  const parts = ids.map((id, i) => [
    `--${boundary}`,
    'Content-Type: application/http',
    `Content-ID: <item${i}>`,
    '',
    `GET /gmail/v1/users/me/messages/${id}?format=metadata`
      + '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',
    '',
  ].join('\r\n'));
  const body = parts.join('\r\n') + `\r\n--${boundary}--\r\n`;

  const res = await fetch('https://gmail.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`batch ${res.status}: ${(await res.text()).slice(0, 200)}`);

  // THE RESPONSE BOUNDARY IS GOOGLE'S, NOT THE ONE WE SENT. It replies with its own
  // (batch_JkyXlsg…) and announces it in content-type. Splitting on the REQUEST boundary
  // matched nothing, so the entire body parsed as one malformed chunk and every batch
  // silently returned zero messages — a 400-message run wrote 0 rows and threw no error.
  // Read the boundary out of the reply rather than assuming symmetry.
  const ct = res.headers.get('content-type') || '';
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const respBoundary = m ? (m[1] || m[2]).trim() : boundary;

  const text = await res.text();
  const messages = [];
  const throttled = [];
  const failed = [];

  for (const chunk of text.split(`--${respBoundary}`)) {
    const start = chunk.indexOf('{');
    if (start === -1) continue;
    // Which request this part answers. Google echoes Content-ID: <response-itemN>, and N
    // indexes the ids we sent — the only way to know WHICH message was throttled.
    const idx = (chunk.match(/Content-ID:\s*<response-item(\d+)>/i) || [])[1];
    const id = idx !== undefined ? ids[Number(idx)] : null;
    let body;
    try { body = JSON.parse(chunk.slice(start, chunk.lastIndexOf('}') + 1)); } catch { failed.push({ id, code: 'unparseable' }); continue; }

    // A PER-ITEM ERROR ARRIVES INSIDE A 200 BATCH. Gmail treats a 100-item batch as 100
    // concurrent requests and returns 429 "Too many concurrent requests for user" for the
    // excess — measured, 41 of 100. Counting those as unparseable made a rate limit look
    // like a message that did not exist, and 45% of a run vanished with no error anywhere.
    if (body.error) {
      if (body.error.code === 429 || body.error.code === 403) throttled.push(id);
      else failed.push({ id, code: body.error.code, message: String(body.error.message || '').slice(0, 80) });
      continue;
    }
    if (body.id) messages.push(body);
  }

  if (!messages.length && !throttled.length && !failed.length && ids.length) {
    throw new Error(`batch returned ${text.length} bytes but nothing recognisable`);
  }
  return { messages, throttled, failed };
}

const header = (m, name) => {
  const h = (m.payload && m.payload.headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
};

// "Jon <a@b.com>" -> { name: 'Jon', addr: 'a@b.com' }. Falls back to the raw string rather
// than dropping it: an unparseable sender is still a sender.
function splitFrom(v) {
  if (!v) return { name: null, addr: null };
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, addr: m[2].trim().toLowerCase() };
  return { name: null, addr: v.trim().toLowerCase() };
}

async function importAccount(account) {
  const token = await ga.accessToken(account);
  if (!token) return { account, ok: false, why: 'no usable credential — consent may have been withdrawn' };

  const prior = db.prepare('SELECT * FROM gmail_sync WHERE account = ?').get(account) || {};
  const held0 = db.prepare('SELECT COUNT(*) AS n FROM gmail_messages WHERE account = ?').get(account).n;

  // Newest first. The high-water mark lets a later run stop as soon as it meets known
  // ground instead of walking the whole mailbox again.
  const stopAt = prior.newest_seen_ms || 0;

  // THE MAILBOX TOTAL COMES FROM THE PROFILE, NOT FROM resultSizeEstimate. The dry run
  // caught this: with maxResults 300, list returned resultSizeEstimate 301 for a mailbox of
  // 65,565. It estimates the RESULT SET in page context, not the mailbox — so coverage would
  // have read 100% while holding half a percent, which is precisely the flattering figure
  // this importer exists not to produce. profile.messagesTotal is the real count.
  let estimate = null;
  {
    const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (p.ok) { const pb = await p.json(); estimate = pb.messagesTotal ?? null; }
  }

  const heldIds = new Set(db.prepare('SELECT id FROM gmail_messages WHERE account = ?')
    .all(account).map((r) => r.id));
  let stoppedEarly = false;
  const ids = [];
  let pageToken = null;
  do {
    const u = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    u.searchParams.set('maxResults', String(Math.min(PAGE, MAX - ids.length)));
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return { account, ok: false, why: `list ${r.status}: ${(await r.text()).slice(0, 160)}` };
    const b = await r.json();
    const page = (b.messages || []).map((m) => m.id);
    page.forEach((id) => ids.push(id));
    pageToken = b.nextPageToken;
    // STOP ONCE A WHOLE PAGE IS ALREADY HELD. Gmail lists newest first, so a page with no
    // unknown id means everything past it is known too.
    //
    // This is the high-water mark the comment above USED to claim while the code did not
    // have it: stopAt was computed and then only reported. Every incremental run re-listed
    // and re-fetched a full --max and let INSERT ... ON CONFLICT discard the duplicates,
    // which is invisible because the row count still comes out right. Measured before the
    // fix: listed 300, wrote 11.
    //
    // It keys on IDS rather than dates because this token holds the gmail.metadata scope,
    // and Gmail rejects a `q` search parameter under it with 403 -- verified, not assumed.
    if (stopAt && page.length && page.every((id) => heldIds.has(id))) { stoppedEarly = true; break; }
  } while (pageToken && ids.length < MAX);

  if (DRY) {
    return { account, ok: true, dry: true, wouldFetch: ids.length, mailboxEstimate: estimate, alreadyHeld: held0 };
  }

  // Skip ids already stored. Re-fetching them costs quota and changes nothing.
  const known = new Set(db.prepare('SELECT id FROM gmail_messages WHERE account = ?').all(account).map((r) => r.id));
  const todo = ids.filter((id) => !known.has(id));

  const ins = db.prepare(
    `INSERT OR REPLACE INTO gmail_messages
       (account, id, thread_id, internal_date, day, from_addr, from_name, to_addr, subject, labels, size_estimate)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );

  let written = 0, failed = 0, newest = prior.newest_seen_ms || 0, oldest = prior.oldest_seen_ms || Infinity;
  const store = (msgs) => db.withTransaction(() => {
    // One transaction per batch, not per message and not one for the whole run. A run killed
    // twenty minutes in must leave the batches it completed on disk.
    for (const m of msgs) {
      const ms = Number(m.internalDate);
      const from = splitFrom(header(m, 'from'));
      ins.run(
        account, m.id, m.threadId || null, ms,
        new Date(ms).toISOString().slice(0, 10),
        from.addr, from.name, header(m, 'to'), header(m, 'subject'),
        (m.labelIds || []).join(','), m.sizeEstimate || null,
      );
      written++;
      if (ms > newest) newest = ms;
      if (ms < oldest) oldest = ms;
    }
  });

  let queue = todo.slice();
  let pass = 0;
  // THROTTLED IDS ARE RETRIED, NOT DROPPED. Each pass backs off further and the retry set
  // shrinks; the loop ends when nothing is left or a pass makes no progress, so a persistent
  // 429 cannot spin forever. Whatever survives that is REPORTED as failed rather than
  // quietly missing from the total.
  while (queue.length && pass < 5) {
    const next = [];
    for (let i = 0; i < queue.length; i += BATCH) {
      const slice = queue.slice(i, i + BATCH);
      let r;
      try { r = await getBatch(token, slice); }
      catch (err) { failed += slice.length; console.error(`\n  ${account}: batch failed — ${err.message}`); continue; }
      store(r.messages);
      r.throttled.filter(Boolean).forEach((id) => next.push(id));
      r.failed.forEach((f) => { failed++; if (failed <= 3) console.error(`\n  ${account}: ${f.id} — ${f.code} ${f.message || ''}`); });
      process.stdout.write(`\r  ${account}: ${written}/${todo.length}${next.length ? ` (${next.length} to retry)` : ''}   `);
      await sleep(pass === 0 ? 250 : 250 * (pass + 1) * 2);
    }
    if (next.length === queue.length) { failed += next.length; break; }   // no progress; stop
    queue = next;
    pass++;
  }
  if (queue.length && pass >= 5) failed += queue.length;
  if (todo.length) process.stdout.write('\n');

  const held = db.prepare('SELECT COUNT(*) AS n FROM gmail_messages WHERE account = ?').get(account).n;
  db.prepare(
    `INSERT INTO gmail_sync (account, newest_seen_ms, oldest_seen_ms, total_estimate, messages_held, last_run_at, last_error)
     VALUES (?,?,?,?,?,datetime('now','localtime'),?)
     ON CONFLICT(account) DO UPDATE SET
       newest_seen_ms = excluded.newest_seen_ms, oldest_seen_ms = excluded.oldest_seen_ms,
       total_estimate = excluded.total_estimate, messages_held = excluded.messages_held,
       last_run_at = excluded.last_run_at, last_error = excluded.last_error`
  ).run(account, newest || null, Number.isFinite(oldest) ? oldest : null, estimate, held, failed ? `${failed} messages failed` : null);

  return {
    account, ok: true, listed: ids.length, alreadyHeld: held0, written, failed, held,
    mailboxEstimate: estimate,
    coverage: estimate ? +(100 * held / estimate).toFixed(1) : null,
    // THREE outcomes, not two. 'Hit the budget' was printed for a run that fetched 7
    // messages, because ids.length >= MAX was true of the LISTING while the writes were
    // almost all duplicates -- a true statement about the wrong quantity, and it reads as
    // a backlog that is not there.
    stoppedBecause: stoppedEarly ? 'stopped: a whole page was already held, so everything past it is too'
      : ids.length >= MAX ? `hit the --max ${MAX} budget for this run`
      : 'listed everything Gmail offered',
    priorHighWater: stopAt || null,
  };
}

(async () => {
  const all = ga.accounts();
  const accounts = ONLY ? all.filter((a) => a === ONLY) : all;
  if (!accounts.length) {
    console.error(ONLY ? `  no account "${ONLY}". Authorised: ${all.join(', ')}` : '  no accounts authorised — run tools/google-auth.cjs first');
    process.exitCode = 1;
    return;
  }

  console.log(`  ${accounts.length} account(s), budget ${MAX} messages each${DRY ? ', DRY RUN' : ''}\n`);
  const results = [];
  for (const a of accounts) results.push(await importAccount(a));

  console.log('');
  for (const r of results) {
    if (!r.ok) { console.log(`  ${r.account}: FAILED — ${r.why}`); continue; }
    if (r.dry) { console.log(`  ${r.account}: would fetch ${r.wouldFetch}, holds ${r.alreadyHeld}, mailbox ~${r.mailboxEstimate}`); continue; }
    console.log(`  ${r.account}: +${r.written} new, ${r.held} held of ~${r.mailboxEstimate} (${r.coverage}% coverage)`
      + (r.failed ? `, ${r.failed} FAILED` : ''));
    console.log(`     ${r.stoppedBecause}`);
  }
  // The residue, stated every run rather than only when it is small.
  const short = results.filter((r) => r.ok && !r.dry && r.coverage !== null && r.coverage < 99);
  if (short.length) {
    console.log('\n  NOT COMPLETE, and this is the honest reading:');
    short.forEach((r) => console.log(`    ${r.account} holds ${r.coverage}% of its mailbox — re-run to continue.`));
    console.log('    Anything derived from this describes what has been imported, not your mail.');
  }
})();
