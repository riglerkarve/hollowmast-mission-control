const express = require('express');
const db = require('../db');
const provenance = require('../provenance');
const finance = require('./finance');

// ------------------------------------------------------------------------------------
// LIFESTYLE. Two capture surfaces for the same day: household chores, and whether the
// one-proper-meal floor was met. One module rather than two because both are answered in
// the same ten seconds, and a second panel to visit is a second panel you stop visiting.
//
// THE CHORE HALF — the schedule is DERIVED, never stored.
//
//   You record one thing only: "did it", with a date. Nothing in this module holds a list
//   of what is outstanding, because a checklist you maintain is a chore with a nice font
//   and the workspace gate rejects it. What is due is arithmetic on (last done + interval)
//   every time it is asked for, so it cannot go stale and there is nothing to tick off.
//
//   'never done' is its own state and is never folded into 'due' or 'ok'. A chore with no
//   history has no last-done date to count from — that is ABSENCE, and absence must not
//   look like the failure state or the fine state. It is reported with a reason attached.
//
// THE INTAKE HALF — read this before changing a word of it.
//
//   The constraints the wellbeing module works under apply here too, and they are not
//   style preferences:
//
//     - Nothing is scored, weighted, ranked, streaked, trended or interpreted. Every
//       figure below is a COUNT of rows you wrote yourself.
//     - No nudge, no encouragement, no reaction to a bad week, and nothing that reads as
//       advice about the user's body or eating.
//
//   AMENDED 18 Aug 2026, BY THE OWNER, OPENLY. This block used to also say "no calorie
//   judgement". They asked for a meal tracker with nutrition lookup, were shown that it
//   collided with this rule, were offered a narrower per-item-facts-only version, and
//   chose totals and targets. A feature request does not overturn a rule quietly; the rule
//   is changed in the open, attributed, or it is not changed at all.
//
//   WHAT THE AMENDMENT DOES AND DOES NOT PERMIT — the distinction is the whole safeguard:
//     - Nutrition figures are LOOKED UP and attributed to a source and a date. Never
//       estimated, never inferred from a similar item.
//     - Totals are ARITHMETIC OVER ROWS YOU WROTE. Adding up what you logged is not a
//       judgement; it is a sum you could do yourself.
//     - A target is YOURS. This module does not choose one, does not suggest one, and does
//       not defend one — exactly as FLOOR_MEALS already works. There is no default. An
//       unset target means no comparison is shown at all.
//     - STILL FORBIDDEN, and not up for amendment: reacting to being over or under. No
//       nudge, no colour that means "bad", no streak, no trend, no "you are doing well".
//       The comparison is displayed and never commented on.
//     - A day with no record is still "not recorded", never a day of zero calories.
//     - The local model never touches this module. Not for tagging, not for prose.
//     - A day with NO RECORD is "not recorded". It is never counted as a day below the
//       floor. Nothing here knows what happened on a day that was not written down, and
//       inferring a miss from silence would be inventing data about someone's eating.
//
//   `floorMeals` is 1 because that is the user's own stated goal, stored as a number so
//   the comparison is checkable. This module did not choose it and does not defend it.
// ------------------------------------------------------------------------------------

