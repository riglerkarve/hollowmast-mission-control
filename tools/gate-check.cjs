#!/usr/bin/env node
//
// gate-check.cjs — end-to-end test of the per-device gate. Backlog #M3.
//
//   node tools/gate-check.cjs        (against a running server)
//
// It uses the REAL LAN address, because req.socket.remoteAddress must be genuinely
// non-loopback: run against 127.0.0.1 this would exercise the EXEMPT path and pass while
// proving nothing. It enrols and revokes real devices, then deletes every row it created.
require('./_run-log.cjs').record();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Discovered rather than hard-coded. A fixed IP here silently becomes a test of nothing
// the day DHCP moves this machine — and it would fail by CONNECTING TO NOTHING, which
// looks like a broken test rather than an untested gate.
const lanIp = Object.values(os.networkInterfaces()).flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal);
if (!lanIp) {
  console.error('No non-loopback IPv4 address on this machine — the gated path cannot be');
  console.error('exercised at all. Refusing to run rather than testing only the exempt path.');
  process.exit(2);
}

const LAN = `http://${lanIp.address}:3000`;
const LOCAL = 'http://127.0.0.1:3000';
const KEY = fs.readFileSync(path.join('data', 'gate-key.txt'), 'utf8').trim();

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const cookieOf = (res) => {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  const m = sc.match(/mc_device=([^;]+)/);
  return m ? m[1] : null;
};

