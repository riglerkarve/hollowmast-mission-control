'use strict';
//
// habit-tracker — derives which habits get dropped and when, not a streak counter.
// Backlog item: "Habit tracking that derives which habits get dropped and when,
// not a streak counter."
//
// GET / — reads lifestyle_chores and lifestyle_done (the same two tables the chores
// route owns) and computes, per chore: how many times done, last done date, days
// since last done, the longest gap between completions, and a status of fresh,
// active, or dropped.
//
// THE DISTINCTION FROM THE CHORES ROUTE.
//
//   The chores route answers "what is due next?" — a schedule derived from
//   last-done + interval. This route answers a different question: "which habits
//   are falling off?" — a pattern derived from the SPACING between completions,
//   not from an interval the user set. A streak counter would say "you did it 12
//   times in a row"; this says "the gap between your last two completions was 21
//   days, which is the widest gap you have ever had for this habit, and it has not
//   been done in 14 days." The number that matters is the GAP, not the run.
//
//   A habit is 'dropped' if it was done at least 3 times (enough for a pattern)
//   but has not been done in 14+ days. It is 'fresh' if done in the last 7 days.
//   It is 'active' if done in the last 14 days but not fresh. A habit done fewer
//   than 3 times has no pattern yet — it is reported with its counts but cannot
//   be 'dropped', because a habit you tried twice and stopped is a hypothesis, not
//   a lapsed habit.
//
//   Nothing here is scored, weighted, or advised on. Every figure is a COUNT or
//   a DIFFERENCE between dates the user wrote. The gap pattern is a measurement
//   of what already happened, not a prediction of what will.
const express = require('express');
const db = require('../db');

const router = express.Router();

// ONE CLOCK — same discipline as lifestyle.js. `new Date().toISOString()` is UTC
// and names the previous day during the first BST hour after local midnight, which
// would shift every daysSince by one. SQLite's localtime is the one clock this
// module reads.
const localToday = () => db.prepare("SELECT date('now','localtime') AS d").get().d;

// Both operands are 'YYYY-MM-DD', which Date.parse reads as UTC midnight, so the
// difference is an exact whole number of days with no DST term.
const dayDiff = (later, earlier) =>
  Math.round((Date.parse(later) - Date.parse(earlier)) / 86400000);

// DROPPED_THRESHOLD: 14 days since last completion AND at least 3 total completions.
// 3 is the minimum for a pattern — below that, a gap is just the space between two
// tries, not evidence of a habit that lapsed.
const DROPPED_DAYS = 14;
const FRESH_DAYS = 7;
const MIN_DONE_FOR_DROPPED = 3;

// Compute the longest gap (in days) between consecutive completions for one chore.
// Returns 0 if there are fewer than 2 completions (no gap to measure).
function longestGap(dates) {
  if (!dates || dates.length < 2) return 0;
  let max = 0;
  for (let i = 1; i < dates.length; i += 1) {
    const gap = dayDiff(dates[i], dates[i - 1]);
    if (gap > max) max = gap;
  }
  return max;
}