db.migrate('lifestyle', [
  (d) => {
    d.exec(`
      CREATE TABLE lifestyle_chores (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        interval_days INTEGER NOT NULL,      -- how often you want it done. The ONLY input
                                             -- to the schedule other than the last-done date.
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE lifestyle_done (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chore_id    INTEGER NOT NULL REFERENCES lifestyle_chores(id) ON DELETE CASCADE,
        done_on     TEXT NOT NULL,           -- ISO date it was done, not when it was typed
        recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX idx_lf_done_chore ON lifestyle_done(chore_id, done_on);

      CREATE TABLE lifestyle_intake (
        date        TEXT PRIMARY KEY,        -- one row per day; upserted, never appended
        meals       INTEGER NOT NULL,
        note        TEXT,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);

    // A starter set, so the first render is a working thing rather than an empty form.
    // Seeding is not the same as making you maintain a list: every row here is editable,
    // pausable and deletable, and nothing re-adds them.
    const ins = d.prepare('INSERT INTO lifestyle_chores (name, interval_days) VALUES (?, ?)');
    [
      ['Laundry', 7],
      ['Bins out', 7],
      ['Change bedding', 14],
      ['Clean bathroom', 7],
      ['Hoover', 7],
    ].forEach(([name, every]) => ins.run(name, every));
  },

  // 2 — anchored chores. See nextAnchored() for why an interval alone is the wrong model
  // for anything the outside world schedules.
  (d) => {
    d.exec(`
      ALTER TABLE lifestyle_chores ADD COLUMN anchor_date TEXT;              -- a real, known occurrence
      ALTER TABLE lifestyle_chores ADD COLUMN lead_days INTEGER NOT NULL DEFAULT 0;
    `);
  },

  // Provenance. Default 'unknown' rather than 'you' — see server/provenance.js.
  (d) => {
    provenance.addColumn(d, 'lifestyle_done');
    provenance.addColumn(d, 'lifestyle_intake');
  },

  // v4 — the meal tracker. Owner's request, 18 Aug 2026. See the amended header above for
  // what was permitted and what stays forbidden.
  //
  // TWO TABLES, NOT ONE, and the split is the design. `lifestyle_foods` is a cache of
  // figures published by SOMEONE ELSE — it carries where each number came from and when it
  // was fetched, so a value can always be traced back or re-checked. `lifestyle_meals` is
  // what you ate. Merging them would mean a corrected product figure silently rewriting
  // history, and a meal you logged in August would change because a database was edited in
  // October.
  (d) => {
    d.exec(`
      CREATE TABLE lifestyle_foods (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        brand        TEXT,
        barcode      TEXT,
        serving      TEXT,                    -- '1 scoop (50g)' as the source words it
        kcal         REAL,                    -- per serving. NULL means NOT FOUND, never zero.
        protein_g    REAL,
        carbs_g      REAL,
        fat_g        REAL,
        fibre_g      REAL,
        source       TEXT NOT NULL,           -- 'openfoodfacts' | 'manufacturer' | 'you'
        source_ref   TEXT,                    -- URL or product code the figures came from
        fetched_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        by_whom      TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE INDEX idx_lf_foods_name ON lifestyle_foods(name);
      CREATE UNIQUE INDEX idx_lf_foods_barcode ON lifestyle_foods(barcode);

      CREATE TABLE lifestyle_meals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT NOT NULL,
        food_id     INTEGER REFERENCES lifestyle_foods(id) ON DELETE SET NULL,
        label       TEXT NOT NULL,            -- what you called it, kept even if food_id is null
        servings    REAL NOT NULL DEFAULT 1,
        note        TEXT,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        by_whom     TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE INDEX idx_lf_meals_date ON lifestyle_meals(date);

      -- Targets. One row per nutrient, and the table starts EMPTY on purpose: an unset
      -- target shows no comparison at all. This module does not choose a target, does not
      -- suggest one, and does not defend one — the same contract FLOOR_MEALS already has.
      CREATE TABLE lifestyle_targets (
        nutrient   TEXT PRIMARY KEY,          -- 'kcal' | 'protein_g' | ...
        amount     REAL NOT NULL,
        set_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        set_by     TEXT NOT NULL DEFAULT 'you'
      );
    `);
  },
  // v5 — a third scheduling kind. #M9.
  //
  // interval   due = last done + N days.        Right for laundry.
  // anchored   due = a known date + N days.     Right for the bins; recording it does not move it.
  // month_end  due = the last day of the month. Right for "consolidate the accounts monthly".
  //
  // month_end is not expressible as an interval and is not expressible as an anchor either.
  // 30 days from a month end drifts to the 30th, 29th, 28th and never realigns, because
  // months are 28-31 days. See nextMonthEnd() for the measured drift.
  //
  // BACKFILLED FROM WHAT EACH ROW ALREADY IS, so nothing changes behaviour on migration: a
  // chore with an anchor_date was already anchored, everything else was already an interval.
  (d) => {
    d.exec(`ALTER TABLE lifestyle_chores ADD COLUMN schedule_kind TEXT;`);
    d.exec(`UPDATE lifestyle_chores SET schedule_kind = CASE
              WHEN anchor_date IS NOT NULL THEN 'anchored' ELSE 'interval' END;`);
  },
]);

const router = express.Router();

// The boundary between 'soon' and 'ok'. It is a GROUPING for the panel, not a weight and
// not a score: `dueInDays` is returned raw on every chore, and this number is returned
// alongside it as `soonWithinDays`, so any grouping decision can be checked by hand.
const SOON_WITHIN_DAYS = 2;

// ANCHORED CHORES — the ones the outside world schedules, not you.
//
// The default model is due = last done + interval, which is right for laundry: the clock
// starts when you last did it. It is WRONG for a council bin collection, and wrong in a way
// that gets worse rather than erroring. Put the bins out on Friday because you missed
// Thursday, and an interval model schedules the next one 14 days from Friday — so it
// desynchronises from the actual collection and stays wrong, quietly, forever.
//
// An anchored chore therefore derives its next date from the CALENDAR: a known real
// collection date, plus whole multiples of the interval, regardless of when it was last
// recorded. Recording "did it" still records that you did it; it just cannot move a
// schedule that was never yours to move.
//
// lead_days exists because the useful moment is not the collection, it is the night
// before: bins go out on Wednesday evening for a Thursday morning round.
function nextAnchored(anchorDate, intervalDays, today) {
  const step = Math.max(1, intervalDays);
  const diff = Math.round((Date.parse(today) - Date.parse(anchorDate)) / 86400000);
  if (diff <= 0) return anchorDate;
  return addDays(anchorDate, Math.ceil(diff / step) * step);
}

// MONTH-END IS A CALENDAR RULE, NOT AN INTERVAL, and that is why anchoring cannot express
// it. Anchoring fixed fortnightly-Thursday because 14 days is a true period. Months are
// 28–31 days, so the nearest interval — 30 — drifts and never realigns. Measured before
// building this, from an anchor of 2026-08-31:
//
//     2026-08-31  month end        2026-11-29  should be the 30th
//     2026-09-30  month end        2026-12-29  should be the 31st
//     2026-10-30  should be 31st   2027-01-28  should be the 31st
//
// Correct for two months, then wrong forever and getting worse. Same failure anchor_date
// was added to fix for the bins, one level up: a schedule the world owns cannot be derived
// from a number of days.
//
// Returns the last day of THIS month if it has not passed, else the last day of next.
// Day 0 of month n+1 is the last day of month n, which is how the length of February
// stays something the calendar knows and this function does not.
function lastDayOfMonth(y, m) {           // m is 0-based
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
}

function nextMonthEnd(today) {
  const t = new Date(`${today}T00:00:00Z`);
  const end = lastDayOfMonth(t.getUTCFullYear(), t.getUTCMonth());
  if (end >= today) return end;
  return lastDayOfMonth(t.getUTCFullYear(), t.getUTCMonth() + 1);
}

// The user's stated floor: one proper meal a day. Stored as a number, disclosed in every
// intake response, and never turned into a percentage or a grade.
const FLOOR_MEALS = 1;

// The median gap is only shown once there are this many gaps to take a median OF. Below
// it the answer is null WITH A REASON — a "typical gap" off one or two observations is a
// forecast from thin data dressed as a measurement.
const MIN_GAPS_FOR_TYPICAL = 3;

// ONE CLOCK. Every date in this module comes from SQLite's localtime, including "today".
// `new Date().toISOString()` is UTC: during BST it names the previous day for the first
// hour after local midnight, which would silently shift every daysSince by one.
const localToday = () => db.prepare("SELECT date('now','localtime') AS d").get().d;

const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Both operands are 'YYYY-MM-DD', which Date.parse reads as UTC midnight, so the
// difference is an exact whole number of days with no DST term.
const dayDiff = (later, earlier) => Math.round((Date.parse(later) - Date.parse(earlier)) / 86400000);
const addDays = (date, n) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------- chores
// Everything derived about a chore is derived HERE, once, from these two columns plus the
// done table. No panel recomputes it and nothing stores the result.
const CHORE_SQL = `
  SELECT
    c.id, c.name, c.interval_days, c.active, c.created_at,
    c.anchor_date, c.lead_days, c.schedule_kind,
    MAX(d.done_on)                  AS last_done,
    COUNT(DISTINCT d.done_on)       AS days_recorded,
    CAST(julianday(date('now','localtime')) - julianday(MAX(d.done_on)) AS INTEGER) AS days_since
  FROM lifestyle_chores c
  LEFT JOIN lifestyle_done d ON d.chore_id = c.id
  GROUP BY c.id
`;

// Median gap between consecutive recorded days, per chore. This is the one thing the
// module tells you that you did not type: how often a chore ACTUALLY comes round, against
// the interval you set for it. Median rather than mean, for the same reason the budget
// uses one — a single eight-week gap should not redefine "typical".
function typicalGaps() {
  const rows = db.prepare('SELECT DISTINCT chore_id, done_on FROM lifestyle_done ORDER BY chore_id, done_on').all();
  const byChore = new Map();
  for (const r of rows) {
    if (!byChore.has(r.chore_id)) byChore.set(r.chore_id, []);
    byChore.get(r.chore_id).push(r.done_on);
  }

  const out = new Map();
  for (const [choreId, dates] of byChore) {
    const gaps = [];
    for (let i = 1; i < dates.length; i += 1) gaps.push(dayDiff(dates[i], dates[i - 1]));
    if (gaps.length < MIN_GAPS_FOR_TYPICAL) {
      // Not "no data" — not ENOUGH data, and the difference is stated rather than left as
      // a blank the reader has to interpret.
      out.set(choreId, {
        medianDays: null,
        gapsCounted: gaps.length,
        note: `Needs ${MIN_GAPS_FOR_TYPICAL + 1} recorded days to have ${MIN_GAPS_FOR_TYPICAL} gaps to take a median of; there are ${dates.length}.`,
      });
      continue;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out.set(choreId, {
      medianDays: sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
      gapsCounted: gaps.length,
      note: null,
    });
  }
  return out;
}

function decorate(r, gaps) {
  const base = {
    id: r.id,
    name: r.name,
    scheduleKind: 'interval',
    intervalDays: r.interval_days,
    active: !!r.active,
    addedOn: String(r.created_at).slice(0, 10),
    daysRecorded: r.days_recorded,
    lastDone: r.last_done,
  };

  if (!r.days_recorded) {
    // ABSENCE. Distinct from both 'due' and 'ok', carries nulls rather than a fabricated
    // zero, and says why it is null. A chore added today and a chore ignored for a year
    // look identical from the done table alone, so `daysSinceAdded` is given as the one
    // real fact available — as a fact, not as a stand-in due date.
    return {
      ...base,
      daysSinceDone: null,
      dueInDays: null,
      overdueByDays: null,
      nextDueOn: null,
      state: 'never done',
      why: 'No "did it" has ever been recorded, so there is no date to count an interval from. '
        + 'This is not the same as "not due" — nothing here knows when it was last done.',
      daysSinceAdded: dayDiff(localToday(), base.addedOn),
      typical: gaps.get(r.id) || { medianDays: null, gapsCounted: 0, note: 'Nothing recorded yet.' },
    };
  }

  const dueIn = r.interval_days - r.days_since;
  return {
    ...base,
    daysSinceDone: r.days_since,
    dueInDays: dueIn,                                  // negative = overdue
    overdueByDays: dueIn < 0 ? -dueIn : 0,
    nextDueOn: addDays(r.last_done, r.interval_days),
    state: dueIn <= 0 ? 'due' : (dueIn <= SOON_WITHIN_DAYS ? 'soon' : 'ok'),
    why: null,
    typical: gaps.get(r.id) || { medianDays: null, gapsCounted: 0, note: 'Nothing recorded yet.' },
  };
}

// An anchored chore is decorated entirely from the calendar. It never reaches the
// last-done branches above, and it has NO 'never done' state: a bin collection happens
// whether or not you have ever recorded putting the bins out, so "no history" is not
// absence of a schedule here — it is only absence of a record.
function decorateAnchored(r, gaps) {
  const today = localToday();
  const nextOn = nextAnchored(r.anchor_date, r.interval_days, today);
  const daysUntil = dayDiff(nextOn, today);
  const lead = Math.max(0, r.lead_days || 0);

  return {
    id: r.id,
    name: r.name,
    intervalDays: r.interval_days,
    active: !!r.active,
    addedOn: String(r.created_at).slice(0, 10),
    daysRecorded: r.days_recorded,
    lastDone: r.last_done,
    daysSinceDone: r.days_since,

    scheduleKind: 'anchored',
    anchored: true,
    anchorDate: r.anchor_date,
    leadDays: lead,
    nextDueOn: nextOn,
    daysUntilNext: daysUntil,

    // dueInDays counts to the ACTION, not to the collection: with a lead of 1, the bins
    // are "due" the day before. Kept on the same field name so the briefing, the trigger
    // and the sort do not need to know which kind of chore this is.
    dueInDays: daysUntil - lead,
    overdueByDays: 0,
    state: daysUntil - lead <= 0 ? 'due' : (daysUntil - lead <= SOON_WITHIN_DAYS ? 'soon' : 'ok'),
    why: `Fixed schedule, not an interval since you last did it: every ${r.interval_days} days `
      + `from ${r.anchor_date}${lead ? `, and it is flagged ${lead} day${lead === 1 ? '' : 's'} ahead` : ''}. `
      + 'Recording it does not move the next date, because the collection is not yours to move.',
    typical: gaps.get(r.id) || { medianDays: null, gapsCounted: 0, note: 'Nothing recorded yet.' },
  };
}

// A month-end chore. Due on the last day of the month, every month, regardless of when
// you last did it — the calendar owns this date the way the council owns bin day.
//
// lead_days works the same as for anchored chores: with a lead of 2, a month-end task tips
// to due on the 29th of a 31-day month. dueInDays counts to the ACTION, not to the date, so
// nothing downstream needs to know which kind of chore this is.
function decorateMonthEnd(r, gaps) {
  const today = localToday();
  const nextOn = nextMonthEnd(today);
  const daysUntil = dayDiff(nextOn, today);
  const lead = Math.max(0, r.lead_days || 0);

  return {
    id: r.id,
    name: r.name,
    intervalDays: r.interval_days,
    active: !!r.active,
    addedOn: String(r.created_at).slice(0, 10),
    daysRecorded: r.days_recorded,
    lastDone: r.last_done,
    daysSinceDone: r.days_since,

    scheduleKind: 'month_end',
    anchored: true,               // in the sense that matters: recording it does not move it
    leadDays: lead,
    nextDueOn: nextOn,
    daysUntilNext: daysUntil,

    dueInDays: daysUntil - lead,
    overdueByDays: 0,
    state: daysUntil - lead <= 0 ? 'due' : (daysUntil - lead <= SOON_WITHIN_DAYS ? 'soon' : 'ok'),
    why: 'The last day of every month. Not an interval since you last did it, and not a '
      + 'fixed number of days from an anchor — 30 days from a month end drifts to the 30th, '
      + 'then the 29th, and never comes back. Recording it does not move the next date.'
      + (lead ? ` Flagged ${lead} day${lead === 1 ? '' : 's'} ahead.` : ''),
    typical: gaps.get(r.id) || { medianDays: null, gapsCounted: 0, note: 'Nothing recorded yet.' },
  };
}

function allChores() {
  const gaps = typicalGaps();
  return db.prepare(CHORE_SQL).all()
    .map((r) => {
      // Dispatch on the declared kind, falling back to the old inference for any row a
      // migration has not reached. Three kinds, one dueInDays: the briefing, the trigger
      // and the sort never learn which is which.
      const kind = r.schedule_kind || (r.anchor_date ? 'anchored' : 'interval');
      if (kind === 'month_end') return decorateMonthEnd(r, gaps);
      if (kind === 'anchored' && r.anchor_date) return decorateAnchored(r, gaps);
      return decorate(r, gaps);
    });
}

const STATE_ORDER = { due: 0, 'never done': 1, soon: 2, ok: 3 };
const byUrgency = (a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state])
  || ((b.overdueByDays || 0) - (a.overdueByDays || 0))
  || ((a.dueInDays ?? 1e9) - (b.dueInDays ?? 1e9))
  || a.name.localeCompare(b.name);

router.get('/chores', (req, res) => {
  const chores = allChores().sort(byUrgency);
  if (!chores.length) {
    // Empty and broken must not read the same. This is a 200 saying "there are none",
    // which is a different sentence from a fetch that threw.
    return res.json({ state: 'empty', today: localToday(), chores: [], message: 'No chores. Add one and the schedule starts working from the first time you record it.' });
  }
  res.json({
    state: 'ok',
    today: localToday(),
    soonWithinDays: SOON_WITHIN_DAYS,
    derived: 'daysSinceDone, dueInDays, nextDueOn and state are computed from last-done + interval on every request. Nothing about the schedule is stored.',
    chores,
  });
});

router.post('/chores', (req, res) => {
  const { name, intervalDays } = req.body || {};
  const n = String(name || '').trim();
  const every = Number(intervalDays);
  if (!n) return res.status(400).json({ error: 'name is required' });
  if (!Number.isInteger(every) || every < 1 || every > 365) {
    return res.status(400).json({ error: 'intervalDays must be a whole number of days between 1 and 365' });
  }

  const info = db.prepare('INSERT INTO lifestyle_chores (name, interval_days) VALUES (?, ?)').run(n, every);
  res.status(201).json({
    id: Number(info.lastInsertRowid),
    name: n,
    intervalDays: every,
    state: 'never done',
    note: 'Added. It will stay "never done" until the first time you record it — the interval counts from a real date, not from today.',
  });
});

// Not in the original endpoint list, but `active` is otherwise a write-once column: this
// is how a chore gets paused without deleting its history. Reported as an addition.
router.put('/chores/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM lifestyle_chores WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'no such chore' });

  const { name, intervalDays, active, scheduleKind, leadDays } = req.body || {};
  const n = name === undefined ? row.name : String(name || '').trim();
  const every = intervalDays === undefined ? row.interval_days : Number(intervalDays);
  const act = active === undefined ? row.active : (active ? 1 : 0);

  if (!n) return res.status(400).json({ error: 'name cannot be empty' });
  if (!Number.isInteger(every) || every < 1 || every > 365) {
    return res.status(400).json({ error: 'intervalDays must be a whole number of days between 1 and 365' });
  }

  // The scheduling kind, #M9. Set separately from the interval because for a month_end
  // chore the interval is meaningless — the calendar decides, not a number of days.
  if (scheduleKind !== undefined) {
    const KINDS = ['interval', 'anchored', 'month_end'];
    if (!KINDS.includes(scheduleKind)) {
      return res.status(400).json({ error: `scheduleKind must be one of ${KINDS.join(', ')}` });
    }
    // Refused rather than silently accepted: an anchored chore with no anchor would fall
    // back to interval behaviour and look like it had been set, which is the worst outcome.
    if (scheduleKind === 'anchored' && !row.anchor_date) {
      return res.status(400).json({ error: 'anchored needs an anchor_date — set one first, or use month_end' });
    }
    db.prepare('UPDATE lifestyle_chores SET schedule_kind = ? WHERE id = ?').run(scheduleKind, id);
  }
  if (leadDays !== undefined) {
    const lead = Number(leadDays);
    if (!Number.isInteger(lead) || lead < 0 || lead > 28) {
      return res.status(400).json({ error: 'leadDays must be a whole number between 0 and 28' });
    }
    db.prepare('UPDATE lifestyle_chores SET lead_days = ? WHERE id = ?').run(lead, id);
  }

  db.prepare('UPDATE lifestyle_chores SET name = ?, interval_days = ?, active = ? WHERE id = ?').run(n, every, act, id);
  const gaps = typicalGaps();
  const fresh = db.prepare(`${CHORE_SQL} HAVING c.id = ?`).get(id);
  res.json(decorate(fresh, gaps));
});

router.delete('/chores/:id', (req, res) => {
  const id = Number(req.params.id);
  // Counted BEFORE the delete, because the cascade makes it uncountable afterwards and
  // "deleted" should not quietly mean "deleted, plus two years of history".
  const history = db.prepare('SELECT COUNT(*) c FROM lifestyle_done WHERE chore_id = ?').get(id).c;
  const r = db.prepare('DELETE FROM lifestyle_chores WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'no such chore' });
  res.json({
    deleted: id,
    deletedHistoryRows: history,
    note: history ? `${history} recorded day${history === 1 ? '' : 's'} went with it — that is what ON DELETE CASCADE does here.` : undefined,
  });
});

// The only write the chore half ever takes: "did it".
router.post('/chores/:id/done', (req, res) => {
  const id = Number(req.params.id);
  const chore = db.prepare('SELECT * FROM lifestyle_chores WHERE id = ?').get(id);
  if (!chore) return res.status(404).json({ error: 'no such chore' });

  const today = localToday();
  const when = isISODate(req.body && req.body.date) ? req.body.date : today;
  if (when > today) {
    // A future date makes daysSince negative and every derived figure nonsense. Refuse it
    // rather than deriving from it.
    return res.status(400).json({ error: `cannot record a chore as done on ${when} — that is in the future (today is ${today})` });
  }

  const already = db.prepare('SELECT id FROM lifestyle_done WHERE chore_id = ? AND done_on = ?').get(id, when);
  if (!already) db.prepare('INSERT INTO lifestyle_done (chore_id, done_on, by_whom) VALUES (?, ?, ?)').run(id, when, req.by);

  const gaps = typicalGaps();
  const fresh = decorate(db.prepare(`${CHORE_SQL} HAVING c.id = ?`).get(id), gaps);

  // The capture returns a value immediately, as the gate requires — and the value is the
  // derived one, so recording is also how you find out when it next comes round.
  res.status(201).json({
    ...fresh,
    recordedOn: when,
    // Said out loud rather than silently no-oping: a second press on the same day is not
    // an error, and it is not a second recording either.
    duplicate: !!already,
    duplicateNote: already ? `Already recorded for ${when}; nothing was added.` : undefined,
  });
});

// ---------------------------------------------------------------------------- intake
// Counts only. Read the block at the top of this file before adding anything here: if a
// figure cannot be checked by counting rows by hand, it does not belong in this module.
function intakeWindow(days) {
  const today = localToday();
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) dates.push(addDays(today, -i));

  const rows = new Map(
    db.prepare('SELECT * FROM lifestyle_intake WHERE date >= ? AND date <= ? ORDER BY date').all(dates[0], today)
      .map((r) => [r.date, r])
  );

  // THREE states per day, never two. "recorded, below the floor" and "no record at all"
  // are different facts, and collapsing them would turn every day you did not write down
  // into a day you are told you fell short of something.
  const series = dates.map((date) => {
    const r = rows.get(date);
    if (!r) return { date, recorded: false, meals: null, atOrAboveFloor: null, note: null };
    return { date, recorded: true, meals: r.meals, atOrAboveFloor: r.meals >= FLOOR_MEALS, note: r.note };
  });

  const recorded = series.filter((s) => s.recorded);
  return {
    days,
    from: dates[0],
    to: today,
    floorMeals: FLOOR_MEALS,
    series,
    counts: {
      daysInWindow: days,
      daysRecorded: recorded.length,
      daysAtOrAboveFloor: recorded.filter((s) => s.atOrAboveFloor).length,
      daysBelowFloor: recorded.filter((s) => !s.atOrAboveFloor).length,
      daysNotRecorded: days - recorded.length,
    },
    todayRecorded: series[series.length - 1].recorded,
    note: 'Counts of what you wrote down. A day with no record is counted as "not recorded" and never as a day below the floor.',
  };
}

// WHAT FOOD ACTUALLY COSTS — backlog #23, reduced to the half that can be answered.
//
// The item asked for "suggested meals from finance and health data, add to basket". Three
// things stop that being built as written, and none of them is effort:
//
//   1. A BANK EXPORT CANNOT SEE A BASKET. The reference field on a Groceries row is the
//      merchant again — "SAINSBURYS LOC4825", "DESIRE SUPERMARKET LTD" — never the items.
//      The ledger knows where and how much, never what. Suggesting meals "from finance
//      data" would mean inventing the ingredients and calling them yours.
//   2. HEALTH-DRIVEN MEAL SUGGESTION IS BARRED HERE, by this module's own header: no
//      calorie judgement, nothing that reads as advice about the user's body or eating.
//      That rule was written deliberately and a feature request does not overturn it.
//   3. "Add to basket" ends at a proposal regardless. Nothing here places an order.
//
// What IS answerable is the money, which is what the item ties to: your own grocery
// spending, per day, so "one proper meal a day" has a real cost attached instead of a
// guess. It rates no food, recommends no food, and never looks at a health metric.
function foodCost(months = 12) {
  // Asked of finance rather than read from its tables — the module contract, and it is
  // finance that owns what a Groceries row means.
  const rows = finance.categoryMonthly('Groceries', months);

  if (!rows.length) return { state: 'no-data', note: 'No grocery spending in the window.' };

  // Median month, not mean — one big shop should not set the baseline.
  // finance.categoryMonthly returns { month, pence, n } and already sorts by pence, so the
  // middle row IS the median. Reading `.total` here silently produced £0.00 while the
  // accessor itself reported £82.79 — the field was renamed when this moved behind the
  // module boundary, and undefined/30.44 is 0 rather than an error.
  const mid = rows[Math.floor(rows.length / 2)];
  const perDay = Math.round(mid.pence / 30.44);

  return {
    state: 'ok',
    monthsCounted: rows.length,
    medianMonthPence: mid.pence,
    medianShopsPerMonth: mid.n,
    perDayPence: perDay,
    basis: `Median of ${rows.length} months of the Groceries category, divided by 30.44 days. `
      + 'It is what you spent on food, not what a meal costs — the ledger cannot see a basket, '
      + 'only a total and a merchant.',
    refuses: 'No meal is suggested, rated or costed individually, and no health metric is '
      + 'consulted. This module does not give advice about eating.',
  };
}

router.get('/intake', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const total = db.prepare('SELECT COUNT(*) c FROM lifestyle_intake').get().c;
  const w = intakeWindow(days);
  // Empty and broken must not read the same, here as everywhere else.
  res.json({ state: total ? 'ok' : 'empty', totalDaysEverRecorded: total, food: foodCost(), ...w });
});

router.post('/intake', (req, res) => {
  const { date, meals, note } = req.body || {};
  const today = localToday();
  const d = isISODate(date) ? date : today;
  if (d > today) return res.status(400).json({ error: `cannot record ${d} — that is in the future (today is ${today})` });

  const m = Number(meals);
  if (!Number.isInteger(m) || m < 0 || m > 20) {
    return res.status(400).json({ error: 'meals must be a whole number between 0 and 20' });
  }

  db.prepare(
    `INSERT INTO lifestyle_intake (date, meals, note) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET meals = excluded.meals, note = excluded.note,
       recorded_at = datetime('now','localtime')`
  ).run(d, m, String(note || '').trim() || null);

  // What comes back is RECALL — counts of rows already in the table, over the last seven
  // days. Not a verdict on the day, not a streak, and no sentence about how it is going.
  const last7 = intakeWindow(7).counts;
  res.status(201).json({
    date: d,
    meals: m,
    floorMeals: FLOOR_MEALS,
    atOrAboveFloor: m >= FLOOR_MEALS,
    recall: {
      daysRecordedInLast7: last7.daysRecorded,
      daysAtOrAboveFloorInLast7: last7.daysAtOrAboveFloor,
      daysBelowFloorInLast7: last7.daysBelowFloor,
      daysNotRecordedInLast7: last7.daysNotRecorded,
    },
  });
});

// ---------------------------------------------------------------------------- overview
router.get('/', (req, res) => {
  const today = localToday();
  const all = allChores();
  const active = all.filter((c) => c.active).sort(byUrgency);
  const paused = all.filter((c) => !c.active);
  const intake = intakeWindow(14);
  const totalIntakeRows = db.prepare('SELECT COUNT(*) c FROM lifestyle_intake').get().c;

  const grouped = {
    due: active.filter((c) => c.state === 'due'),
    neverDone: active.filter((c) => c.state === 'never done'),
    soon: active.filter((c) => c.state === 'soon'),
    ok: active.filter((c) => c.state === 'ok'),
  };

  res.json({
    // 'no-chores' is a real answer with a message. A failed request is an HTTP error. The
    // panel must be able to tell them apart without guessing.
    state: all.length ? 'ok' : 'no-chores',
    message: all.length ? undefined : 'No chores. Add one and the schedule starts working from the first time you record it.',
    today,
    soonWithinDays: SOON_WITHIN_DAYS,
    chores: grouped,
    counts: {
      total: all.length,
      active: active.length,
      // The filter reports its residue: paused chores are excluded from every group above,
      // so the count of what was dropped is returned with them.
      paused: paused.length,
      due: grouped.due.length,
      neverDone: grouped.neverDone.length,
      soon: grouped.soon.length,
      ok: grouped.ok.length,
    },
    paused,
    intake: { ...intake, state: totalIntakeRows ? 'ok' : 'empty', totalDaysEverRecorded: totalIntakeRows },
    derived: 'Chore states are computed from last-done + interval at request time and are never stored. '
      + '"never done" means no recording exists, which is not the same as "not due".',
  });
});

// NOTE: the catch-all 404 handler that used to sit here has MOVED TO THE BOTTOM of this
// file. It matched everything, so every route added after it was unreachable — the meal
// tracker's endpoints answered "no such lifestyle endpoint" while being perfectly well
// defined. Third occurrence of this shape in the project. Anything added later goes ABOVE
// the handler at the end, never below it.

// Asked for by the briefing. Counts of recorded rows only — never a state, never a
// judgement about whether the week was good.
function activitySince(sinceDate) {
  const chores = db.prepare('SELECT COUNT(*) c FROM lifestyle_done WHERE done_on >= ?').get(sinceDate).c;
  const intake = db.prepare('SELECT COUNT(*) c FROM lifestyle_intake WHERE date >= ?').get(sinceDate).c;
  return { choresRecorded: chores, intakeDaysRecorded: intake };
}

// What is due, published for the briefing and the daily triggers so neither has to read
// lifestyle_chores itself. It reuses allChores(), so the figures are the same ones the
// panel shows — a second derivation here would be a second owner for the same schedule.
//
// THE SPLIT MATTERS, and it is why chores can be both a notification and a briefing line
// without becoming nagging:
//
//   tippedToday  — dueInDays === 0, the single day a chore crosses its interval. An
//                  EVENT. Notifying on this needs no "last notified" state and cannot
//                  repeat, because a chore is only ever 0 days due once per cycle.
//   due          — dueInDays <= 0, everything currently owed including what was missed.
//                  A STANDING STATE. Right for the briefing, wrong for a phone buzz: it
//                  would fire every morning until you did it, which is how an alert
//                  teaches you to ignore the channel.
//
// neverDone is carried separately and is never folded into either. A chore with no history
// has no date to count from, so calling it "due" would be inventing one.
function dueSummary() {
  const all = allChores();
  const due = all.filter((c) => c.state === 'due');
  return {
    today: localToday(),
    due,
    tippedToday: due.filter((c) => c.dueInDays === 0),
    overdue: due.filter((c) => c.dueInDays < 0),
    soon: all.filter((c) => c.state === 'soon'),
    neverDone: all.filter((c) => c.state === 'never done'),
    total: all.length,
  };
}

// ---------------------------------------------------------------------------------------
// THE MEAL TRACKER — #M12. Read the amended header at the top of this file first.
//
// NULL IS NOT ZERO, and every query below is written around that. A food whose figures
// could not be found stores NULL kcal, and a total over meals containing one of those is
// reported as INCOMPLETE with the unknown items named. Summing NULL as 0 would produce a
// total that looks like a measurement and is a guess — the exact failure this project has
// been bitten by more than once.
const NUTRIENTS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fibre_g'];

// Open Food Facts: free, open, no key. Coverage is community-maintained, so a miss is
// expected and is reported rather than filled in.
const OFF = 'https://world.openfoodfacts.org/api/v2';

// TWO ENDPOINTS, AND THE REASON IS A TRAP WORTH RECORDING.
//
// The v2 /search endpoint IGNORES search_terms. It answers HTTP 200 with a perfectly
// well-formed product list — and `count: 4688963`, which is the entire database. It is
// paginating everything and filtering nothing. Searching "huel black edition" returned
// Fromage Blanc Nature, Sidi Ali and Perly: three real products, none of them related to
// the query, with no error anywhere to suggest the search had not happened.
//
// The legacy /cgi/search.pl DOES filter — the same query returns count 70 and the actual
// Huel products. So barcode lookups use v2 (which works) and text search uses the CGI
// endpoint (which is the one that searches).
//
// The count is checked below as a guard: a result set the size of the whole database is
// not a search result, and reporting it as one would be confidently wrong.
const OFF_SEARCH = 'https://world.openfoodfacts.org/cgi/search.pl';
const UNFILTERED_COUNT = 1000000;   // no real query matches a million products

async function lookupFood(query) {
  const isBarcode = /^\d{8,14}$/.test(String(query).trim());
  const url = isBarcode
    ? `${OFF}/product/${encodeURIComponent(query)}?fields=code,product_name,brands,serving_size,nutriments`
    : `${OFF_SEARCH}?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=5`
      + '&fields=code,product_name,brands,serving_size,nutriments';

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'MissionControl/1.0 (personal dashboard; single user)' },
    });
    clearTimeout(t);
    if (!res.ok) return { state: 'error', why: `Open Food Facts returned ${res.status}` };
    const body = await res.json();

    // The guard against a search that did not search. If the backend reports a match count
    // the size of the whole database, it filtered nothing, and its "results" are simply the
    // first page of everything. That is worse than an error because it looks like an answer.
    if (!isBarcode && typeof body.count === 'number' && body.count > UNFILTERED_COUNT) {
      return {
        state: 'error',
        why: `the search returned ${body.count.toLocaleString('en-GB')} matches — it did not filter on the query`,
      };
    }

    const products = isBarcode
      ? (body.product ? [body.product] : [])
      : (body.products || []);
    if (!products.length) return { state: 'not_found' };

    // Per SERVING where the source gives it, per 100g otherwise — and which one is said
    // out loud, because the two are different numbers for the same food.
    return {
      state: 'found',
      matches: products.slice(0, 5).map((p) => {
        const n = p.nutriments || {};
        const per = n['energy-kcal_serving'] != null ? 'serving' : '100g';
        const g = (k) => {
          const v = per === 'serving' ? n[`${k}_serving`] : n[`${k}_100g`];
          return typeof v === 'number' ? v : null;
        };
        return {
          barcode: p.code || null,
          name: p.product_name || '(unnamed product)',
          brand: p.brands || null,
          serving: per === 'serving' ? (p.serving_size || 'one serving') : 'per 100g',
          basis: per,
          kcal: g('energy-kcal'),
          protein_g: g('proteins'),
          carbs_g: g('carbohydrates'),
          fat_g: g('fat'),
          fibre_g: g('fiber'),
          source: 'openfoodfacts',
          source_ref: p.code ? `https://world.openfoodfacts.org/product/${p.code}` : null,
        };
      }),
    };
  } catch (err) {
    clearTimeout(t);
    // Could-not-look, never not-found. A timeout is a fact about the network.
    return { state: 'error', why: err.name === 'AbortError' ? 'no answer in 15s' : err.message.slice(0, 90) };
  }
}

