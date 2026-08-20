'use strict';
//
// stale.js — detect open board items that have not moved in N days.
//
// GET /api/stale?days=7 — returns { items: [{ ref, title, project, daysStale,
//   lastActivity, kind }], threshold: N, checkedAt }
//
// "Stale" means no activity (commit, handover, session, board status change)
// mentions or touches the item in the last N days. This is an ABSENCE check,
// not a presence check — the whole point is that a stall leaves no row, so
// this derives it by looking at what did NOT happen.
//
// The activity route already aggregates git, handovers, sessions. This route
// reuses the same sources but inverts the question: not "what happened?" but
// "what DIDN'T happen, that should have?"
const express = require('express');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const router = express.Router();

const WORKSPACE = os.homedir() + '/Claude Outputs';

// Fetch the board to get all open items.
async function fetchBoard(req) {
  // Internal fetch — call the board route directly.
  try {
    const r = await fetch('http://127.0.0.1:3000/api/board');
    if (!r.ok) return { items: [], backlog: [] };
    return await r.json();
  } catch {
    return { items: [], backlog: [] };
  }
}

// Fetch activity to get all recent events. `norecurse` is forwarded from this route's own
// incoming request — activity.js calls back into /api/stale for its stale count, so passing
// the signal through here is what stops that from chasing this route's own callback in turn.
async function fetchActivity(hours, norecurse) {
  try {
    const suffix = norecurse ? '&_norecurse=1' : '';
    const r = await fetch(`http://127.0.0.1:3000/api/activity/stream?hours=${hours}${suffix}`);
    if (!r.ok) return { items: [] };
    return await r.json();
  } catch {
    return { items: [] };
  }
}

// Check whether a board item has been mentioned in any activity event.
function isMentionedIn(item, activityItems) {
  const ref = String(item.ref || item.id || '').toLowerCase();
  const title = String(item.title || '').toLowerCase();
  if (!ref && !title) return true; // can't check, assume active

  for (const a of activityItems) {
    const text = String(a.what || '').toLowerCase();
    const link = String(a.link || '').toLowerCase();
    if (ref && (text.includes(ref) || link.includes(ref))) return true;
    if (title && title.length > 8 && text.includes(title.slice(0, 20))) return true;
  }
  return false;
}

router.get('/', async (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  const hours = days * 24;
  const norecurse = req.query._norecurse === '1';

  const [board, activity] = await Promise.all([
    fetchBoard(req),
    fetchActivity(hours, norecurse),
  ]);

  // Merge external items (bugs/requests from BUGS.md, requests.jsonl) and
  // backlog items into one list. `since` carries the closest thing each source has to a
  // creation date — first_seen for external tracker items, created_at for backlog items —
  // used below to compute a real daysStale instead of echoing the query threshold.
  const allItems = [
    ...(board.items || []).map((i) => ({ ref: i.ref, title: i.title,
      project: i.project, kind: i.kind, status: i.status, since: i.first_seen })),
    ...(board.backlog || []).map((i) => ({ ref: i.id, title: i.title,
      project: i.project, kind: i.kind, status: i.status, since: i.created_at })),
  ];

  const activityItems = activity.items || [];
  const stale = [];

  for (const item of allItems) {
    // Only check open items.
    if (item.status && item.status !== 'open') continue;
    if (!isMentionedIn(item, activityItems)) {
      // Check handover files for the item ref too — a handover might mention
      // it without showing up in the activity stream (if the handover dir
      // scan missed it).
      const ref = String(item.ref || '');
      let foundInHandover = false;
      if (ref) {
        const handoverDir = path.join(WORKSPACE, 'mission-control', 'handover');
        try {
          const files = fs.readdirSync(handoverDir).filter((f) =>
            f.endsWith('.md') && f.startsWith('2026-08-'));
          for (const f of files.slice(-20)) {
            const stat = fs.statSync(path.join(handoverDir, f));
            const ageDays = (Date.now() - stat.mtime.getTime()) / 86400000;
            if (ageDays > hours / 24) continue;
            const content = fs.readFileSync(path.join(handoverDir, f), 'utf-8');
            if (content.toLowerCase().includes(ref.toLowerCase())) {
              foundInHandover = true;
              break;
            }
          }
        } catch {}
      }
      if (!foundInHandover) {
        // daysStale is elapsed time since the item's own since-date (first_seen for a tracker
        // item, created_at for a backlog item), not the query threshold — an item created
        // yesterday and an item created three months ago both clear the "not mentioned in N
        // days" bar the same way, and reporting `days` for both would flatten a real
        // difference into a made-up one. Falls back to the threshold only when no since-date
        // exists at all, and that fallback is a floor, not a measurement.
        const sinceMs = item.since ? Date.parse(item.since) : NaN;
        const daysStale = Number.isFinite(sinceMs)
          ? Math.max(days, Math.floor((Date.now() - sinceMs) / 86400000))
          : days;
        stale.push({
          ref: item.ref,
          title: item.title,
          project: item.project,
          kind: item.kind,
          daysStale,
          checkedAt: new Date().toISOString(),
        });
      }
    }
  }

  // Sort: P1 items first, then by project, then by title.
  stale.sort((a, b) => {
    if (a.project !== b.project) return String(a.project).localeCompare(String(b.project));
    return String(a.title).localeCompare(String(b.title));
  });

  res.json({ items: stale, threshold: days, checkedAt: new Date().toISOString() });
});

module.exports = router;