router.get('/', (req, res) => {
  try {
    const today = localToday();

    // Read all chores. We include inactive ones because a paused chore that was
    // dropped before it was paused is still part of the picture — pausing is a
    // scheduling decision, not an erasure of the pattern.
    const chores = db.prepare(
      'SELECT id, name, active FROM lifestyle_chores ORDER BY name'
    ).all();

    if (!chores.length) {
      // Empty and broken must not read the same. A 200 saying "there are none"
      // is a different sentence from a query that threw.
      return res.json({
        state: 'empty',
        today,
        habits: [],
        totalHabits: 0,
        droppedCount: 0,
        freshCount: 0,
        message: 'No chores recorded yet. Habits are derived from the chores '
          + 'you record in the lifestyle panel — add one and the pattern starts '
          + 'forming from the first time you mark it done.',
      });
    }

    // Read all completions, grouped by chore, ordered by date. We fetch
    // DISTINCT done_on per chore so a chore done twice on the same day counts as
    // one completion for gap purposes (the gap is between DAYS, not between acts).
    const doneRows = db.prepare(
      'SELECT DISTINCT chore_id, done_on FROM lifestyle_done ORDER BY chore_id, done_on'
    ).all();

    // Build a map: chore_id -> sorted array of unique done_on dates.
    const byChore = new Map();
    for (const r of doneRows) {
      if (!byChore.has(r.chore_id)) byChore.set(r.chore_id, []);
      byChore.get(r.chore_id).push(r.done_on);
    }

    const habits = chores.map((c) => {
      const dates = byChore.get(c.id) || [];
      const timesDone = dates.length;
      const lastDone = timesDone ? dates[dates.length - 1] : null;
      const daysSinceLast = lastDone ? dayDiff(today, lastDone) : null;
      const gap = longestGap(dates);

      // Status derivation — the whole point of this route.
      //
      // dropped: done >= 3 times AND not done in 14+ days. The 3-time floor means
      //   a habit you tried twice and abandoned is NOT "dropped" — it is a habit
      //   that never formed, which is a different and less alarming fact.
      // fresh:  done in the last 7 days.
      // active: done in the last 14 days but not fresh (7–13 days ago).
      //
      // A habit with fewer than 3 completions is never 'dropped', regardless of
      // how long ago the last one was. It gets 'fresh' or 'active' based on
      // recency, or 'dormant' if it has been a while but never had enough
      // completions to call it lapsed.
      let status;
      if (timesDone === 0) {
        status = 'fresh'; // never done = no pattern, treated as neutral
      } else if (daysSinceLast !== null && daysSinceLast >= DROPPED_DAYS) {
        status = timesDone >= MIN_DONE_FOR_DROPPED ? 'dropped' : 'dormant';
      } else if (daysSinceLast !== null && daysSinceLast < FRESH_DAYS) {
        status = 'fresh';
      } else {
        status = 'active';
      }

      return {
        name: c.name,
        timesDone,
        lastDone,
        daysSinceLast,
        longestGap: gap,
        status,
      };
    });

    // Sort: dropped first, then active, then fresh, then dormant.
    // Within each group, sort by daysSinceLast descending (longest gap first).
    const STATUS_ORDER = { dropped: 0, active: 1, fresh: 2, dormant: 3 };
    habits.sort((a, b) => {
      const orderDiff = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      if (orderDiff !== 0) return orderDiff;
      // Within the same status, the one with the most days since last done comes
      // first — the one closest to being dropped (or the one dropped longest ago).
      const aDays = a.daysSinceLast ?? -1;
      const bDays = b.daysSinceLast ?? -1;
      if (aDays !== bDays) return bDays - aDays;
      return a.name.localeCompare(b.name);
    });

    const droppedCount = habits.filter((h) => h.status === 'dropped').length;
    const freshCount = habits.filter((h) => h.status === 'fresh').length;
    const activeCount = habits.filter((h) => h.status === 'active').length;

    res.json({
      state: 'ok',
      today,
      thresholds: {
        droppedDays: DROPPED_DAYS,
        freshDays: FRESH_DAYS,
        minDoneForDropped: MIN_DONE_FOR_DROPPED,
      },
      derived: 'timesDone, lastDone, daysSinceLast, longestGap and status are '
        + 'computed from lifestyle_done on every request. Nothing about the '
        + 'pattern is stored — it is arithmetic on dates you recorded.',
      habits,
      totalHabits: habits.length,
      droppedCount,
      freshCount,
      activeCount,
    });
  } catch (err) {
    // A failure to look is not an empty list. Report it as an error state so the
    // panel can distinguish "no data" from "could not read".
    res.status(500).json({
      state: 'error',
      error: err.message,
      habits: [],
      totalHabits: 0,
      droppedCount: 0,
      freshCount: 0,
    });
  }
});

module.exports = router;