router.get('/foods/lookup', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const r = await lookupFood(q);
  res.json({
    query: q,
    ...r,
    note: r.state === 'not_found'
      ? 'Open Food Facts does not have this. You can still log the meal — it will be recorded with no nutrition attached, and you can type the figures from the packet later.'
      : r.state === 'error'
        ? 'Could not reach the database. That is a failure to look, NOT a statement that this food has no nutrition.'
        : undefined,
  });
});

// Save a food — either one the lookup returned, or figures typed off a packet.
router.post('/foods', express.json(), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const source = ['openfoodfacts', 'manufacturer', 'you'].includes(b.source) ? b.source : 'you';

  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const vals = NUTRIENTS.map((k) => {
    const v = num(b[k]);
    return Number.isFinite(v) ? v : null;   // NULL, never 0
  });

  const info = db.prepare(
    `INSERT INTO lifestyle_foods (name, brand, barcode, serving, kcal, protein_g, carbs_g, fat_g, fibre_g, source, source_ref, by_whom)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(barcode) DO UPDATE SET
       name = excluded.name, kcal = excluded.kcal, protein_g = excluded.protein_g,
       carbs_g = excluded.carbs_g, fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
       source = excluded.source, source_ref = excluded.source_ref,
       fetched_at = datetime('now','localtime')`
  ).run(
    name, b.brand || null, b.barcode || null, b.serving || null,
    ...vals, source, b.source_ref || null, req.by
  );

  res.status(201).json({ id: Number(info.lastInsertRowid), name, source });
});

