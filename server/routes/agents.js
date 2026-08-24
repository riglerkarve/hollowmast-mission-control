'use strict';
//
// agents.js — machine-readable registry of every Hermes profile in this workspace.
//
// GET /api/agents — returns { agents: [{ name, model, status, currentTask, lastHeartbeat,
//   lastSeen, doneCount, runningCount }], source, generatedAt } or { error, reason } when
//   the roster or the board could not be read.
//
// REBUILT 23 Aug 2026 (t_e0d4f4cb). The previous version hardcoded a five-name roster
// (Claude/Codex/Ollama/Hermes/Scribe) from before the Hermes multi-profile system existed,
// and inferred "active" from /api/sessions/active heartbeats — a CCD-session concept that
// predates `hermes kanban` and has nothing to do with which profile is actually claiming
// and running tasks. Ground truth for "who is working right now" is the kanban board: a
// profile is running exactly when it holds a running task, and idle otherwise. There is no
// guessing here — `hermes kanban list --status running` IS the claim.
//
// EXTENDED 24 Aug 2026 (t_137df3fc), owner's explicit ask: "make this panel show an
// interactive view of the agents and what they're working on". Ready and blocked tasks
// are now surfaced too (not just running), each with its full body text, so the panel can
// open a real detail view on click instead of just a name + a status word. Reused, not
// reinvented: `hermes kanban list --status <x> --json` already returns id/title/body/
// assignee/status/priority/timestamps for every status, the same shape open-tasks.js
// already reads for the Focus panel — this route does not compute anything the CLI does
// not already expose.
//
// TWO ROSTERS EXIST IN THIS WORKSPACE AND THIS FILE DOES NOT RECONCILE THEM. TEAM.md
// defines a five-ROLE shift cycle (worker/supervisor/manager/architect/scribe) tracked in
// `team_sessions` — that is a role structure, not a name list, and Codex/Claude/Ollama
// sessions fill it. `hermes profile list` is a different thing: the actual named identities
// (gaffer, vera, frank, doris, eleanor, margaret, ops, business, build, codex, stan,
// default) that hold kanban claims. Neither TEAM.md nor CODEX.md says one supersedes the
// other, and guessing would be building a second, silently-wrong answer to a question this
// file was asked not to guess at (see t_e0d4f4cb body). So: this endpoint answers "who is
// actually working on the kanban board" from the profile roster, full stop. It does not
// touch team_sessions, does not rename anyone into a TEAM.md role, and the reconciliation
// question is flagged back on the task rather than decided here.
const express = require('express');
const hermes = require('../hermes-cli');

const router = express.Router();

// `hermes profile list` prints a fixed-width table with a `\u25c6` marking the active
// profile in the first column. Parsed by column count, not position — the table has been
// reformatted before and a positional slice is the failure mode that would not tell you.
function parseProfileList(out) {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const profiles = [];
  let sawHeader = false;
  for (const line of lines) {
    if (/^profile\s/i.test(line)) { sawHeader = true; continue; }
    if (!sawHeader) continue;
    if (/^[─\-]+$/.test(line.replace(/\s/g, ''))) continue; // the rule under the header
    const clean = line.replace(/^\u25c6/, '').trim(); // strip the "current profile" marker
    const cols = clean.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const [name, model] = cols;
    profiles.push({ name, model: model === '\u2014' ? null : model });
  }
  return profiles;
}

// Same elapsed-time rule as open-tasks.js (M131's stuck-longest logic) — not
// reimplemented differently here, just the same label shape for the same fact.
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

const toIso = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);

