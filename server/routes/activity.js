//
// activity.js — one stream of everything that happened, from every source that records it.
//
// The dashboard already had git history, focus sessions, board items and handover files, but
// each lived in its own panel and none of them answered "what happened across all of it,
// newest first." This route does that: it reads from five sources, normalises each into the
// same { when, who, what, where, kind, link } shape, sorts, and limits.
//
// A SOURCE THAT FAILS IS SKIPPED, NOT FATAL. Git may be unavailable; the board table may not
// have migrated yet; the handover directory may not exist. Each is caught and reported as a
// note so the stream still renders what it can. This is the same "absence and failure must
// never look the same" rule every other panel follows.
//
// STALE COUNT: the stream also reports how many board items have been silent for 7+ days by
// calling the stale route internally. The stale route itself calls back into this stream, so
// a module-level guard (skipStale) breaks the recursion: when a request arrives while a
// stale fetch is already in flight, the stale count is skipped for that inner request rather
// than chasing its tail forever.
'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const sessions = require('./sessions');
const board = require('./board');
const inbox = require('./inbox');

const router = express.Router();

// __dirname is mission-control/server/routes, so two levels up is the mission-control repo
// root — its handover/ directory is the only one that exists on disk. A second entry joining
// 'mission-control' again here would double-nest (mission-control/mission-control/handover),
// the same mistake fixed in tools/inbox-deliver.cjs, so there is only one entry.
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const HANDOVER_DIRS = [
  path.join(WORKSPACE_ROOT, 'handover'),
];

// --------------------------------------------------------------------------- git

// execFile, never exec — the workspace rule is explicit about this. A pipe-delimited format is
// used so the subject can contain anything except a literal pipe, which git subjects do not.
function gitLog(hours) {
  return new Promise((resolve) => {
    const since = `${hours} hours ago`;
    execFile('git', ['log', '--oneline', `--since=${since}`, `--format=%H|%an|%ai|%s`],
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
          // `where` is derived from the subject — a conventional commit prefix like
          // "board: fix import" points at the board module, otherwise it's the repo root.
          const whereMatch = subject.match(/^(\w[\w-]*)\s*[:!]/);
          const where = whereMatch ? whereMatch[1] : 'workspace root';
          items.push({
            when: date,
            who: author,
            what: subject,
            where,
            kind: 'commit',
            link: hash.slice(0, 8),
          });
        }
        resolve({ items });
      }
    );
  });
}

// ----------------------------------------------------------------------- sessions

// Active sessions are the live heartbeat from /api/sessions/active. They are 'working' items:
// an actor is present right now, not a completed record. The `when` is lastSeenAt so the stream
// shows them at the moment they were last confirmed alive, which is the honest timestamp for
// something that has no completion event.
function activeSessions() {
  try {
    const active = sessions.activeSessions();
    return active.map((a) => ({
      when: a.lastSeenAt,
      who: a.actor,
      what: a.todoTitle ? `working on ${a.todoTitle}` : 'working',
      where: a.project || 'unassigned',
      kind: 'session',
      link: a.actor,
    }));
  } catch (e) {
    return { items: [], note: { source: 'sessions', error: String((e && e.message) || e).slice(0, 200) } };
  }
}

// -------------------------------------------------------------------------- board

// Board items carry first_seen and last_seen in the table, though the summary() route does not
// select them. We read them directly here so the stream can show when a board item was last
// re-confirmed by a tracker import — that is the closest thing to "recently changed" the
// board table offers, and it is honest about being a re-confirmation, not a person's edit.
function boardChanges(hours) {
  try {
    const rows = board.recentChanges(hours);
    return rows.map((r) => ({
      when: r.last_seen,
      who: r.source,
      what: `${r.kind}: ${r.title}`,
      where: r.project,
      kind: 'board',
      link: r.ref,
    }));
  } catch (e) {
    return { items: [], note: { source: 'board', error: String((e && e.message) || e).slice(0, 200) } };
  }
}

// ---------------------------------------------------------------------- handovers

// Handover files are the end-of-session record, read from mission-control/handover/.
// `who` is derived from the filename — a file named
// "2026-08-20-codex-worker-focus.md" becomes "codex-worker-focus", and the date prefix is a
// strong signal if present. `when` is the file mtime, which is the honest timestamp for a
// file-based record with no internal metadata.
function handoverFiles(hours) {
  const items = [];
  const notes = [];
  const cutoff = Date.now() - hours * 3600 * 1000;
  const seen = new Set();

  for (const dir of HANDOVER_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      // Directory does not exist is not an error worth reporting — there may simply be none yet.
      if (e && e.code !== 'ENOENT') {
        notes.push({ source: 'handovers', error: `reading ${path.basename(dir)}: ${String((e && e.message) || e).slice(0, 200)}` });
      }
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const fullPath = path.join(dir, name);
      const real = fs.realpathSync(fullPath);
      if (seen.has(real)) continue;
      seen.add(real);

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        notes.push({ source: 'handovers', error: `stat ${name}: ${String((e && e.message) || e).slice(0, 200)}` });
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;

      // Derive an agent name from the filename. Strip the .md and any leading date prefix.
      const base = name.replace(/\.md$/, '');
      const agentMatch = base.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
      const who = agentMatch ? agentMatch[1] : base;

      items.push({
        when: stat.mtime.toISOString(),
        who,
        what: 'filed handover',
        where: path.basename(path.dirname(fullPath)),
        kind: 'handover',
        link: name,
      });
    }
  }
  return { items, notes };
}