router.post('/meals', express.json(), (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label is required — what did you eat?' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : new Date().toLocaleDateString('en-CA');
  const servings = Number(b.servings);

  let foodId = null;
  if (b.foodId != null) {
    const f = db.prepare('SELECT id FROM lifestyle_foods WHERE id = ?').get(Number(b.foodId));
    if (!f) return res.status(400).json({ error: `no food ${b.foodId}` });
    foodId = f.id;
  }

  const info = db.prepare(
    'INSERT INTO lifestyle_meals (date, food_id, label, servings, note, by_whom) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(date, foodId, label, Number.isFinite(servings) && servings > 0 ? servings : 1, b.note || null, req.by);

  res.status(201).json({
    id: Number(info.lastInsertRowid), date, label, foodId,
    // Logging without nutrition is a first-class outcome, not a degraded one.
    nutrition: foodId ? 'attached' : 'none attached — the meal is recorded either way',
  });
});

router.delete('/meals/:id', (req, res) => {
  const r = db.prepare('DELETE FROM lifestyle_meals WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such meal' });
  res.json({ deleted: Number(req.params.id) });
});

// Targets. Setting one is the owner's act; there is no default and no suggestion.
router.get('/targets', (req, res) => {
  res.json({
    targets: db.prepare('SELECT * FROM lifestyle_targets').all(),
    nutrients: NUTRIENTS,
    note: 'Empty by design. Nothing here proposes a target — with none set, no comparison '
      + 'is shown at all.',
  });
});