router.get('/', async (req, res) => {
  if (!hermes.available) {
    // Absence and failure must not look the same: no roster is an empty array, "could not
    // find the hermes CLI" is a 502 with a reason, never a silently empty agent list.
    return res.status(502).json({ error: 'hermes CLI not found', reason: 'no-hermes' });
  }

  const profileList = await hermes.runAsync(['profile', 'list']);
  if (!profileList.ok) {
    return res.status(502).json({ error: profileList.error || 'hermes profile list failed', reason: profileList.reason });
  }

  // ASYNC, in parallel (t_137df3fc): these four calls do not depend on each other, and
  // runAsync does not block the event loop the way execFileSync did — sequential sync
  // calls here were freezing the whole server for 10+ seconds per /api/agents request
  // (see hermes-cli.js's ASYNC header comment for the measured cause).
  const [runningRaw, readyRaw, blockedRaw, doneRaw] = await Promise.all([
    hermes.runAsync(['kanban', 'list', '--status', 'running', '--json']),
    hermes.runAsync(['kanban', 'list', '--status', 'ready', '--json']),
    hermes.runAsync(['kanban', 'list', '--status', 'blocked', '--json']),
    hermes.runAsync(['kanban', 'list', '--status', 'done', '--json']),
  ]);

  function parseList(raw) {
    if (!raw.ok) return { list: [], ok: false };
    try { return { list: JSON.parse(raw.out), ok: true }; } catch { return { list: [], ok: false }; }
  }

  const { list: running, ok: running_ok } = parseList(runningRaw);
  const { list: ready, ok: ready_ok } = parseList(readyRaw);
  const { list: blocked, ok: blocked_ok } = parseList(blockedRaw);
  const { list: done, ok: done_ok } = parseList(doneRaw);

  // Last completed task per assignee, so an idle profile can show when it was last seen
  // doing anything, not just "idle" with nothing behind it.
  const lastDoneByAssignee = {};
  for (const t of done) {
    const prev = lastDoneByAssignee[t.assignee];
    if (!prev || (t.completed_at || 0) > (prev.completed_at || 0)) lastDoneByAssignee[t.assignee] = t;
  }
  const doneCountByAssignee = {};
  for (const t of done) doneCountByAssignee[t.assignee] = (doneCountByAssignee[t.assignee] || 0) + 1;

  // One "current task" per assignee, in priority order running > blocked > ready — a
  // profile actually executing something outranks one merely waiting on a claim or stuck
  // on a blocker for the purposes of "what is this agent doing right now". Within a status,
  // most-recently-started/created wins, same tie-break agents.js always used.
  function byAssignee(list, sinceField) {
    const map = {};
    for (const t of list) {
      const prev = map[t.assignee];
      if (!prev || (t[sinceField] || 0) > (prev[sinceField] || 0)) map[t.assignee] = t;
    }
    return map;
  }
  const runningByAssignee = byAssignee(running, 'started_at');
  const blockedByAssignee = byAssignee(blocked, 'started_at');
  const readyByAssignee = byAssignee(ready, 'created_at');

  // Heartbeat is per-task (kanban events), not per-profile — fetch it only for the tasks
  // that are actually running, one `show` per running task. Bounded by how many profiles
  // can be running at once, never by the whole roster. Run all lookups concurrently
  // (Promise.all over runAsync) rather than one-at-a-time — sequential sync `show` calls
  // were part of the same event-loop-blocking bug fixed above.
  const heartbeatByTaskId = {};
  let heartbeats_ok = true;
  const runningTasks = Object.values(runningByAssignee);
  const heartbeatResults = await Promise.all(
    runningTasks.map((t) => hermes.runAsync(['kanban', 'show', t.id, '--json'])),
  );
  runningTasks.forEach((t, i) => {
    const shown = heartbeatResults[i];
    if (!shown.ok) { heartbeats_ok = false; return; }
    try {
      const parsed = JSON.parse(shown.out);
      const hbEvents = (parsed.events || []).filter((e) => e.kind === 'heartbeat');
      const latest = hbEvents.length ? hbEvents[hbEvents.length - 1] : null;
      heartbeatByTaskId[t.id] = latest ? latest.created_at : (t.started_at || null);
    } catch { heartbeats_ok = false; }
  });

  const now = Math.floor(Date.now() / 1000);

  // Build the currentTask payload for a raw kanban task record. `since` is "how long has
  // this agent been on it" — started_at for running/blocked (it was claimed and began),
  // created_at for ready (it has been waiting since creation, nothing has begun yet).
  function taskPayload(t) {
    const since = t.started_at || t.created_at || null;
    const elapsedSeconds = since ? Math.max(0, now - since) : null;
    return {
      id: t.id,
      title: t.title,
      body: t.body || '',
      status: t.status,
      priority: t.priority ?? null,
      startedAt: toIso(t.started_at),
      createdAt: toIso(t.created_at),
      elapsedSeconds,
      elapsedLabel: elapsedLabel(elapsedSeconds),
    };
  }

  const agents = parseProfileList(profileList.out).map((p) => {
    const task = runningByAssignee[p.name] || blockedByAssignee[p.name] || readyByAssignee[p.name] || null;
    const lastDone = lastDoneByAssignee[p.name] || null;
    const status = task ? task.status : 'idle';
    return {
      name: p.name,
      model: p.model,
      status,
      currentTask: task ? taskPayload(task) : null,
      lastHeartbeat: task && task.status === 'running' ? toIso(heartbeatByTaskId[task.id]) : null,
      lastSeen: task && task.status === 'running'
        ? toIso(heartbeatByTaskId[task.id])
        : (lastDone ? toIso(lastDone.completed_at) : null),
      doneCount: doneCountByAssignee[p.name] || 0,
    };
  });

  res.json({
    agents,
    source: 'hermes-kanban',
    generatedAt: new Date().toISOString(),
    residue: {
      running_list_ok: running_ok,
      ready_list_ok: ready_ok,
      blocked_list_ok: blocked_ok,
      done_list_ok: done_ok,
      heartbeats_ok,
    },
  });
});

module.exports = router;
