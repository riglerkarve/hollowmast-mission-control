#!/usr/bin/env node
// preflight.cjs — what would leave this machine if mission-control were pushed?
//
//   node tools/preflight.cjs
//
// WHY THIS EXISTS. Mission Control had no remote and therefore no reason to check what a
// push would carry. The owner decided on 23 Aug 2026 to back the CODE up to a private
// GitHub repo and deliberately NOT the data: dashboard.db holds 6,839 real bank
// transactions plus health and wellbeing entries, and it is gitignored for that reason.
//
// The whole safety of that decision rests on one thing being true — that nothing sensitive
// is in the repository. .gitignore only governs the FUTURE. Git carries every past commit,
// so a secret committed once and deleted later is still published by the push that
// follows. This checks the history, not the working tree.
//
// Survive/preflight.sh is the model and taught the sharper half: search for the VALUE, not
// the variable. On that repo the ADMIN_KEY was also pasted into a deploy doc twice as part
// of an example URL, where nothing was named like a credential at all.
//
// EVERY CHECK CARRIES A CONTROL, and the run refuses to report a clean bill unless each
// control fires. A scanner matching nothing and a scanner that is broken produce the same
// empty output, which is the failure this workspace keeps paying for.
//
// EXIT CODES:  0 nothing sensitive found   1 something found   2 could not look

const { execSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const EXIT_OK = 0, EXIT_FOUND = 1, EXIT_CANNOT_LOOK = 2;
const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Filenames that must never appear anywhere in history. Taken from .gitignore's own
// sensitive section rather than invented here, so the two cannot drift apart silently.
//
// THE PATHS CARRY THEIR PREFIX ON PURPOSE. The first version of this list held bare
// 'telemetry/', copied from .gitignore's `data/telemetry/` with the prefix dropped — and it
// flagged tools/telemetry/, which is code and a price config with no secret in it. A
// substring is not a path, and a scanner that cries wolf on its first run is one nobody
// runs twice. Keep these anchored to what .gitignore actually names.
const NEVER = ['data/dashboard.db', 'gate-key', 'google-token', 'google-client', 'data/oauth-',
               'dash-password', 'reports-admin-key', 'honeygain-token', 'ga-service-account',
               'uc-statements', 'data/telemetry/'];

// Value shapes, not variable names.
const SHAPES = [
  ['known key formats', /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/],
  ['hardcoded credential assignment', /(PASSWORD|SECRET|ADMIN_KEY|API_KEY|TOKEN)\s*[:=]\s*['"][^'"]{12,}/],
];
const BENIGN = /process\.env|placeholder|your-|example|<[A-Z_]+>|\.\.\./;

let problems = 0, controlsFailed = 0;
const say = (s) => console.log(s);

try { git('rev-parse --git-dir'); }
catch (e) { say('COULD NOT LOOK: not a git repository (' + e.message.slice(0, 60) + ')'); process.exitCode = EXIT_CANNOT_LOOK; return; }

say('mission-control preflight — what a push would carry\n');

// ---------------------------------------------------------------- 1. history filenames
say('History — was anything sensitive ever committed?');
for (const pat of NEVER) {
  let hits = '';
  try { hits = git(`log --all --name-only --format= -- "*${pat}*"`); }
  catch { say(`  COULD NOT LOOK  ${pat}`); controlsFailed++; continue; }
  const files = [...new Set(hits.split(/\r?\n/).filter(Boolean))];
  if (files.length) { say(`  FOUND  ${pat} — ${files.length} path(s): ${files.slice(0, 3).join(', ')}`); problems++; }
}
// CONTROL: a path that IS in history must be found, or the scan proves nothing.
const ctl = [...new Set(git('log --all --name-only --format= -- "*server/db.js*"').split(/\r?\n/).filter(Boolean))];
if (!ctl.length) { say('  CONTROL FAILED — server/db.js is in this history and the scan did not find it'); controlsFailed++; }
else say(`  control ok — the scan finds server/db.js (${ctl.length} path)`);

// ---------------------------------------------------------------- 2. tracked content
say('\nTracked content — credential-shaped VALUES, not variable names');
for (const [label, re] of SHAPES) {
  let out = '';
  try { out = git(`grep -nIE ${JSON.stringify(re.source)} -- .`); }
  catch (e) { if (e.status !== 1) { say(`  COULD NOT LOOK  ${label}`); controlsFailed++; continue; } }
  const lines = out.split(/\r?\n/).filter((l) => l && !BENIGN.test(l));
  if (lines.length) { say(`  FOUND  ${label} — ${lines.length} line(s)`); lines.slice(0, 4).forEach((l) => say('    ' + l.slice(0, 110))); problems++; }
  else say(`  clean — ${label}`);
}
// CONTROL: the pattern must match a planted example.
if (!SHAPES[1][1].test('const ADMIN_KEY = "abcdef1234567890abcdef";')) {
  say('  CONTROL FAILED — the credential pattern does not match a planted example'); controlsFailed++;
} else say('  control ok — the pattern matches a planted credential');

// ---------------------------------------------------------------- 3. what would go
say('\nSize of what would be pushed');
const tracked = git('ls-files').split(/\r?\n/).filter(Boolean);
say(`  ${tracked.length} tracked files`);
say(`  dashboard.db tracked: ${tracked.includes('data/dashboard.db') ? 'YES — STOP' : 'no'}`);

say('');
if (controlsFailed) {
  say(`REFUSING TO REPORT: ${controlsFailed} control(s) failed. A scan that cannot be shown to`);
  say('fire says nothing about what it did not find.');
  process.exitCode = EXIT_CANNOT_LOOK;
} else if (problems) {
  say(`${problems} problem(s) found. Do NOT push until each is resolved — and note that`);
  say('deleting a file now does not remove it from history; the commit that added it must go.');
  process.exitCode = EXIT_FOUND;
} else {
  say('Nothing sensitive found, and every control fired. The code is safe for a PRIVATE repo.');
  say('This says nothing about the database, which is gitignored and stays on this machine.');
  process.exitCode = EXIT_OK;
}