router.put('/targets/:nutrient', express.json(), (req, res) => {
  const n = String(req.params.nutrient);
  if (!NUTRIENTS.includes(n)) return res.status(400).json({ error: `nutrient must be one of ${NUTRIENTS.join(', ')}` });
  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  db.prepare(
    `INSERT INTO lifestyle_targets (nutrient, amount, set_by) VALUES (?, ?, 'you')
     ON CONFLICT(nutrient) DO UPDATE SET amount = excluded.amount, set_at = datetime('now','localtime')`
  ).run(n, amount);
  res.json({ nutrient: n, amount });
});

router.delete('/targets/:nutrient', (req, res) => {
  db.prepare('DELETE FROM lifestyle_targets WHERE nutrient = ?').run(String(req.params.nutrient));
  res.json({ cleared: req.params.nutrient });
});

// A day's meals, with totals that refuse to lie about what they could not count.
router.get('/meals', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
    ? req.query.date : new Date().toLocaleDateString('en-CA');

  const meals = db.prepare(`
    SELECT m.id, m.label, m.servings, m.note, m.by_whom,
           f.id AS foodId, f.name AS foodName, f.brand, f.serving, f.source, f.source_ref, f.fetched_at,
           f.kcal, f.protein_g, f.carbs_g, f.fat_g, f.fibre_g
      FROM lifestyle_meals m
      LEFT JOIN lifestyle_foods f ON f.id = m.food_id
     WHERE m.date = ? ORDER BY m.id
  `).all(date);

  const targets = Object.fromEntries(
    db.prepare('SELECT nutrient, amount FROM lifestyle_targets').all().map((t) => [t.nutrient, t.amount])
  );

  // Totals are arithmetic over rows YOU wrote. Anything with an unknown value is excluded
  // from the sum AND named, so the number is never quietly short.
  const totals = {};
  const incomplete = {};
  for (const n of NUTRIENTS) {
    let sum = 0; const missing = [];
    for (const m of meals) {
      if (!m.foodId || m[n] === null || m[n] === undefined) { missing.push(m.label); continue; }
      sum += m[n] * m.servings;
    }
    totals[n] = meals.length ? Math.round(sum * 10) / 10 : null;
    if (missing.length) incomplete[n] = missing;
  }

  res.json({
    date,
    meals,
    totals,
    targets,
    // Named separately from the totals so a partial sum can never be read as a full one.
    incomplete,
    complete: Object.keys(incomplete).length === 0,
    caveat: Object.keys(incomplete).length
      ? 'These totals EXCLUDE the items listed under "incomplete" — their figures are not '
        + 'known. The real amount is higher by an unknown margin, so do not read a total '
        + 'below a target as a shortfall.'
      : meals.length
        ? 'Every logged item had figures, so these totals cover everything you recorded today.'
        : 'Nothing recorded for this day. That is not a day of zero — it is a day with no record.',
    // Stated so a reader knows the totals are theirs, not a verdict.
    contract: 'Totals are a sum of what you logged. Targets are yours and were not '
      + 'suggested by this system. Nothing here reacts to being over or under.',
  });
});