async function unlock(key) {
  return fetch(`${LAN}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `key=${encodeURIComponent(key)}`,
    redirect: 'manual',
  });
}

(async () => {
  const db = require(path.resolve(__dirname, '..', 'server', 'db.js'));

  // High-water mark, captured BEFORE anything is enrolled, so cleanup can remove exactly
  // what this run created and nothing a real person set up.
  const highWater = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM gate_devices').get().id;
  const already = db.prepare('SELECT COUNT(*) AS n FROM gate_devices').get().n;
  if (already) console.log(`  note: ${already} device(s) already enrolled — they will not be touched.`);

  console.log('\n--- 1. the constraint that must never break: loopback is exempt ---');
  for (const p of ['/api/status', '/api/todo/items', '/api/finance/summary']) {
    const r = await fetch(LOCAL + p);
    check(`loopback ${p}`, r.status === 200, `${r.status}`);
  }

  console.log('\n--- 2. LAN with no credential is refused ---');
  const bare = await fetch(`${LAN}/api/todo/items`);
  check('LAN /api/* -> 401', bare.status === 401, `${bare.status}`);
  const barePage = await fetch(`${LAN}/`, { redirect: 'manual' });
  check('LAN page -> redirect to /unlock', barePage.status === 302
    && String(barePage.headers.get('location')).includes('/unlock'),
  `${barePage.status} ${barePage.headers.get('location')}`);

  console.log('\n--- 3. the OLD cookie shape must not work (clean credential break) ---');
  const oldCookie = await fetch(`${LAN}/api/todo/items`, { headers: { cookie: `mc_key=${KEY}` } });
  check('old mc_key cookie rejected', oldCookie.status === 401, `${oldCookie.status}`);

  console.log('\n--- 4. wrong key is refused and counted ---');
  db.prepare('DELETE FROM gate_attempts').run();
  const wrong = await unlock('totallywrong');
  check('wrong key -> 401', wrong.status === 401, `${wrong.status}`);
  const attempts = db.prepare('SELECT fails FROM gate_attempts').get();
  check('failure recorded', attempts && attempts.fails === 1, `fails=${attempts && attempts.fails}`);

  console.log('\n--- 5. repeated wrong keys trigger a lockout ---');
  let lockedStatus = null;
  for (let i = 0; i < 5; i += 1) lockedStatus = (await unlock('stillwrong')).status;
  check('locked out after repeated failures', lockedStatus === 429, `final status ${lockedStatus}`);
  const locked = db.prepare('SELECT fails, locked_until FROM gate_attempts').get();
  check('lock recorded with an expiry', Boolean(locked && locked.locked_until),
    `fails=${locked && locked.fails} until=${locked && locked.locked_until}`);

  console.log('\n--- 6. a correct key while locked is STILL refused (lock precedes the check) ---');
  const whileLocked = await unlock(KEY);
  check('correct key refused during lockout', whileLocked.status === 429, `${whileLocked.status}`);

  console.log('\n--- 7. clearing the lock, the correct key enrols a device ---');
  db.prepare('DELETE FROM gate_attempts').run();
  const ok = await unlock(KEY);
  const token = cookieOf(ok);
  check('correct key -> 302 redirect', ok.status === 302, `${ok.status}`);
  check('a device token was issued', Boolean(token) && token.length > 30, `${token && token.length} chars`);
  check('token is NOT the key', token !== KEY);
  check('fail counter cleared on success',
    !db.prepare('SELECT 1 FROM gate_attempts').get());

  console.log('\n--- 8. only a HASH is stored, never the token ---');
  const stored = db.prepare('SELECT token_hash, label FROM gate_devices ORDER BY id DESC LIMIT 1').get();
  check('token absent from the database', stored.token_hash !== decodeURIComponent(token),
    `stored ${stored.token_hash.slice(0, 16)}...`);
  check('device got a label', Boolean(stored.label), stored.label);

  console.log('\n--- 9. the token authenticates ---');
  const withToken = await fetch(`${LAN}/api/todo/items`, { headers: { cookie: `mc_device=${token}` } });
  check('LAN + token -> 200', withToken.status === 200, `${withToken.status}`);

  console.log('\n--- 10. the device list is itself gated ---');
  const listNoAuth = await fetch(`${LAN}/api/gate/devices`);
  check('device list unauthenticated -> 401', listNoAuth.status === 401, `${listNoAuth.status}`);
  const listAuth = await fetch(`${LAN}/api/gate/devices`, { headers: { cookie: `mc_device=${token}` } });
  const body = await listAuth.json();
  check('device list authenticated -> 200', listAuth.status === 200, `${listAuth.status}`);
  check('lists the enrolled device', body.devices.some((d) => d.active), `${body.devices.length} device(s)`);
  check('identifies which one is calling', body.thisDeviceId != null, `id ${body.thisDeviceId}`);

  console.log('\n--- 11. revoking THAT device kills THAT token, immediately ---');
  const id = body.thisDeviceId;
  const rev = await fetch(`${LAN}/api/gate/devices/${id}/revoke`, {
    method: 'POST', headers: { cookie: `mc_device=${token}` },
  });
  const revBody = await rev.json();
  check('revoke -> 200', rev.status === 200, `${rev.status}`);
  check('knew it was revoking the caller', revBody.wasThisDevice === true);
  const afterRevoke = await fetch(`${LAN}/api/todo/items`, { headers: { cookie: `mc_device=${token}` } });
  check('revoked token -> 401', afterRevoke.status === 401, `${afterRevoke.status}`);

  console.log('\n--- 12. revoking one device leaves its sibling working ---');
  // Each token asks the API who IT is, rather than the test guessing an id by arithmetic.
  // The first version of this had `|| d3.id === thisDeviceId` as a fallback, which meant
  // the test still passed if it had revoked the wrong device — an assertion that cannot
  // fail is decoration. Both outcomes are now asserted explicitly and separately.
  const whoAmI = async (tok) => (await (await fetch(`${LAN}/api/gate/devices`, {
    headers: { cookie: `mc_device=${tok}` },
  })).json()).thisDeviceId;

  const tKeep = cookieOf(await unlock(KEY));
  const tKill = cookieOf(await unlock(KEY));
  const idKeep = await whoAmI(tKeep);
  const idKill = await whoAmI(tKill);
  check('two devices enrolled with distinct ids', idKeep !== idKill && idKeep && idKill,
    `keep=${idKeep} kill=${idKill}`);

  await fetch(`${LAN}/api/gate/devices/${idKill}/revoke`, {
    method: 'POST', headers: { cookie: `mc_device=${tKeep}` },
  });

  const keepAfter = await fetch(`${LAN}/api/todo/items`, { headers: { cookie: `mc_device=${tKeep}` } });
  const killAfter = await fetch(`${LAN}/api/todo/items`, { headers: { cookie: `mc_device=${tKill}` } });
  check('the revoked sibling is dead', killAfter.status === 401, `${killAfter.status}`);
  check('the other device still works', keepAfter.status === 200, `${keepAfter.status}`);

  console.log('\n--- 13. expiry is enforced, not just stored ---');
  const t4 = cookieOf(await unlock(KEY));
  const row4 = db.prepare('SELECT id FROM gate_devices ORDER BY id DESC LIMIT 1').get();
  db.prepare('UPDATE gate_devices SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), row4.id);
  const expired = await fetch(`${LAN}/api/todo/items`, { headers: { cookie: `mc_device=${t4}` } });
  check('expired token -> 401', expired.status === 401, `${expired.status}`);

  console.log('\n--- 14. break-glass header still works, and loopback is STILL fine ---');
  const viaKey = await fetch(`${LAN}/api/todo/items`, { headers: { 'x-mc-key': KEY } });
  check('X-MC-Key -> 200', viaKey.status === 200, `${viaKey.status}`);
  const viaKeyWrong = await fetch(`${LAN}/api/todo/items`, { headers: { 'x-mc-key': 'nope' } });
  check('wrong X-MC-Key -> 401', viaKeyWrong.status === 401, `${viaKeyWrong.status}`);
  for (const p of ['/api/status', '/api/finance/access-log']) {
    const r = await fetch(LOCAL + p);
    check(`loopback still open ${p}`, r.status === 200, `${r.status}`);
  }

  // Cleans up ONLY what this run created. The first version did `DELETE FROM gate_devices`
  // wholesale, which would have silently signed out a real phone the first time this was
  // run after enrolling one — a test that destroys the state it is checking. Rows are
  // bounded by the high-water id captured before any enrolment.
  const removed = db.prepare('DELETE FROM gate_devices WHERE id > ?').run(highWater).changes;
  db.prepare('DELETE FROM gate_attempts WHERE ip = ?').run(lanIp.address);

  const left = db.prepare('SELECT COUNT(*) AS n FROM gate_devices WHERE id > ?').get(highWater).n;
  const preExisting = db.prepare('SELECT COUNT(*) AS n FROM gate_devices WHERE id <= ?').get(highWater).n;

  console.log(`\n  cleaned up — ${removed} test device(s) removed, ${left} left behind`);
  console.log(`  ${preExisting} pre-existing device(s) untouched`);
  console.log(`  tested against ${LAN}`);
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail || left ? 1 : 0;
})();