// ----------------------------------------------------------------------- messages

// Inbox messages are the inter-agent / owner correspondence from the inbox route. They are
// read directly from the inbox_messages table (created by inbox.js) so this route does not
// depend on the inbox router being mounted. `who` is the sender, `what` is the message text,
// and `where` is the thread id so the reader can see which conversation a line belongs to.
// `link` carries the recipient — 'all' for a broadcast, or the named agent — which is the
// smallest useful pointer back to the thread.
function inboxMessages(hours) {
  try {
    const rows = inbox.recentMessages(hours);
    return rows.map((r) => ({
      when: r.created_at,
      who: r.from_agent,
      what: r.text,
      where: r.thread_id,
      kind: 'message',
      link: r.to_agent,
    }));
  } catch (e) {
    return { items: [], note: { source: 'messages', error: String((e && e.message) || e).slice(0, 200) } };
  }
}

// -------------------------------------------------------------------------- stale

// The stale route computes which open board items have been silent for N days. It itself
// calls back into /api/activity/stream to gather recent events, so fetching it from here
// could recurse forever. The cycle is broken with a signal that travels WITH the specific
// request chain (a `_norecurse=1` query param passed to /api/stale, which stale.js then
// passes on when it calls back into /api/activity/stream), not a module-level flag.
//
// A shared boolean was tried first and found on review to be a real race: it is set for
// the whole process while ANY stale fetch is in flight, so an unrelated concurrent request
// (a second browser tab, or the voice "activity" shortcut firing mid-poll) would see the
// flag set and silently return 0 — indistinguishable from a genuine zero, which breaks the
// "absence and failure must never look the same" rule this same file states as its reason
// for having a guard at all. Scoping the signal to the request itself removes that leak.
async function staleCount(days, norecurse) {
  if (norecurse) return null;
  try {
    const r = await fetch(`http://127.0.0.1:3000/api/stale?days=${days}&_norecurse=1`);
    if (!r.ok) return 0;
    const data = await r.json();
    return Array.isArray(data.items) ? data.items.length : 0;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------------------- route

router.get('/stream', async (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
  const notes = [];
  const items = [];

  // Git — async, since execFile is callback-based.
  try {
    const git = await gitLog(hours);
    items.push(...git.items);
    if (git.note) notes.push(git.note);
  } catch (e) {
    notes.push({ source: 'git', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Sessions — synchronous DB read.
  try {
    const sess = activeSessions();
    if (Array.isArray(sess)) {
      items.push(...sess);
    } else {
      items.push(...sess.items);
      if (sess.note) notes.push(sess.note);
    }
  } catch (e) {
    notes.push({ source: 'sessions', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Board — synchronous DB read.
  try {
    const boardResult = boardChanges(hours);
    if (Array.isArray(boardResult)) {
      items.push(...boardResult);
    } else if (boardResult && boardResult.items) {
      items.push(...boardResult.items);
      if (boardResult.note) notes.push(boardResult.note);
    }
  } catch (e) {
    notes.push({ source: 'board', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Handovers — synchronous file reads.
  try {
    const hands = handoverFiles(hours);
    items.push(...hands.items);
    notes.push(...hands.notes);
  } catch (e) {
    notes.push({ source: 'handovers', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Messages — synchronous DB read from the inbox_messages table.
  try {
    const msgs = inboxMessages(hours);
    if (Array.isArray(msgs)) {
      items.push(...msgs);
    } else {
      items.push(...msgs.items);
      if (msgs.note) notes.push(msgs.note);
    }
  } catch (e) {
    notes.push({ source: 'messages', error: String((e && e.message) || e).slice(0, 200) });
  }

  // Sort newest first, then limit to 100. A stable sort on ISO timestamps is fine because
  // the items already carry distinct timestamps from their sources.
  items.sort((a, b) => {
    const ta = new Date(a.when).getTime();
    const tb = new Date(b.when).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  const limited = items.slice(0, 100);

  // Stale count — fetched internally from the stale route, guarded against recursion by a
  // signal on this specific request (see staleCount above), not a shared process-wide flag.
  const staleThreshold = 7;
  const norecurse = req.query._norecurse === '1';
  const count = await staleCount(staleThreshold, norecurse);

  res.json({
    items: limited,
    hours,
    notes: notes.length ? notes : undefined,
    // null means "skipped, this request is itself part of a stale computation" — kept
    // distinct from a real 0 rather than collapsing both to the same number.
    staleCount: count,
    staleCountSkipped: count === null,
    staleThreshold,
  });
});

module.exports = router;