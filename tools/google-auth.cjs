#!/usr/bin/env node
//
// google-auth.cjs — give Mission Control its OWN Google credential. Backlog #9.
//
//   node tools/google-auth.cjs            run the one-time consent flow
//   node tools/google-auth.cjs --status   report what is set up, change nothing
//   node tools/google-auth.cjs --test     use the stored token to make one read-only call
//   node tools/google-auth.cjs --revoke   tell Google to invalidate the token, delete it here
//
// ---------------------------------------------------------------------------------------
// WHY THIS EXISTS SEPARATELY FROM THE CLAUDE CONNECTORS.
//
// The Google connector added on 18 Aug is CLAUDE-SESSION scoped. It lets me read mail
// inside a conversation. It gives this server nothing: the Express process on :3000 has no
// credential, and dashboard.db cannot reach Google at all. That difference decides what can
// be built. "Claude pulls the data when asked" works today and stops the moment nobody is
// running a session. "Mission Control refreshes on a schedule" needs the credential this
// file obtains — and that is the version that survives me not being here.
//
// WHAT I CANNOT DO, stated plainly rather than discovered halfway through: I do not create
// the Google Cloud project, do not sign in, and do not click Allow. Those are yours. This
// script prepares everything up to that line and takes over again immediately after.
//
// SCOPES ARE THE NARROWEST THAT ANSWER THE QUESTION, and the choice is deliberate:
//
//   gmail.metadata            headers and labels. NOT message bodies, NOT snippets.
//   drive.metadata.readonly   file names, dates, sizes. NOT file contents.
//
// gmail.readonly would grant every word of every email. It is not requested, and the
// difference matters because dashboard.db binds 0.0.0.0 behind one shared secret and
// already holds ten account-years of bank transactions.
//
// ONE HONEST CAVEAT ON gmail.metadata: it DOES include the Subject header. There is no
// narrower Gmail scope that still returns senders and dates, so the scope permits reading
// subjects even though the importer is designed not to store them. Permission and practice
// are different things and you should know which is which before granting it.
//
// THE TOKEN IS A LIVE KEY TO YOUR MAILBOX. It is written 0600, gitignored by category
// before this file was written, and revocable with --revoke.
// ---------------------------------------------------------------------------------------
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