// --- the catch-all, LAST -----------------------------------------------------------
// Express 4 wildcard — a bare '*', with the matched remainder in req.params[0].
// (Express 5's '/*splat' form throws on this version.) It exists so a mistyped endpoint
// answers with a named failure in JSON, instead of falling through to the static handler
// and returning an HTML 404 that a panel would read as a parse error of unknown origin.
//
// IT MUST STAY THE LAST ROUTE IN THIS FILE. It matches everything, so anything registered
// below it is dead. The meal tracker was written above it, worked perfectly, and answered
// 404 on every endpoint until this was moved down here.
router.all('*', (req, res) => {
  const attempted = req.params[0] ? `/${String(req.params[0]).replace(/^\/+/, '')}` : req.path;
  res.status(404).json({
    error: `no such lifestyle endpoint: ${req.method} ${attempted}`,
    endpoints: [
      'GET    /               what is due, what is coming, and 14 days of intake',
      'GET    /chores         every chore with its computed due state',
      'POST   /chores         { name, intervalDays }',
      'PUT    /chores/:id     { name?, intervalDays?, active? }',
      'DELETE /chores/:id',
      'POST   /chores/:id/done  { date? }',
      'GET    /intake?days=N',
      'POST   /intake         { date?, meals, note? }',
      'GET    /foods/lookup?q=  search Open Food Facts by name or barcode',
      'POST   /foods          save a food, from the lookup or typed off the packet',
      'GET    /meals?date=    a day\'s meals, with totals that name what they could not count',
      'POST   /meals          { label, date?, foodId?, servings?, note? }',
      'DELETE /meals/:id',
      'GET    /targets        yours; empty by default, and nothing here suggests one',
      'PUT    /targets/:nutrient    { amount }',
      'DELETE /targets/:nutrient',
    ],
  });
});

module.exports = router;
module.exports.activitySince = activitySince;
module.exports.dueSummary = dueSummary;
