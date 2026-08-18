#!/usr/bin/env node
//
// google-auth.cjs — give Mission Control its OWN Google credential. Backlog #9.
//
//   node tools/google-auth.cjs            run the consent flow (repeat for each account)
//   node tools/google-auth.cjs --status   list every authorised account, change nothing
//   node tools/google-auth.cjs --test     one read-only call per account, reported separately
//   node tools/google-auth.cjs --revoke <account>   invalidate one at Google, delete it here
//   node tools/google-auth.cjs --revoke --all       invalidate every one
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
const TOKEN_FILE = path.join(DATA, 'google-token.json');    // legacy, single account
const TOKENS_FILE = path.join(DATA, 'google-tokens.json');  // { "<email>": { refresh_token, … } }

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
// One file keyed by email address, so more than one mailbox can be authorised. The single
// TOKEN_FILE could only ever hold the LAST account consented — authorising a second silently
// replaced the first, with nothing on screen to say so.
function loadTokens() {
  const multi = readJson(TOKENS_FILE);
  if (multi && typeof multi === 'object') return multi;
  // Migrate a legacy single-account file on first read. It carries no email, so it is parked
  // under a key that admits that rather than under a guessed address.
  const one = readJson(TOKEN_FILE);
  if (one && one.refresh_token) return { [one.account || '(unknown account)']: one };
  return {};
}

function saveTokens(all) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// Reads the mailbox address a refresh token belongs to. Used to FILE a new credential under
// the account that actually granted it, and to prove at --test time that the account has not
// changed underneath a stored key.
async function whoAmI(refreshToken) {
  const client = loadClient();
  if (!client) return null;
  const r = await post('https://oauth2.googleapis.com/token', {
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!r.ok || !r.body.access_token) return null;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${r.body.access_token}` },
  });
  if (!res.ok) return null;
  const b = await res.json().catch(() => null);
  return (b && b.emailAddress) || null;
}

function status() {
  const client = loadClient();
  const all = loadTokens();
  const names = Object.keys(all);

  console.log('  client file :', fs.existsSync(CLIENT_FILE)
    ? (client ? `present, client_id ${client.id.slice(0, 18)}…` : 'PRESENT BUT UNREADABLE — re-download it')
    : 'not set up yet');
  if (!names.length) {
    console.log('  accounts    : none — consent has not been given');
  } else {
    console.log(`  accounts    : ${names.length}`);
    names.forEach((n) => console.log(`     ${n}  granted ${all[n].granted_at || 'at an unrecorded time'}`));
    const scopes = all[names[0]].scopes;
    if (scopes) console.log('  scopes held :', scopes.join('  '));
  }
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

  // WHICH ACCOUNT CONSENTED IS DISCOVERED, NOT ASSUMED. The refresh token is used once to
  // read the profile, and the mailbox address that comes back is the key it is filed under.
  // Recording who I MEANT to authorise would be wrong exactly when it matters most — an
  // account chooser with two entries a few pixels apart.
  const who = await whoAmI(r.body.refresh_token);
  if (!who) {
    console.error('  got a refresh token but could not read which account it belongs to.');
    console.error('  NOT STORING IT. A credential filed under the wrong mailbox is worse than');
    console.error('  none: everything downstream would attribute that mail to the other account.');
    process.exitCode = 1;
    return;
  }

  const all = loadTokens();
  const replacing = !!all[who];
  all[who] = {
    refresh_token: r.body.refresh_token,
    scopes: SCOPES,
    granted_at: new Date().toISOString(),
    // The access token is NOT stored. It expires in an hour and is cheap to mint from the
    // refresh token; keeping a second live credential on disk buys nothing.
  };
  saveTokens(all);

  console.log(`  ${replacing ? 'Replaced' : 'Stored'} the refresh token for ${who}, 0600, at:`);
  console.log('   ', TOKENS_FILE);
  console.log(`  ${Object.keys(all).length} account(s) authorised: ${Object.keys(all).join(', ')}`);
  console.log('  Run  node tools/google-auth.cjs --test  to prove they work.');
}

// --------------------------------------------------------------------------------- test
// accessToken(account) — an account is now REQUIRED rather than implied. Defaulting to "the
// only one" would work until the day there are two, and then silently read the wrong mailbox.
async function accessToken(account) {
  const client = loadClient();
  const all = loadTokens();
  const token = all[account];
  if (!client || !token || !token.refresh_token) return null;
  const r = await post('https://oauth2.googleapis.com/token', {
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  return r.ok ? r.body.access_token : null;
}
module.exports = { accessToken, loadTokens, accounts: () => Object.keys(loadTokens()) };

// Tests EVERY authorised account, and reports each separately. One aggregate "works" would
// hide a second account whose consent had been withdrawn from its Google security page.
async function test() {
  const all = loadTokens();
  const names = Object.keys(all);
  if (!names.length) { console.error('  no accounts authorised — run without flags first'); process.exitCode = 1; return; }

  let bad = 0;
  for (const name of names) {
    const at = await accessToken(name);
    if (!at) { console.error(`  ${name}: FAILED to mint an access token — consent may have been withdrawn`); bad++; continue; }

    // A read that returns COUNTS and no content, so proving the credential works does not
    // itself pull anything into this machine.
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${at}` },
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`  ${name}: call failed ${res.status} ${JSON.stringify(b).slice(0, 120)}`); bad++; continue; }

    // The address the token ACTUALLY belongs to, checked against the key it is filed under.
    // They can diverge — a key written by an older version, or a file edited by hand — and a
    // credential reading a different mailbox than its label claims is the worst failure here,
    // because every downstream figure would be attributed to the wrong account.
    const mismatch = b.emailAddress && b.emailAddress !== name;
    console.log(`  ${name}: works — ${b.messagesTotal} messages, ${b.threadsTotal} threads`
      + (mismatch ? `   *** BUT THE TOKEN IS FOR ${b.emailAddress} — filed under the wrong key ***` : ''));
    if (mismatch) bad++;
  }
  console.log(`  ${names.length - bad}/${names.length} usable. Nothing was read beyond these counts.`);
  if (bad) process.exitCode = 1;
}

