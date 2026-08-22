//
// timeallocation.js — where the hours actually went, by agent and by project.
//
// The focus timer records real elapsed time against a backlog item, and each session
// carries the actor who ran it (by_whom) and the item it was pointed at (todo_id), which in
// turn carries a project. This route aggregates those rows into the answer a manager or
// owner asks: who spent how long on what, and what share of the whole that is.
//
// PROVENANCE IS PRESERVED. The sessions route (sessions.js) went to some length to keep
// agent hours out of the owner's streak; this route does the same by reporting `by_whom`
// as the agent field verbatim. An agent row is an agent row; it is never re-labelled 'you'.
//
// A TABLE THAT CANNOT BE READ IS SKIPPED, NOT FATAL — the same rule every panel follows.
// If focus_sessions has not migrated (or todo_items has no project column), the route
// returns an empty result with a note rather than a 500, so the panel can render the
// absence honestly instead of looking broken.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// LEFT JOIN todo_items so a session with no linked backlog item (a legacy or free-form
// timer run) still appears, with project = '(unassigned)'. An INNER JOIN would silently
// drop it, and dropping it would under-report total minutes — the worst direction for a
// time ledger.
const SESSIONS_SQL = `
  SELECT fs.duration_minutes AS minutes,
         fs.completed_at      AS completedAt,
         COALESCE(TRIM(ti.project), '(unassigned)') AS project,
         COALESCE(TRIM(fs.by_whom), 'unknown')       AS agent
    FROM focus_sessions fs
    LEFT JOIN todo_items ti ON ti.id = fs.todo_id
   WHERE fs.completed_at >= ?
   ORDER BY fs.completed_at DESC
`;

// A defensive accessor: older rows may predate the by_whom column (it was added by
// provenance migration v1 for focus_sessions). If the column does not exist the query
// throws and the route degrades to an empty result with a note.
function querySessions(sinceIso) {
  try {
    return db.prepare(SESSIONS_SQL).all(sinceIso);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // If the table or a column is missing, surface it as a note rather than crashing.
    throw new Error(`focus_sessions read failed: ${msg.slice(0, 200)}`);
  }
}

// --------------------------------------------------------------------------- route

router.get('/', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const notes = [];

  let rows = [];
  try {
    rows = querySessions(since);
  } catch (e) {
    notes.push({ source: 'focus_sessions', error: e.message });
  }

  // Per-row items, in the shape the contract asks for.
  const items = rows.map((r) => ({
    agent: r.agent,
    minutes: r.minutes,
    sessions: 1,
    project: r.project,
  }));

  // Aggregate by agent.
  const byAgentMap = new Map();
  // Aggregate by project.
  const byProjectMap = new Map();
  let total = 0;

  for (const r of rows) {
    total += r.minutes;

    const a = byAgentMap.get(r.agent);
    if (a) { a.minutes += r.minutes; a.sessions += 1; }
    else byAgentMap.set(r.agent, { agent: r.agent, minutes: r.minutes, sessions: 1 });

    const p = byProjectMap.get(r.project);
    if (p) { p.minutes += r.minutes; p.sessions += 1; }
    else byProjectMap.set(r.project, { project: r.project, minutes: r.minutes, sessions: 1 });
  }

  // Convert maps to arrays with percentage breakdown. Percentages are rounded to one
  // decimal and computed against the total — a total of 0 yields 0.0 for every entry,
  // which is honest (no time means no share) rather than NaN.
  function withPercent(arr, totalMinutes) {
    return arr
      .map((e) => ({
        ...e,
        percent: totalMinutes > 0 ? Math.round((e.minutes / totalMinutes) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  const byAgent = withPercent([...byAgentMap.values()], total);
  const byProject = withPercent([...byProjectMap.values()], total);

  res.json({
    items,
    total,
    byAgent,
    byProject,
    days,
    notes: notes.length ? notes : undefined,
  });
});

module.exports = router;