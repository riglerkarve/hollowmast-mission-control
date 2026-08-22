//
// changes.js — a log of everything that shipped, with the question that matters most
// about each one: was it signed off, or did it arrive without an explicit decision behind it?
//
// The activity stream answers "what happened"; this route answers "what shipped that nobody
// approved." That is a narrower and more uncomfortable question, and it is the one a manager
// or owner actually asks. A commit with no decision and no owner mention is not necessarily
// wrong — it is simply unreviewed, and this route makes that state visible rather than
// letting it hide inside a larger feed.
//
// SOURCES: git commits (last 7 days) and handover filings. Each is normalised to
// { ref, title, who, when, kind, project, signedOff }. The `kind` is 'commit' or 'handover'
// so a reader can tell a code change from a session record even when both are "a thing that
// shipped today."
//
// SIGNED-OFF RULE: a change is signed off if EITHER
//   (a) its commit message / handover text mentions 'owner' (the human signer), or
//   (b) a team_decisions row references it — by commit hash in the `evidence` column, or by
//       handover filename. A decision with evidence pointing at a change is the explicit
//       sign-off this panel exists to surface the absence of.
//
// A SOURCE THAT FAILS IS SKIPPED, NOT FATAL — the same rule every other panel follows.
'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const db = require('../db');

const router = express.Router();

// __dirname is mission-control/server/routes, so two levels up is the mission-control repo
// root — its handover/ directory is the only one that exists on disk (same reasoning as
// activity.js).
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const HANDOVER_DIRS = [
  path.join(WORKSPACE_ROOT, 'handover'),
];

// --------------------------------------------------------------------------- git

// execFile, never exec — the workspace rule is explicit about this. Pipe-delimited format
// so the subject can contain anything except a literal pipe.
function gitLog(days) {
  return new Promise((resolve) => {
    const since = `${days} days ago`;
    execFile('git', ['log', `--since=${since}`, `--format=%H|%an|%ai|%s`],
      { cwd: WORKSPACE_ROOT, maxBuffer: 1024 * 1024 * 4 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ items: [], note: { source: 'git', error: String((err && err.message) || err).slice(0, 200) } });
          return;
        }
        const items = [];
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split('|');
          if (parts.length < 4) continue;
          const [hash, author, date, ...subjectParts] = parts;
          const subject = subjectParts.join('|');
          // Project is derived from a conventional-commit prefix ("board: fix import" → board).
          const projMatch = subject.match(/^(\w[\w-]*)\s*[:!]/);
          const project = projMatch ? projMatch[1] : 'workspace root';
          items.push({
            ref: hash.slice(0, 8),
            title: subject,
            who: author,
            when: date,
            kind: 'commit',
            project,
            _fullHash: hash,
          });
        }
        resolve({ items });
      }
    );
  });
}

// ---------------------------------------------------------------------- handovers

// Handover files from mission-control/handover/. `who` is derived from the filename (same
// logic as activity.js): a file named "2026-08-20-codex-worker-focus.md" becomes
// "codex-worker-focus". `when` is the file mtime — the honest timestamp for a file with no
// internal metadata.
function handoverFiles(days) {
  const items = [];
  const notes = [];
  const cutoff = Date.now() - days * 86400 * 1000;
  const seen = new Set();

  for (const dir of HANDOVER_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        notes.push({ source: 'handovers', error: `reading ${path.basename(dir)}: ${String((e && e.message) || e).slice(0, 200)}` });
      }
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const fullPath = path.join(dir, name);
      let real;
      try { real = fs.realpathSync(fullPath); } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);

      let stat;
      try { stat = fs.statSync(fullPath); } catch (e) {
        notes.push({ source: 'handovers', error: `stat ${name}: ${String((e && e.message) || e).slice(0, 200)}` });
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;

      // Read the body to check for an 'owner' mention (sign-off signal).
      let body = '';
      try { body = fs.readFileSync(fullPath, 'utf8'); } catch { /* unreadable — body stays empty */ }

      const base = name.replace(/\.md$/, '');
      const agentMatch = base.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
      const who = agentMatch ? agentMatch[1] : base;

      items.push({
        ref: name,
        title: 'filed handover',
        who,
        when: stat.mtime.toISOString(),
        kind: 'handover',
        project: path.basename(path.dirname(fullPath)),
        _body: body,
      });
    }
  }
  return { items, notes };
}

