#!/usr/bin/env node
//
// handover.cjs — a session records its handover at the end of a shift.
//
//   node tools/handover.cjs <file.md>              read a handover written as markdown
//   node tools/handover.cjs <file.md> --title "Website Agent"
//   node tools/handover.cjs --title "X" --done "..." --next "..."
//
// A FILE IS THE PRIMARY FORM, deliberately. Long prose passed as a shell argument is where
// this workspace loses backticks, backslashes and whole clauses — the standing rule is that
// anything resembling content gets written to a file and pointed at, never typed through a
// shell. The flags exist for one-liners.
//
// THE HEADINGS ARE THE ONES SESSIONS ALREADY WRITE. The house gate-report format from
// CLAUDE.md is BUILT / VERIFIED / DEVIATIONS / RISKS / NEXT / BLOCKED ON YOU, and six handover
// files in this workspace already use something close to it. Standardising means reading the
// form people use, not issuing a new one and then complaining it is ignored:
//
//   BUILT, VERIFIED, DONE            -> done
//   BLOCKED, BLOCKED BY              -> blocked          (what stopped this session)
//   DEVIATIONS, RISKS, CANDIDATES    -> candidates       (leads for the supervisor)
//   BLOCKED ON YOU, NEEDS OWNER      -> needs_owner      (the ONLY worker route to the owner)
//   NEXT                             -> next
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000';

const HEADINGS = [
  [/^(built|verified|done|shipped)\b/i, 'done'],
  [/^blocked on you\b|^needs? owner\b|^for the owner\b/i, 'needs_owner'],
  [/^(blocked|blocked by|stuck)\b/i, 'blocked'],
  [/^(deviations?|risks?|candidates?|findings?)\b/i, 'candidates'],
  [/^next\b/i, 'next'],
];

function parseMarkdown(text) {
  const out = {};
  let field = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/) || line.match(/^\s*\*\*(.+?)\*\*\s*:?\s*$/);
    if (h) {
      const label = h[1].replace(/[*_`]/g, '').trim();
      // BLOCKED ON YOU must be tested BEFORE BLOCKED, because "blocked on you" also matches
      // /^blocked/. Precedence by test order decides who wins and hides that it did, so the
      // order in HEADINGS is load-bearing and the more specific pattern is listed first.
      const hit = HEADINGS.find(([re]) => re.test(label));
      field = hit ? hit[1] : null;
      continue;
    }
    if (field) (out[field] = out[field] || []).push(line);
  }
  const trimmed = {};
  for (const [k, v] of Object.entries(out)) {
    const s = v.join('\n').trim();
    if (s) trimmed[k] = s;
  }
  return trimmed;
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const file = argv.find((a) => !a.startsWith('--') && /\.(md|markdown|txt)$/i.test(a));
let body = {};

if (file) {
  if (!fs.existsSync(file)) {
    console.log(`\n  COULD NOT LOOK: no file at ${path.resolve(file)}`);
    console.log('  Nothing was recorded. A handover that failed to send is not a handover that');
    console.log('  said nothing — write the file and run this again.');
    process.exit(2);
  }
  body = parseMarkdown(fs.readFileSync(file, 'utf8'));
}

for (const k of ['done', 'blocked', 'candidates', 'next']) {
  const v = flag(k.replace('_', '-'));
  if (v) body[k] = v;
}
if (flag('needs-owner')) body.needs_owner = flag('needs-owner');

body.title = flag('title') || body.title || process.env.MC_SESSION_TITLE;
body.session_id = flag('session-id') || process.env.MC_SESSION_ID || null;
body.role = flag('role') || null;
body.project = flag('project') || null;
if (flag('shift')) body.shift = flag('shift');

if (!body.title) {
  console.log('\n  A handover needs a --title (the session name), or MC_SESSION_TITLE set.');
  console.log('  Without one the supervisor cannot tell who to ask about it, and an anonymous');
  console.log('  handover is a note nobody owns.');
  process.exit(2);
}

(async () => {
  let res;
  try {
    res = await fetch(`${BASE}/api/team/handover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MC-By': 'claude' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    // THE HANDOVER IS NEVER LOST TO A DOWN SERVER. Mission Control is a desktop service that
    // is sometimes not running, and a shift's report is exactly the thing you cannot ask a
    // session to reproduce afterwards — its context is gone.
    const spool = path.join(__dirname, '..', 'data', 'handover-spool.jsonl');
    fs.appendFileSync(spool, `${JSON.stringify({ ...body, spooled_at: new Date().toISOString() })}\n`);
    console.log(`\n  Mission Control did not answer (${String((e && e.message) || e).slice(0, 80)}).`);
    console.log(`  The handover was SPOOLED to ${spool} and nothing was lost.`);
    console.log('  Run tools/handover-spool.cjs once the server is up.');
    process.exit(3);
  }

  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`\n  REFUSED (${res.status}): ${j.error || 'no detail'}`);
    process.exit(1);
  }

  console.log(`\n  Recorded handover #${j.id} for ${body.title} — shift ${j.shift}, role ${j.role}.`);
  if (!j.inRoster) {
    console.log('  NOT ON THE ROSTER. It was recorded anyway rather than refused, but the');
    console.log('  supervisor will not miss you if you go silent, because nothing knows you');
    console.log('  exist. Add yourself: node tools/team-roster.cjs --set "<title>" worker');
  }
  console.log(`  ${j.note}`);
  if (body.needs_owner) {
    console.log('\n  This handover carries a NEEDS OWNER item. It does not reach him directly —');
    console.log('  the manager is the only role that may interrupt, and it will pick this up');
    console.log('  in the daily steering quiz. That is the whole point of the routing.');
  }
})();
