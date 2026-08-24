'use strict';

// Per-device gate for non-loopback callers. Backlog #M3.
//
// WHY THIS EXISTS AT ALL: the server binds 0.0.0.0 on purpose so the phone can reach it
// (see CLAUDE.md), and behind it sits ten account-years of bank transactions. Loopback
// stays open, so every local caller -- scripts/watchdog.cjs, the browser on this machine,
// every importer -- is unaffected. Only a caller arriving over the network must prove
// itself. A local process could read data/dashboard.db directly anyway, so gating loopback
// would buy nothing and would take the whole ops chain down with it.
//
// ---------------------------------------------------------------------------------------
// WHAT CHANGED 18 Aug 2026, and why the previous shape was weak
//
// It used to be ONE shared secret, carried in a cookie that WAS the secret, with a one-year
// Max-Age. Three consequences, none of them theoretical:
//
//   1. NO IDENTITY, SO NO REVOCATION. Every device presented the same string. Removing one
//      lost phone meant re-keying every device, which is the kind of chore that gets
//      skipped -- so in practice a lost device kept access.
//   2. NO EXPIRY WORTH THE NAME. A year-long cookie on a device you no longer own is a
//      year of access to your bank history. Nothing server-side could shorten it, because
//      nothing server-side knew the cookie existed.
//   3. NO RATE LIMIT. /unlock accepted guesses as fast as the network allowed.
//
// Now: the key ENROLS, and a per-device token AUTHENTICATES.
//
//   - POST /unlock with the key mints a random 256-bit token for that device.
//   - The cookie carries the token, never the key.
//   - Only sha256(token) is stored, so the database file does not contain a usable
//     credential -- which matters because that file is the thing being protected.
//   - Each device is listed, named, dated, and revocable ON ITS OWN.
//   - Idle devices expire, and the expiry slides forward while a device is in use.
//
// WHAT THIS STILL DOES NOT FIX, stated because the ceiling is real: the traffic is plain
// HTTP on the LAN. Anyone who can watch the wire sees the token in flight, exactly as they
// previously saw the key. This is a better lock on the same unlocked window. Real TLS is a
// separate and larger question -- a self-signed certificate means trusting a root on the
// phone -- and no amount of token design substitutes for it.
// ---------------------------------------------------------------------------------------

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const COOKIE = 'mc_device';
const KEY_FILE = path.join(__dirname, '..', 'data', 'gate-key.txt');

// Query-string name for the break-glass key, kept deliberately neutral (not tied to any
// product name) so it survives a rebrand unmodified. See the ACCESS_KEY_PARAM path in
// gate() below for the security tradeoff this exists to accept.
const ACCESS_KEY_PARAM = 'access_key';

// Sliding idle window. There is no data here to derive a number from -- no history of how
// long a device stays in use -- so this is a chosen default rather than a measurement, and
// it is named as one. The principle behind the choice: a credential should not outlive your
// memory of having created it. Override with MC_DEVICE_DAYS.
const IDLE_DAYS = Number(process.env.MC_DEVICE_DAYS) || 30;

// Rate limiting on /unlock. Also a convention rather than a derivation: a 72-bit key is
// already impractical to guess, so this is defence in depth, and it matters most if MC_KEY
// is ever set by hand to something short. Backoff doubles, so a persistent guesser is
// pushed into hours quickly while a fat-fingered unlock costs a minute.
const FAIL_BEFORE_LOCK = 5;
const LOCK_BASE_MS = 60 * 1000;
const LOCK_MAX_MS = 6 * 60 * 60 * 1000;

// last_seen is written at most this often. Without it, every request from the phone would
// be a database write to record that the phone is still the phone.
const TOUCH_MS = 5 * 60 * 1000;

db.migrate('gate', [
  (d) => {
    d.exec(`
      CREATE TABLE gate_devices (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash   TEXT NOT NULL UNIQUE,
        label        TEXT NOT NULL,
        user_agent   TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        last_ip      TEXT,
        expires_at   TEXT NOT NULL,
        revoked_at   TEXT
      );
      CREATE INDEX idx_gate_devices_hash ON gate_devices(token_hash);

      -- Keyed by IP. Not a perfect subject -- a LAN NATs to few addresses -- but the
      -- alternative is keying on nothing, and locking one address is recoverable while
      -- an unthrottled guess loop is not.
      CREATE TABLE gate_attempts (
        ip            TEXT PRIMARY KEY,
        fails         INTEGER NOT NULL DEFAULT 0,
        first_fail_at TEXT,
        locked_until  TEXT
      );
    `);
  },
]);

