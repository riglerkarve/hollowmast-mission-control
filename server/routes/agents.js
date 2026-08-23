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

router.get('/', async (req, res) => {
  if (!hermes.available) {
    // Absence and failure must not look the same: no roster is an empty array, "could not
    // find the hermes CLI" is a 502 with a reason, never a silently empty agent list.
    return res.status(502).json({ error: 'hermes CLI not found', reason: 'no-hermes' });
  }

  const profileList = hermes.run(['profile', 'list']);
  if (!profileList.ok) {
    return res.status(502).json({ error: profileList.error || 'hermes profile list failed', reason: profileList.reason });
  }

  const runningRaw = hermes.run(['kanban', 'list', '--status', 'running', '--json']);
  const doneRaw = hermes.run(['kanban', 'list', '--status', 'done', '--json']);

  let running = [];
  let running_ok = runningRaw.ok;
  if (runningRaw.ok) {
    try { running = JSON.parse(runningRaw.out); } catch { running_ok = false; }
  }
  let done = [];
  let done_ok = doneRaw.ok;
  if (doneRaw.ok) {
    try { done = JSON.parse(doneRaw.out); } catch { done_ok = false; }
  }

  // Last completed task per assignee, so an idle profile can show when it was last seen
  // doing anything, not just "idle" with nothing behind it.
  const lastDoneByAssignee = {};
  for (const t of done) {
    const prev = lastDoneByAssignee[t.assignee];
    if (!prev || (t.completed_at || 0) > (prev.completed_at || 0)) lastDoneByAssignee[t.assignee] = t;
  }
  const doneCountByAssignee = {};
  for (const t of done) doneCountByAssignee[t.assignee] = (doneCountByAssignee[t.assignee] || 0) + 1;

  const runningByAssignee = {};
  for (const t of running) {
    // A profile can in principle hold more than one running task; surface the one with the
    // most recent start so "current task" means something even if that happens.
    const prev = runningByAssignee[t.assignee];
    if (!prev || (t.started_at || 0) > (prev.started_at || 0)) runningByAssignee[t.assignee] = t;
  }

  // Heartbeat is per-task (kanban events), not per-profile — fetch it only for the tasks
  // that are actually running, one `show` per running task. Bounded by how many profiles
  // can be running at once, never by the whole roster.
  const heartbeatByTaskId = {};
  let heartbeats_ok = true;
  for (const t of Object.values(runningByAssignee)) {
    const shown = hermes.run(['kanban', 'show', t.id, '--json']);
    if (!shown.ok) { heartbeats_ok = false; continue; }
    try {
      const parsed = JSON.parse(shown.out);
      const hbEvents = (parsed.events || []).filter((e) => e.kind === 'heartbeat');
      const latest = hbEvents.length ? hbEvents[hbEvents.length - 1] : null;
      heartbeatByTaskId[t.id] = latest ? latest.created_at : (t.started_at || null);
    } catch { heartbeats_ok = false; }
  }

  const toIso = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);

  const agents = parseProfileList(profileList.out).map((p) => {
    const task = runningByAssignee[p.name] || null;
    const lastDone = lastDoneByAssignee[p.name] || null;
    return {
      name: p.name,
      model: p.model,
      status: task ? 'running' : 'idle',
      currentTask: task ? { id: task.id, title: task.title, startedAt: toIso(task.started_at) } : null,
      lastHeartbeat: task ? toIso(heartbeatByTaskId[task.id]) : null,
      lastSeen: task ? toIso(heartbeatByTaskId[task.id]) : (lastDone ? toIso(lastDone.completed_at) : null),
      doneCount: doneCountByAssignee[p.name] || 0,
    };
  });

  res.json({
    agents,
    source: 'hermes-kanban',
    generatedAt: new Date().toISOString(),
    residue: {
      running_list_ok: running_ok,
      done_list_ok: done_ok,
      heartbeats_ok,
    },
  });
});

module.exports = router;