// ----------------------------------------------------------------- sign-off check

// A change is signed off if:
//   1. its text (commit subject or handover body) mentions 'owner' — the human signer, or
//   2. a team_decisions row references it:
//      - for commits: the commit's full hash appears in the evidence column (commit sha is
//        the documented use of that column, per team.js line 274), OR the short ref appears.
//      - for handovers: the filename appears in the evidence column.
//
// The decision evidence check is a single query per batch, not per item: we load all
// decision evidence strings once and match in JS, so a 200-commit window is one DB read
// rather than 200.
function decisionEvidenceStrings() {
  try {
    const rows = db.prepare('SELECT evidence FROM team_decisions WHERE evidence IS NOT NULL AND TRIM(evidence) <> \'\'').all();
    return rows.map((r) => String(r.evidence || ''));
  } catch {
    // team_decisions may not have migrated yet — absence of the table is not a failure to look.
    return [];
  }
}

function isSignedOff(item, evidenceStrings) {
  const text = `${item.title || ''} ${item._body || ''}`.toLowerCase();
  if (text.includes('owner')) return true;

  // Check decision evidence for a reference to this change.
  const ref = String(item.ref || '');
  const fullHash = String(item._fullHash || '');
  for (const e of evidenceStrings) {
    const lower = e.toLowerCase();
    if (fullHash && lower.includes(fullHash.toLowerCase())) return true;
    if (ref && lower.includes(ref.toLowerCase())) return true;
  }
  return false;
}

// --------------------------------------------------------------------------- route

router.get('/', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const notes = [];
  const items = [];

  // Git — async (execFile).
  try {
    const git = await gitLog(days);
    items.push(...git.items);
    if (git.note) notes.push(git.note);
  } catch (e) {
    notes.push({ source: 'git', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Handovers — synchronous file reads.
  try {
    const hands = handoverFiles(days);
    items.push(...hands.items);
    notes.push(...hands.notes);
  } catch (e) {
    notes.push({ source: 'handovers', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Sign-off determination — one DB read for the whole batch.
  let evidenceStrings = [];
  try {
    evidenceStrings = decisionEvidenceStrings();
  } catch (e) {
    notes.push({ source: 'decisions', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Sort newest first before stamping, so the output is stable.
  items.sort((a, b) => {
    const ta = new Date(a.when).getTime();
    const tb = new Date(b.when).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  const stamped = items.map((item) => {
    const signedOff = isSignedOff(item, evidenceStrings);
    // Strip internal fields before returning.
    return {
      ref: item.ref,
      title: item.title,
      who: item.who,
      when: item.when,
      kind: item.kind,
      project: item.project,
      signedOff,
    };
  });

  res.json({
    items: stamped,
    days,
    notes: notes.length ? notes : undefined,
  });
});

// GET /api/changes/unsigned — only the changes that shipped without explicit sign-off.
// This is the "quick review" view: the subset a manager scans to decide what needs a
// retroactive decision. It reuses the same gathering logic and filters to signedOff === false.
router.get('/unsigned', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const notes = [];
  const items = [];

  try {
    const git = await gitLog(days);
    items.push(...git.items);
    if (git.note) notes.push(git.note);
  } catch (e) {
    notes.push({ source: 'git', error: String((e && e.message) || e).slice(0, 200) });
  }

  try {
    const hands = handoverFiles(days);
    items.push(...hands.items);
    notes.push(...hands.notes);
  } catch (e) {
    notes.push({ source: 'handovers', error: String((e && e.message) || e).slice(0, 200) });
  }

  let evidenceStrings = [];
  try {
    evidenceStrings = decisionEvidenceStrings();
  } catch (e) {
    notes.push({ source: 'decisions', error: String((e && e.message) || e).slice(0, 200) });
  }

  items.sort((a, b) => {
    const ta = new Date(a.when).getTime();
    const tb = new Date(b.when).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  const unsigned = items
    .filter((item) => !isSignedOff(item, evidenceStrings))
    .map((item) => ({
      ref: item.ref,
      title: item.title,
      who: item.who,
      when: item.when,
      kind: item.kind,
      project: item.project,
      signedOff: false,
    }));

  res.json({
    items: unsigned,
    days,
    notes: notes.length ? notes : undefined,
  });
});

module.exports = router;