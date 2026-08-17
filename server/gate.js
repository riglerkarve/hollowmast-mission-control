'use strict';

// Shared-secret gate for non-loopback callers.
//
// Why this shape: the server binds 0.0.0.0 on purpose so the phone can reach it
// (see CLAUDE.md), but nothing authenticated the ledger behind it. Loopback stays
// open, so every local caller -- scripts/watchdog.cjs, the browser on this machine,
// the importers -- is unaffected. Only a caller arriving over the network has to
// prove it knows the key.
//
// The key travels in a cookie rather than a query string, so it never lands in
// browser history or a server log, and so the eleven panels need no edit: each panel
// defines its own local api() wrapper, and a cookie is attached by the browser to
// all of them without one line changing.

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'mc_key';
const KEY_FILE = path.join(__dirname, '..', 'data', 'gate-key.txt');
const YEAR = 60 * 60 * 24 * 365;

function loadOrCreateKey() {
  const fromEnv = (process.env.MC_KEY || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    // Absence and failure must look different. A missing file means first run and we
    // mint a key; anything else (permissions, a bad disk) must NOT quietly mint a new
    // one, because that would silently invalidate the key already on the phone.
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

function page(message) {
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
  .err { margin:14px 0 0; padding:9px 11px; border-radius:8px; font-size:13px;
         color:#fff; background:#b3402c; }
</style></head>
<body>
  <div class="card">
    <h1>Mission Control</h1>
    <p>This device is not on the local machine, so it needs the access key.</p>
    <form method="POST" action="/unlock">
      <label for="k">Access key</label>
      <input id="k" name="key" autocomplete="off" autocapitalize="off"
             autocorrect="off" spellcheck="false" autofocus>
      <button type="submit">Unlock</button>
    </form>
    ${message ? `<p class="err">${message}</p>` : ''}
  </div>
</body></html>`;
}

function mount(app) {
  app.get('/unlock', (req, res) => res.type('html').send(page('')));

  app.post('/unlock', express.urlencoded({ extended: false }), (req, res) => {
    const supplied = ((req.body && req.body.key) || '').trim();
    if (!keyMatches(supplied)) {
      return res.status(401).type('html').send(page('That key was not right.'));
    }
    // No Secure flag: this is plain http on the LAN, and Secure would stop the cookie
    // being stored at all. HttpOnly keeps it out of reach of page scripts.
    res.setHeader('Set-Cookie',
      `${COOKIE}=${encodeURIComponent(KEY)}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax`);
    res.redirect(302, '/');
  });
}

function gate(req, res, next) {
  if (isLoopback(req)) return next();

  const supplied = readCookie(req, COOKIE) || req.get('x-mc-key');
  if (supplied && keyMatches(supplied)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorised', unlock: '/unlock' });
  }
  return res.redirect(302, '/unlock');
}

module.exports = { gate, mount, KEY, KEY_FILE, isLoopback };