const DATA = path.join(__dirname, '..', 'data');
const CLIENT_FILE = path.join(DATA, 'google-client.json');
const TOKEN_FILE = path.join(DATA, 'google-token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

// Loopback, which is what Google's "Desktop app" client type expects. The port is fixed so
// the redirect URI you register in the console is stable; :3000 is deliberately NOT reused,
// because the dashboard already owns that and a half-finished consent flow must never be
// able to take it down.
const PORT = 43117;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// Google's downloaded client file nests under "installed" or "web" depending on the type.
function loadClient() {
  const raw = readJson(CLIENT_FILE);
  if (!raw) return null;
  const c = raw.installed || raw.web || raw;
  if (!c.client_id || !c.client_secret) return null;
  return { id: c.client_id, secret: c.client_secret };
}

async function post(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ------------------------------------------------------------------------------- status
function status() {
  const client = loadClient();
  const token = readJson(TOKEN_FILE);

  console.log('  client file :', fs.existsSync(CLIENT_FILE)
    ? (client ? `present, client_id ${client.id.slice(0, 18)}…` : 'PRESENT BUT UNREADABLE — re-download it')
    : 'not set up yet');
  console.log('  token file  :', token && token.refresh_token
    ? `present, granted ${token.granted_at || 'at an unrecorded time'}`
    : 'no token — consent has not been given');
  if (token && token.scopes) console.log('  scopes held :', token.scopes.join('  '));
  console.log('  redirect URI:', REDIRECT);
  console.log();
  console.log('  Scopes this asks for, and nothing more:');
  SCOPES.forEach((s) => console.log('    ' + s));
}

// ---------------------------------------------------------------------------- the flow
function instructions() {
  console.log(`
  SET UP THE CLIENT FIRST. This is the part only you can do — I do not create projects,
  sign in, or click Allow.

  1. Go to  https://console.cloud.google.com/projectcreate
     Create a project. Any name; "Mission Control" is fine.

  2. Enable the two APIs you are about to read:
       https://console.cloud.google.com/apis/library/gmail.googleapis.com
       https://console.cloud.google.com/apis/library/drive.googleapis.com
     Click Enable on each, with the new project selected.

  3. Configure the consent screen:
       https://console.cloud.google.com/auth/overview
     User type EXTERNAL. Fill the required fields. Add YOUR OWN email as a Test user.
     Leave it in Testing — do NOT publish it. Publishing starts a verification review you
     do not need for a single-user tool.

     NOTE, because it will bite otherwise: a Testing-mode refresh token expires after
     SEVEN DAYS. For a scheduled importer that means re-consenting weekly. The fix is to
     set the app to Internal (needs Google Workspace) or accept the weekly re-auth. Decide
     that before building anything that depends on unattended refresh.

  4. Create the credential:
       https://console.cloud.google.com/apis/credentials
     Create credentials -> OAuth client ID -> Application type: Desktop app.
     Download the JSON.

  5. Save that file as, exactly:
       ${CLIENT_FILE}
     It is already gitignored. Then run this script again.

  I will take it from there: open the consent URL, capture the redirect on ${REDIRECT},
  exchange the code, and write the refresh token 0600.
`);
}

async function authorise() {
  const client = loadClient();
  if (!client) { instructions(); return; }

  // PKCE, even though a desktop client secret is not really secret. It costs four lines
  // and closes the authorisation-code interception path on a machine you share with
  // anything else.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: client.id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',        // without this there is no refresh token at all
    prompt: 'consent',             // forces a refresh token even on re-authorisation
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  console.log('\n  Open this in your browser and grant access:\n');
  console.log('  ' + auth.toString() + '\n');
  console.log(`  Waiting for the redirect on ${REDIRECT} …  (Ctrl-C to abandon)\n`);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }

      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');

      const reply = (msg) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem;max-width:32rem">
          <h1 style="font-size:1.2rem">${msg}</h1><p>You can close this tab and return to the terminal.</p></body>`);
      };

      if (err) { reply('Consent was refused: ' + err); server.close(); reject(new Error(err)); return; }
      // State is checked because a mismatched one means the response is not from the
      // request we made, and accepting it would defeat the point of sending it.
      if (gotState !== state) { reply('State mismatch — refusing this response.'); server.close(); reject(new Error('state mismatch')); return; }
      if (!got) { reply('No code in the redirect.'); server.close(); reject(new Error('no code')); return; }

      reply('Mission Control has the credential.');
      server.close();
      resolve(got);
    });
    server.on('error', (e) => reject(new Error(`could not listen on ${PORT}: ${e.message}`)));
    server.listen(PORT);
  });

  const r = await post('https://oauth2.googleapis.com/token', {
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });

  if (!r.ok || !r.body.refresh_token) {
    console.error('  token exchange failed:', r.status, JSON.stringify(r.body).slice(0, 300));
    if (r.ok && !r.body.refresh_token) {
      console.error('  Google returned an access token but no REFRESH token. That happens when');
      console.error('  consent was already granted; prompt=consent is set to prevent it, so if you');
      console.error('  see this, re-check the client type is "Desktop app".');
    }
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    refresh_token: r.body.refresh_token,
    scopes: SCOPES,
    granted_at: new Date().toISOString(),
    // The access token is NOT stored. It expires in an hour and is cheap to mint from the
    // refresh token; keeping a second live credential on disk buys nothing.
  }, null, 2), { mode: 0o600 });

  console.log('  Stored the refresh token, 0600, at:');
  console.log('   ', TOKEN_FILE);
  console.log('  Run  node tools/google-auth.cjs --test  to prove it works.');
}

// --------------------------------------------------------------------------------- test
async function accessToken() {
  const client = loadClient();
  const token = readJson(TOKEN_FILE);
  if (!client || !token || !token.refresh_token) return null;
  const r = await post('https://oauth2.googleapis.com/token', {
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  return r.ok ? r.body.access_token : null;
}

async function test() {
  const at = await accessToken();
  if (!at) { console.error('  no usable credential — run without flags first'); process.exitCode = 1; return; }

  // A read that returns a COUNT and no content, so proving the credential works does not
  // itself pull anything into this machine.
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${at}` },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('  call failed:', res.status, JSON.stringify(b).slice(0, 200)); process.exitCode = 1; return; }
  console.log('  works. mailbox:', b.emailAddress, '|', b.messagesTotal, 'messages,', b.threadsTotal, 'threads');
  console.log('  nothing was read beyond these counts.');
}

async function revoke() {
  const token = readJson(TOKEN_FILE);
  if (!token || !token.refresh_token) { console.log('  nothing to revoke'); return; }
  const res = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: token.refresh_token }).toString(),
  });
  // Delete locally whatever Google says: a token this machine cannot use is not one to keep.
  fs.unlinkSync(TOKEN_FILE);
  console.log(res.ok
    ? '  revoked at Google and deleted locally.'
    : `  Google returned ${res.status}, but the local token is deleted. Check the account's third-party access page.`);
}

(async () => {
  if (has('--status')) return status();
  if (has('--test')) return test();
  if (has('--revoke')) return revoke();
  return authorise();
})();
