'use strict';
//
// open-tasks.js — the owner's real actionable kanban items, in front of him.
//
// GET /api/open-tasks — returns { tasks: [{ id, title, body, assignee, status,
//   priority, createdAt, startedAt, elapsedSeconds, elapsedLabel }], generatedAt }
//   or { error, reason } when the hermes CLI could not be read at all.
//
// Owner's direct quote, 24 Aug: tasks must show clearly on the dashboard "in front of
// him" so he can't forget them, sorted oldest first (M131's stuck-longest logic,
// reused rather than reimplemented — see fromStalest() in briefing.js). Ground truth
// is the kanban board itself, read straight through hermes-cli.js the same way
// agents.js does for /api/agents: one shell-out, one JSON parse, no second store that
// could disagree with `hermes kanban show` about what a task's body actually says.
//
// SCOPE NOTE (t_3ab3bfae): the task asked for a day-typing filter (income vs music) if
// task metadata supports it. It does not — `hermes kanban show --json` exposes no type/
// category field, only id, title, body, assignee, status, priority, timestamps. Inventing
// one here would be the exact mistake CLAUDE.md warns against, so this route ships without
// it. If that metadata is added to the kanban schema later, filtering by it is a small
// addition to this route, not a rebuild.
//
// "Not internal agent housekeeping": council/swarm/hiring-probe tasks are a recurring,
// recognisable shape in this board's history (see t_3ab3bfae's own body, which is full of
// them) — single-word titles like "Strategy"/"Growth"/"Discipline"/"Skeptic", or titles
// starting "Hiring probe:", "Swarm:", "Verify swarm outputs", "Synthesize swarm outputs".
// Excluded by title pattern below. This is a named, visible filter — not a silent one —
// so a real task that happens to start the same way can be found by relaxing HOUSEKEEPING_RE
// and re-reading this comment, not by guessing why it vanished.
const express = require('express');
const hermes = require('../hermes-cli');

const router = express.Router();

const HOUSEKEEPING_RE = /^(hiring probe:|swarm:|verify swarm outputs$|synthesize swarm outputs$|strategy$|growth$|discipline$|skeptic$)/i;

function elapsedLabel(seconds) {
  if (seconds == null || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

router.get('/', async (req, res) => {
  if (!hermes.available) {
    // Absence and failure must not look the same: no hermes binary is a 502 with a
    // reason, never a silently empty task list that reads as "nothing waiting".
    return res.status(502).json({ error: 'hermes CLI not found', reason: 'no-hermes' });
  }

  // ASYNC, in parallel (t_137df3fc): runAsync does not block the event loop the way the
  // old execFileSync-backed `run` did, and these two calls do not depend on each other,
  // so they run concurrently rather than one after another.
  const [runningRaw, readyRaw] = await Promise.all([
    hermes.runAsync(['kanban', 'list', '--status', 'running', '--json']),
    hermes.runAsync(['kanban', 'list', '--status', 'ready', '--json']),
  ]);

  if (!runningRaw.ok && !readyRaw.ok) {
    return res.status(502).json({
      error: runningRaw.error || readyRaw.error || 'hermes kanban list failed',
      reason: runningRaw.reason || readyRaw.reason,
    });
  }

  let running = [];
  let running_ok = runningRaw.ok;
  if (runningRaw.ok) {
    try { running = JSON.parse(runningRaw.out); } catch { running_ok = false; }
  }
  let ready = [];
  let ready_ok = readyRaw.ok;
  if (readyRaw.ok) {
    try { ready = JSON.parse(readyRaw.out); } catch { ready_ok = false; }
  }

  const now = Date.now();
  const tasks = [...running, ...ready]
    .filter((t) => !HOUSEKEEPING_RE.test(String(t.title || '').trim()))
    .map((t) => {
      // A ready task has no started_at yet — it has been waiting since it was created,
      // which is the fact worth showing ("how long has this sat untouched"), not a null.
      const since = t.started_at || t.created_at || null;
      const elapsedSeconds = since ? Math.max(0, Math.floor(now / 1000) - since) : null;
      return {
        id: t.id,
        title: t.title,
        body: t.body || '',
        assignee: t.assignee,
        status: t.status,
        priority: t.priority ?? null,
        createdAt: toIso(t.created_at),
        startedAt: toIso(t.started_at),
        elapsedSeconds,
        elapsedLabel: elapsedLabel(elapsedSeconds),
      };
    })
    // Oldest-first: M131's rule ("what has waited longest leads"), applied per-item here
    // rather than collapsed to one stalest fact — this panel is the full list that fact
    // is drawn from, not a second, possibly-disagreeing computation of it.
    .sort((a, b) => (b.elapsedSeconds ?? 0) - (a.elapsedSeconds ?? 0));

  res.json({
    tasks,
    generatedAt: new Date().toISOString(),
    residue: { running_ok, ready_ok },
  });
});

module.exports = router;
