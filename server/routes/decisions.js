//
// decisions.js — the owner's own decision log (M149) and the decisions whose
// revisit_when date has arrived (M146).
//
// The team module already owns four kinds of decision and renders them per shift through
// GET /api/team/report. THIS ROUTE IS THE OWNER'S OWN VIEW: every decision across all shifts,
// ordered by when it was made, and the subset whose dated recheck has arrived surfaced on
// top. The per-shift view answers "what was decided this shift"; this one answers "what have
// I decided, and which of those should I look at again now".
//
// NOTHING HERE IS DERIVED TWICE. The calendar-date check for recheck_at is the same logic as
// team.js's dueDecisions(): a free-text `revisit_when` condition is deliberately not turned
// into a calendar alert just because it contains the word "when". Only a real ISO calendar
// date is eligible. The owner's own steering answers are returned too, because a steering
// answer IS the owner's decision and a log of his decisions that omits them is not one.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// The team_decisions table is owned by the team module, which created it in its own
// migration. We read it here; we never write to it. If the table is absent (team module
// not yet migrated on a fresh database), we return empty rather than throw, so a panel
// that mounts before the team has been set up reports nothing rather than erroring.
function decisionsTableExists() {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='team_decisions'"
  ).get();
  return !!row;
}

function steeringTableExists() {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='team_steering'"
  ).get();
  return !!row;
}

// A free-text revisit condition and a date are deliberately separate fields (see team.js).
// A condition such as "when the next review fails" cannot honestly become a calendar alert
// just because it contains the word "when". Only a real ISO calendar date is eligible for
// the automatic due list; the undated remainder stays in the log and is not surfaced as due.
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

// Map a team_decisions row to the panel's shape. The route owns the field names so the panel
// does not reach into the database's own column names; the panel asks for text, because,
// costIfWrong, decidedBy, decidedAt, revisitWhen, status, and this is where those come from.
function shapeDecision(row, supersededIds) {
  const recheckAt = row.recheck_at == null ? '' : String(row.recheck_at).trim();
  const revisitable = recheckAt && isCalendarDate(recheckAt)
    ? { due: null, recheckAt }
    : { due: false, recheckAt: recheckAt || null };
  return {
    id: row.id,
    text: row.decision,
    because: row.because,
    costIfWrong: row.cost_if_wrong || null,
    decidedBy: row.decided_by,
    decidedAt: row.at,
    revisitWhen: row.revisit_when || null,
    recheckAt: recheckAt || null,
    role: row.role || null,
    shift: row.shift || null,
    evidence: row.evidence || null,
    supersedes: row.supersedes || null,
    superseded: supersededIds.has(row.id),
    status: supersededIds.has(row.id) ? 'superseded' : 'active',
    due: revisitable.due,
  };
}

// The owner's steering answers are his decisions too. They live on team_steering, not
// team_decisions, and a log of the owner's decisions that omits them would be the same
// gap team.js's migration #3 was written to close. Returned in the same list, shaped to
// match, so the panel renders them as the same kind of card.
function shapeSteeringAnswer(row) {
  return {
    id: `steering:${row.id}`,
    text: row.question,
    because: row.recommend || null,
    costIfWrong: null,
    decidedBy: row.by_whom || 'owner',
    decidedAt: row.answered_at,
    revisitWhen: null,
    recheckAt: null,
    role: 'owner',
    shift: row.shift || null,
    evidence: null,
    supersedes: null,
    superseded: false,
    status: 'answered',
    due: false,
    isSteering: true,
    answer: row.answer,
  };
}

// The set of decision ids that a later decision supersedes. Precomputed once so each row
// is shaped in O(1) rather than running a subquery per decision.
function supersededIds() {
  const rows = db.prepare('SELECT DISTINCT supersedes FROM team_decisions WHERE supersedes IS NOT NULL').all();
  return new Set(rows.map((r) => r.supersedes));
}

function asOfToday() {
  return db.prepare("SELECT date('now', 'localtime') AS day").get().day;
}

// Mark which decisions are due for revisit. done AFTER shaping so the asOf comparison runs
// once, against the normalised recheckAt, rather than inside the shape function where the
// calendar check would run even for rows with no date.
function markDue(decisions, asOf) {
  const revisitable = [];
  for (const d of decisions) {
    if (d.recheckAt && isCalendarDate(d.recheckAt) && d.recheckAt <= asOf && !d.superseded) {
      d.due = true;
      revisitable.push(d);
    } else {
      d.due = false;
    }
  }
  return revisitable;
}

// GET /api/decisions — every decision across all shifts, newest first, plus the owner's
// steering answers, plus the subset whose dated recheck has arrived.
router.get('/', (req, res) => {
  const asOf = asOfToday();
  const decisions = [];
  const superseded = supersededIds();

  if (decisionsTableExists()) {
    const rows = db.prepare(
      'SELECT * FROM team_decisions ORDER BY at DESC LIMIT 50'
    ).all();
    for (const row of rows) decisions.push(shapeDecision(row, superseded));
  }

  if (steeringTableExists()) {
    const answered = db.prepare(
      'SELECT * FROM team_steering WHERE answer IS NOT NULL ORDER BY answered_at DESC LIMIT 50'
    ).all();
    for (const row of answered) decisions.push(shapeSteeringAnswer(row));
  }

  // Chronological: newest first. Steering answers and team_decisions share the same list and
  // sort by their own decidedAt, so the owner's answers interleave with the team's calls in
  // the order they actually happened.
  decisions.sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));

  const revisitable = markDue(decisions, asOf);

  res.json({ decisions, revisitable, asOf });
});

// GET /api/decisions/:id — one decision with full detail. Accepts a numeric team_decisions
// id or a `steering:<id>` reference (the same shape returned in the list, so the panel can
// link from a card to its own detail without a second lookup convention).
router.get('/:id', (req, res) => {
  const id = req.params.id;
  const asOf = asOfToday();
  const superseded = supersededIds();

  if (id.startsWith('steering:')) {
    const sid = Number(id.slice('steering:'.length));
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'bad steering id' });
    if (!steeringTableExists()) return res.status(404).json({ error: 'no such decision' });
    const row = db.prepare('SELECT * FROM team_steering WHERE id = ?').get(sid);
    if (!row || !row.answer) return res.status(404).json({ error: 'no such decision' });
    return res.json({ decision: shapeSteeringAnswer(row) });
  }

  const did = Number(id);
  if (!Number.isFinite(did)) return res.status(400).json({ error: 'bad decision id' });
  if (!decisionsTableExists()) return res.status(404).json({ error: 'no such decision' });

  const row = db.prepare('SELECT * FROM team_decisions WHERE id = ?').get(did);
  if (!row) return res.status(404).json({ error: 'no such decision' });

  const decision = shapeDecision(row, superseded);
  if (decision.recheckAt && isCalendarDate(decision.recheckAt) && decision.recheckAt <= asOf && !decision.superseded) {
    decision.due = true;
  }

  // The decision this one supersedes and any that supersede it, so the detail view can show
  // the line of reasoning rather than just one point on it. Each is shaped to the same
  // contract as the main decision.
  const supersedesRow = decision.supersedes
    ? db.prepare('SELECT * FROM team_decisions WHERE id = ?').get(decision.supersedes)
    : null;
  const supersededBy = db.prepare('SELECT * FROM team_decisions WHERE supersedes = ? ORDER BY at').all(did);

  res.json({
    decision,
    supersedes: supersedesRow ? shapeDecision(supersedesRow, superseded) : null,
    supersededBy: supersededBy.map((r) => shapeDecision(r, superseded)),
  });
});

module.exports = router;