// --revoke <account>  revokes one.  --revoke --all  revokes every one.
// Naming the account is REQUIRED when more than one is authorised: revoking is not
// reversible without a fresh consent, and "revoke" meaning "revoke whichever happens to be
// first" is the kind of default that costs you the wrong mailbox.
async function revoke(which) {
  const all = loadTokens();
  const names = Object.keys(all);
  if (!names.length) { console.log('  nothing to revoke'); return; }

  let targets;
  if (which === '--all') targets = names;
  else if (which && all[which]) targets = [which];
  else if (!which && names.length === 1) targets = names;
  else {
    console.error(which ? `  no account "${which}". Authorised: ${names.join(', ')}`
      : `  ${names.length} accounts authorised — name one, or pass --all.\n     ${names.join('\n     ')}`);
    process.exitCode = 1;
    return;
  }

  for (const name of targets) {
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: all[name].refresh_token }).toString(),
    });
    // Delete locally whatever Google says: a token this machine cannot use is not one to keep.
    delete all[name];
    console.log(res.ok
      ? `  ${name}: revoked at Google and deleted locally.`
      : `  ${name}: Google returned ${res.status}, but the local token is deleted. Check that account's third-party access page.`);
  }
  saveTokens(all);
  const left = Object.keys(all);
  console.log(left.length ? `  still authorised: ${left.join(', ')}` : '  no accounts remain authorised.');
}

// GUARDED, and this was a real bug rather than a precaution. Adding module.exports made this
// file requirable as a library — and requiring it ran the CLI, which with no flags means
// authorise(): it printed a consent URL and held port 43117 waiting for a redirect. The
// importer's first probe hung for two minutes and left a stray listener behind.
//
// A file that is both a command and a library must know which it is being used as.
if (require.main === module) {
  (async () => {
    if (has('--status')) return status();
    if (has('--test')) return test();
    if (has('--revoke')) return revoke(process.argv[process.argv.indexOf('--revoke') + 1]);
    return authorise();
  })();
}
