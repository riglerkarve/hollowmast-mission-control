#!/usr/bin/env node
//
// secrets-scan.cjs — is any live secret's ACTUAL VALUE inside a tracked file?
//
//   node tools/secrets-scan.cjs            scan tracked files
//   node tools/secrets-scan.cjs --all      scan the whole working tree too
//
// BY VALUE, NEVER BY FILENAME, and that distinction is the entire tool. Checking that
// data/gate-key.txt appears in .gitignore proves the RULE exists. Searching for the key's
// characters proves no COPY leaked into a script, a test fixture, a report or a comment —
// which is the failure a .gitignore cannot prevent and cannot detect.
//
// It also reports what it could NOT check. A scanner that finds nothing because it read no
// secrets is indistinguishable from a clean tree, and only one of those is good news.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ALL = process.argv.includes('--all');

// Where the live secrets are, and how to pull the value out of each. Adding a credential
// here is the whole maintenance cost — and forgetting to is the failure mode, so the tool
// reports every source it could not read rather than quietly scanning fewer things.
const SOURCES = [
  { label: 'LAN gate key', file: 'data/gate-key.txt', pick: (t) => [t.trim()] },
  {
    label: 'Google OAuth client secret',
    file: 'data/google-client.json',
    pick: (t) => { const c = JSON.parse(t); const o = c.installed || c.web || c; return [o.client_secret]; },
  },
  {
    label: 'Google refresh tokens',
    file: 'data/google-tokens.json',
    pick: (t) => Object.values(JSON.parse(t)).map((v) => v.refresh_token),
  },
  { label: 'Google refresh token (legacy)', file: 'data/google-token.json', pick: (t) => [JSON.parse(t).refresh_token] },
];

const secrets = [];
const unreadable = [];
for (const s of SOURCES) {
  const p = path.join(ROOT, s.file);
  if (!fs.existsSync(p)) { unreadable.push(`${s.label} — ${s.file} does not exist`); continue; }
  try {
    const vals = s.pick(fs.readFileSync(p, 'utf8')).filter((v) => typeof v === 'string' && v.length >= 12);
    if (!vals.length) { unreadable.push(`${s.label} — read but no usable value found`); continue; }
    vals.forEach((v) => secrets.push({ label: s.label, value: v }));
  } catch (err) { unreadable.push(`${s.label} — ${err.message}`); }
}

// TRACKED **AND** UNTRACKED-BUT-NOT-IGNORED, by default. Scanning only tracked files was the
// first version and it was wrong in the most useless direction: a brand-new uncommitted file
// is exactly where a pasted secret lives, and it is invisible to `git ls-files`. Proved by a
// probe — planting the live gate key in a new file produced "no live secret value appears",
// because the file had never been committed. -co --exclude-standard covers both, and still
// honours .gitignore so the credential files themselves are not self-reported.
//
// --all additionally includes ignored files, which is how you check whether an ignored file
// holds a SECOND secret's value (a token pasted into a report, say). It will always "find"
// each secret in its own source file; those are filtered below.
const gitArgs = ALL ? ['ls-files', '-coi', '--exclude-standard'] : ['ls-files', '-co', '--exclude-standard'];
const list = execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map((f) => f.trim()).filter(Boolean);

const ownSource = new Set(SOURCES.map((s) => s.file));

console.log(`  ${secrets.length} secret value(s) loaded, scanning ${list.length} file(s) `
  + `(${ALL ? 'including ignored' : 'tracked + untracked, ignored excluded'})\n`);

let hits = 0;
for (const f of list) {
  const p = path.join(ROOT, f);
  let text;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
    text = fs.readFileSync(p, 'utf8');
  } catch { continue; }
  for (const s of secrets) {
    if (!text.includes(s.value)) continue;
    // A credential file containing its own secret is the file doing its job, not a leak.
    if (ownSource.has(f.replace(/\\/g, '/'))) continue;
    hits++;
    // The value itself is NEVER printed. Reporting a leak by echoing the leak would put it
    // in a terminal, a log and a scrollback.
    console.log(`  LEAK  ${f}  contains the ${s.label} (${s.value.length} chars, not shown)`);
  }
}

console.log(hits ? `\n  ${hits} hit(s) — remove the value, then ROTATE it. A committed secret stays committed.`
  : '  no live secret value appears in any scanned file.');

// The residue. "Scanned nothing and found nothing" must not read like "scanned everything".
if (unreadable.length) {
  console.log('\n  COULD NOT CHECK, so this run is not a clean bill of health for these:');
  unreadable.forEach((u) => console.log(`    ${u}`));
}
if (!ALL) console.log('\n  Tracked files only. Untracked files can still hold a copy — re-run with --all.');
console.log('  Blind to: git HISTORY, backups, and anything outside this repo.');

process.exitCode = hits ? 1 : 0;
// ---- history mode ------------------------------------------------------------------------
//
// `--history` scans every blob ever committed, not just the working tree.
//
// IT EXISTS BECAUSE OF THE FIRST PUSH. Everything above answers "is a secret in the files I can
// see", which is the right question every day except one: the day this repository gains a
// remote, the thing published is the HISTORY. A credential committed in March and deleted in
// April is still in the pack, still fetchable, and still valid if it was never rotated.
//
// It reports the commit and path so a hit can be judged rather than merely feared, and it never
// prints the value itself — a leak report that quotes the secret has published it again.
if (process.argv.includes('--history')) {
  if (!secrets.length) {
    console.log('\n  No secret values could be loaded, so the history was NOT scanned.');
    console.log('  That is a failure to look, not a clean result.');
    process.exitCode = 1;
  } else {
    let blobs = [];
    try {
      blobs = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
        .split('\n').filter(Boolean)
        .map((line) => {
          const sp = line.indexOf(' ');
          return sp < 0 ? null : { sha: line.slice(0, sp), path: line.slice(sp + 1) };
        }).filter(Boolean);
    } catch (e) {
      console.log(`\n  Could not list history objects: ${e.message}`);
      process.exitCode = 1;
    }

    const hits = [];
    let scanned = 0;
    let unreadableBlobs = 0;
    for (const b of blobs) {
      let text;
      try {
        text = execFileSync('git', ['cat-file', '-p', b.sha], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      } catch { unreadableBlobs += 1; continue; }
      scanned += 1;
      for (const s of secrets) {
        if (text.includes(s.value)) hits.push({ label: s.label, path: b.path, sha: b.sha.slice(0, 8) });
      }
    }

    console.log(`\n  HISTORY: ${scanned} blob(s) scanned across every commit, ${secrets.length} secret value(s).`);
    if (unreadableBlobs) console.log(`  ${unreadableBlobs} object(s) could not be read and were NOT checked.`);
    if (hits.length) {
      console.log('\n  A LIVE SECRET APPEARS IN THE HISTORY. Do not add a remote until it is rotated:');
      for (const h of hits) console.log(`    ${h.label} — ${h.path} (blob ${h.sha})`);
      console.log('\n  Rewriting history does not un-leak it once pushed. Rotate the credential first.');
      process.exitCode = 1;
    } else {
      console.log('  No live secret value appears in any historical blob.');
      console.log('  Still blind to: values that were never loaded above, and anything outside this repo.');
    }
  }
}
