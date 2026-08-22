'use strict';
//
// goal-staleness.js — flags goals whose steps have not moved in 30+ days.
//
// GET /api/goal-staleness — returns { goals: [{ id, title, totalSteps,
//   doneSteps, daysSinceUpdate, status }], staleCount, slowingCount }
//
// "Stale" means no step on the goal has changed (done_on set, or any other
// movement) in 30+ days. "Slowing" means 7+ days. "Active" means < 7 days.
// The days-since-update is computed from the most recent step's done_on date;
// if no step has ever been completed, it falls back to the goal's created_at,
// because a goal that has never had a step ticked IS stale from the day it
// was created — reporting it as 0 days would hide the stall.
//
// The goals module owns the goals and goal_steps tables (see goals.js). This
// route only READS them; it never writes. If the tables are absent (goals
// module not yet migrated on a fresh database), we return empty rather than
// throw, so a panel that mounts before the goals module has been set up
// reports nothing rather than erroring — the same pattern as decisions.js.
const express = require('express');
const db = require('../db');

const router = express.Router();

// The goals module owns these tables. We check for their existence the same
// way decisions.js checks for team_decisions: a missing table is empty, not an
// error. An absent table and a failed read must never arrive at the panel
// looking identical — good news that is actually a broken parser is the one
// thing nobody investigates.
function goalsTableExists() {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='goals'"
  ).get();
  return !!row;
}

function goalStepsTableExists() {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='goal_steps'"
  ).get();
  return !!row;
}

// Whole days between two 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' strings. Both
// parsed as UTC midnight (the time portion is truncated) so the answer is an
// exact integer and no DST boundary can shift it by one. The goals module
// uses the same approach.
function daysBetween(fromStr, toStr) {
  const from = String(fromStr || '').slice(0, 10);
  const to = String(toStr || '').slice(0, 10);
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return null;
  return Math.round((t - f) / 86400000);
}

// Today's date in the same local-time clock the goals module's DEFAULTs use.
// `new Date().toISOString()` is UTC and would roll over an hour early here for
// part of the year.
function todayLocal() {
  return db.prepare("SELECT date('now', 'localtime') AS d").get().d;
}

// Compute the staleness status from days since last movement.
//   30+ days → 'stale'
//   7+ days  → 'slowing'
//   < 7 days → 'active'
function stalenessStatus(days) {
  if (days == null) return 'active';
  if (days >= 30) return 'stale';
  if (days >= 7) return 'slowing';
  return 'active';
}

// GET /api/goal-staleness — every goal with its step progress and staleness
// flag, sorted most stale first.
router.get('/', (req, res) => {
  // Tables absent → empty, not an error. Same contract as decisions.js.
  if (!goalsTableExists() || !goalStepsTableExists()) {
    return res.json({
      goals: [],
      staleCount: 0,
      slowingCount: 0,
      activeCount: 0,
      asOf: todayLocal(),
      state: 'empty',
    });
  }

  const asOf = todayLocal();

  let goalRows;
  try {
    goalRows = db.prepare(
      'SELECT id, title, created_at FROM goals ORDER BY created_at DESC'
    ).all();
  } catch (err) {
    return res.status(500).json({ failed: true, error: err.message });
  }

  // Empty is a state with a name, not a failed read.
  if (!goalRows.length) {
    return res.json({
      goals: [],
      staleCount: 0,
      slowingCount: 0,
      activeCount: 0,
      asOf,
      state: 'empty',
    });
  }

  const goals = [];
  let staleCount = 0;
  let slowingCount = 0;
  let activeCount = 0;

  for (const g of goalRows) {
    let stepRows;
    try {
      // done_on is the movement signal: it is set when a step is completed,
      // and cleared when a step is un-completed. Either is a movement. We
      // order by done_on DESC so the first non-null value is the most recent
      // movement. The task spec asks for updated_at but the actual schema has
      // no such column — done_on is the honest proxy for "last time a step
      // moved", and a goal whose steps have never been touched falls back to
      // created_at, which is the day the stall began.
      stepRows = db.prepare(
        'SELECT id, title, done_on FROM goal_steps WHERE goal_id = ? ORDER BY done_on DESC, id DESC'
      ).all(g.id);
    } catch (err) {
      return res.status(500).json({ failed: true, error: err.message });
    }

    const totalSteps = stepRows.length;
    // done_on IS NOT NULL means the step is completed. This is the same check
    // the goals module uses (see derive() in goals.js).
    const doneSteps = stepRows.filter((s) => s.done_on != null).length;

    // The most recent movement: the latest done_on date among all steps. If
    // no step has ever been completed, fall back to the goal's created_at — a
    // goal that was created 45 days ago and has never had a step ticked IS
    // 45 days stale, not 0.
    let lastMovement = null;
    if (stepRows.length > 0) {
      // done_on DESC means the first row with a non-null done_on is the most
      // recent movement. If all done_on are null (no steps completed yet),
      // lastMovement stays null and we fall back to created_at.
      for (const s of stepRows) {
        if (s.done_on != null) {
          lastMovement = s.done_on;
          break;
        }
      }
    }
    if (lastMovement == null) {
      lastMovement = g.created_at;
    }

    const daysSinceUpdate = daysBetween(lastMovement, asOf);
    const status = stalenessStatus(daysSinceUpdate);

    if (status === 'stale') staleCount += 1;
    else if (status === 'slowing') slowingCount += 1;
    else activeCount += 1;

    goals.push({
      id: g.id,
      title: g.title,
      totalSteps,
      doneSteps,
      daysSinceUpdate,
      status,
    });
  }

  // Sort by daysSinceUpdate descending — most stale first. Null (which should
  // not occur given the fallback above) sorts last.
  goals.sort((a, b) => {
    if (a.daysSinceUpdate == null && b.daysSinceUpdate == null) return a.id - b.id;
    if (a.daysSinceUpdate == null) return 1;
    if (b.daysSinceUpdate == null) return -1;
    return b.daysSinceUpdate - a.daysSinceUpdate;
  });

  res.json({
    goals,
    staleCount,
    slowingCount,
    activeCount,
    asOf,
    state: 'ok',
  });
});

module.exports = router;