function loadOrCreateKey() {
  const fromEnv = (process.env.MC_KEY || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    // Absence and failure must look different. A missing file means first run and we
    // mint a key; anything else (permissions, a bad disk) must NOT quietly mint a new
    // one, because that would silently invalidate every enrolled device.
    if (err.code !== 'ENOENT') throw err;
  }

  const key = crypto.randomBytes(9).toString('base64url'); // 72 bits, 12 typeable chars
  fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  return key;
}

const KEY = loadOrCreateKey();

function isLoopback(req) {
  // req.socket.remoteAddress, not req.ip: req.ip honours X-Forwarded-For when a proxy
  // is trusted, and a forged header must never be able to claim loopback.
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr) return false;
  if (addr === '::1') return true;
  if (addr.startsWith('127.')) return true;
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function keyMatches(supplied) {
  if (typeof supplied !== 'string' || supplied.length !== KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(KEY));
}

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Crude on purpose, and it says so in the panel. The label exists so you can tell which row
// is your phone; it is not device fingerprinting and is not relied on for anything.
function labelFor(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/i.test(s) ? 'iPhone/iPad'
    : /Android/i.test(s) ? 'Android'
      : /Macintosh|Mac OS/i.test(s) ? 'Mac'
        : /Windows/i.test(s) ? 'Windows'
          : /Linux/i.test(s) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//i.test(s) ? 'Edge'
    : /Chrome\//i.test(s) && !/Edg\//i.test(s) ? 'Chrome'
      : /Firefox\//i.test(s) ? 'Firefox'
        : /Safari\//i.test(s) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

// ----------------------------------------------------------------------------- rate limit
function lockState(ip) {
  const row = db.prepare('SELECT * FROM gate_attempts WHERE ip = ?').get(ip);
  if (!row || !row.locked_until) return { locked: false, row };
  const until = new Date(row.locked_until).getTime();
  if (Number.isNaN(until) || until <= Date.now()) return { locked: false, row };
  return { locked: true, row, msLeft: until - Date.now() };
}

function recordFail(ip) {
  const row = db.prepare('SELECT * FROM gate_attempts WHERE ip = ?').get(ip);
  const fails = (row ? row.fails : 0) + 1;

  let lockedUntil = null;
  if (fails >= FAIL_BEFORE_LOCK) {
    const over = fails - FAIL_BEFORE_LOCK;
    const ms = Math.min(LOCK_BASE_MS * Math.pow(2, over), LOCK_MAX_MS);
    lockedUntil = new Date(Date.now() + ms).toISOString();
  }

  db.prepare(
    `INSERT INTO gate_attempts (ip, fails, first_fail_at, locked_until)
     VALUES (?, ?, datetime('now','localtime'), ?)
     ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`
  ).run(ip, fails, lockedUntil);

  return { fails, lockedUntil };
}

// Cleared on success, so a correct unlock forgives earlier fumbling. A counter that only
// ever rises would eventually lock out the legitimate owner for typos spread over months.
const clearFails = (ip) => db.prepare('DELETE FROM gate_attempts WHERE ip = ?').run(ip);

// -------------------------------------------------------------------------------- devices
function mintDevice(req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ua = String(req.get('user-agent') || '').slice(0, 300);
  const expires = new Date(Date.now() + IDLE_DAYS * 86400000).toISOString();

  db.prepare(
    `INSERT INTO gate_devices (token_hash, label, user_agent, last_ip, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(hash(token), labelFor(ua), ua, clientIp(req), expires);

  return token;
}

// Returns the device row for a valid, unrevoked, unexpired token — or null. Never throws:
// the caller treats null as "deny", so a database problem fails CLOSED.
function deviceFor(token) {
  if (!token) return null;
  try {
    const row = db.prepare(
      'SELECT * FROM gate_devices WHERE token_hash = ? AND revoked_at IS NULL'
    ).get(hash(token));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  } catch (err) {
    console.error(`[gate] device lookup failed, denying: ${err.message}`);
    return null;
  }
}

function touch(row, req) {
  const last = new Date(row.last_seen_at).getTime();
  if (Number.isFinite(last) && Date.now() - last < TOUCH_MS) return;
  try {
    // The window SLIDES: a device in daily use never expires, one left in a drawer does.
    db.prepare(
      `UPDATE gate_devices
          SET last_seen_at = datetime('now','localtime'), last_ip = ?, expires_at = ?
        WHERE id = ?`
    ).run(clientIp(req), new Date(Date.now() + IDLE_DAYS * 86400000).toISOString(), row.id);
  } catch { /* a failed touch must never fail the request */ }
}

function listDevices() {
  const rows = db.prepare(
    `SELECT id, label, created_at, last_seen_at, last_ip, expires_at, revoked_at
       FROM gate_devices ORDER BY revoked_at IS NOT NULL, last_seen_at DESC`
  ).all();
  return rows.map((r) => ({
    ...r,
    active: !r.revoked_at && new Date(r.expires_at).getTime() > Date.now(),
    expired: !r.revoked_at && new Date(r.expires_at).getTime() <= Date.now(),
  }));
}

function page(message, opts = {}) {
  // Self-contained: the gate blocks /shell.css for a caller that has not unlocked yet,
  // so this page cannot link it. Palette values copied from public/shell.css.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control — unlock</title>
<style>
  :root { --bg:#f4f3ef; --card:#fff; --ink:#1f2320; --muted:#6b7268; --accent:#d9663d; --border:#e5e3db; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#17181a; --card:#212327; --ink:#ece9e2; --muted:#9a9c94; --accent:#e58259; --border:#2e3034; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         background:var(--bg); color:var(--ink);
         font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px;
          padding:28px; width:100%; max-width:360px;
          box-shadow:0 1px 2px rgba(20,20,15,.04), 0 8px 24px rgba(20,20,15,.06); }
  h1 { margin:0 0 6px; font-size:19px; letter-spacing:-.01em; }
  p  { margin:0 0 18px; color:var(--muted); font-size:14px; }
  label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
  input { width:100%; padding:11px 12px; font-size:17px; font-family:ui-monospace, Menlo, Consolas, monospace;
          color:var(--ink); background:var(--bg);
          border:1px solid var(--border); border-radius:9px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:14px; padding:11px; font-size:15px; font-weight:600;
           color:#fff; background:var(--accent); border:0; border-radius:9px; cursor:pointer; }
  button[disabled] { opacity:.5; cursor:not-allowed; }
  .err { margin:14px 0 0; padding:9px 11px; border-radius:8px; font-size:13px;
         color:#fff; background:#b3402c; }
  .foot { margin:16px 0 0; font-size:12px; }
</style></head>
<body>
  <div class="card">
    <h1>Mission Control</h1>
    <p>This device is not on the local machine, so it needs the access key. Unlocking
       registers <em>this device</em>, which you can revoke on its own later.</p>
    <form method="POST" action="/unlock">
      <label for="k">Access key</label>
      <input id="k" name="key" autocomplete="off" autocapitalize="off"
             autocorrect="off" spellcheck="false" ${opts.locked ? 'disabled' : 'autofocus'}>
      <button type="submit" ${opts.locked ? 'disabled' : ''}>Unlock</button>
    </form>
    ${message ? `<p class="err">${message}</p>` : ''}
    <p class="foot">Sessions expire after ${IDLE_DAYS} days without use. This is plain HTTP
      on your network — it is a lock on the door, not encryption.</p>
  </div>
</body></html>`;
}

function mount(app) {
  app.get('/unlock', (req, res) => res.type('html').send(page('')));

  app.post('/unlock', express.urlencoded({ extended: false }), (req, res) => {
    const ip = clientIp(req);

    const state = lockState(ip);
    if (state.locked) {
      const mins = Math.ceil(state.msLeft / 60000);
      return res.status(429).type('html').send(
        page(`Too many wrong keys. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
          { locked: true }));
    }

    const supplied = ((req.body && req.body.key) || '').trim();
    if (!keyMatches(supplied)) {
      const { fails, lockedUntil } = recordFail(ip);
      const left = FAIL_BEFORE_LOCK - fails;
      return res.status(401).type('html').send(page(
        lockedUntil
          ? 'That key was not right. Too many attempts — locked for a minute.'
          : `That key was not right.${left > 0 && left <= 2 ? ` ${left} attempt${left === 1 ? '' : 's'} before a lockout.` : ''}`,
        { locked: Boolean(lockedUntil) }));
    }

    clearFails(ip);
    const token = mintDevice(req);

    // No Secure flag: this is plain http on the LAN, and Secure would stop the cookie
    // being stored at all. HttpOnly keeps it out of reach of page scripts.
    res.setHeader('Set-Cookie',
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${IDLE_DAYS * 86400}; HttpOnly; SameSite=Lax`);
    res.redirect(302, '/');
  });

  // MOUNTED WITH `gate` APPLIED INLINE, deliberately. index.js calls gate.mount(app) BEFORE
  // app.use(gate.gate), so anything registered here is otherwise unauthenticated -- which
  // for /unlock is the point and for a device list would be a hole that hands an attacker
  // the revoke button. Explicit here so reordering index.js cannot open it.
  app.get('/api/gate/devices', gate, (req, res) => {
    res.json({
      devices: listDevices(),
      idleDays: IDLE_DAYS,
      thisDeviceId: req.device ? req.device.id : null,
      viaLoopback: isLoopback(req),
      caveat: 'Traffic on this network is plain HTTP. Per-device tokens make access '
        + 'revocable and expiring; they do not encrypt anything. Anyone who can watch the '
        + 'wire sees the token in flight.',
    });
  });

  app.post('/api/gate/devices/:id/revoke', gate, express.json(), (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM gate_devices WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'no such device' });
    if (row.revoked_at) return res.json({ ok: true, alreadyRevoked: true, id });

    db.prepare("UPDATE gate_devices SET revoked_at = datetime('now','localtime') WHERE id = ?").run(id);
    res.json({
      ok: true,
      id,
      wasThisDevice: Boolean(req.device && req.device.id === id),
      note: req.device && req.device.id === id
        ? 'That was the device you are using. It is signed out now and will need the key again.'
        : undefined,
    });
  });
}

function gate(req, res, next) {
  if (isLoopback(req)) return next();

  const token = readCookie(req, COOKIE);
  const row = deviceFor(token);
  if (row) {
    req.device = row;
    touch(row, req);
    return next();
  }

  // BREAK-GLASS PATH, kept because it is documented and because locking yourself out of a
  // machine that is not the one running the server has no other remedy. It is the shared
  // secret with all of the shared secret's weaknesses -- it is not revocable per device --
  // so it is deliberately NOT given a session, and its use is visible in the device list
  // by its absence rather than being silently equivalent to enrolment.
  const headerKey = req.get('x-mc-key');
  if (headerKey && keyMatches(headerKey)) {
    req.viaEnrolmentKey = true;
    return next();
  }

  // SECOND BREAK-GLASS PATH, added for phone automation (MacroDroid geofence -> Open URL):
  // the free tier of that app can fire a URL but cannot set a custom header, so the header
  // path above is unreachable from it. This accepts the same shared secret as a query
  // parameter instead. The tradeoff, stated rather than hidden: a key in a URL can end up
  // in browser history, proxy logs and Referer headers, none of which apply to a header.
  // To keep that tradeoff narrow it is honoured for GET requests only -- by HTTP convention
  // a read, not a mutation -- so a leaked URL can open a panel but cannot revoke a device,
  // delete data, or mint anything; every route that changes state in this app is POST/PUT
  // and never even reaches this branch. Like the header path it gets no session: it proves
  // the request for this one GET and nothing more.
  if (req.method === 'GET') {
    const queryKey = typeof req.query[ACCESS_KEY_PARAM] === 'string' ? req.query[ACCESS_KEY_PARAM] : '';
    if (queryKey && keyMatches(queryKey)) {
      req.viaEnrolmentKey = true;
      return next();
    }
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorised', unlock: '/unlock' });
  }
  return res.redirect(302, '/unlock');
}

module.exports = { gate, mount, KEY, KEY_FILE, isLoopback, listDevices, IDLE_DAYS };
