const express = require('express');
const db = require('../db');

// GOALS — the multi-step admin that stalls.
//
// Every one of these is the same shape: a thing you genuinely want, five or six steps of
// paperwork between you and it, and no obvious place to start. The reason they sit in the
// backlog for months is not that they are hard. It is that "renew passport" is not an
// action — it is a name for four actions, and you have to reconstruct which one is next
// every single time you look at it.
//
// So this module owns two tables and answers one question per goal: WHAT DO I DO NEXT.
// That sentence is derived on every read from the steps and their blockers. It is never
// stored, so it cannot go stale, and there is nothing here to keep up to date.
//
// What it derives, which is the whole reason it is not a list you maintain:
//   - the next action: lowest-position step that is neither done nor blocked
//   - blocked vs actionable: whether the FIRST unfinished step is waiting on something
//   - cost to finish, ALWAYS reported with the count of unpriced steps beside it
//   - steps done / steps total, as counts
//   - days to a target date, where you have set one
//
// What it deliberately does NOT do:
//   - It does not know what you can afford. That figure belongs to the budget module and
//     asking two modules the same question is how they end up disagreeing.
//   - It does not rank goals. There is no priority score here, because a score built from
//     weights I chose is the one number on the page nobody can audit. The sort is a date
//     comparison and it says so in the response.
//   - It does not invent a cost, a fee, a processing time or a legal requirement. Not one
//     seeded step carries a number. An unpriced step reads "cost not set", which is the
//     honest state — a plausible passport fee shown as a real cost is worse than a blank,
//     because you would plan against it.

// ---------------------------------------------------------------------------- seed
// The five goals from the backlog. EVERY cost_pence here is NULL and that is deliberate:
// I have not verified a single fee, quote or price, so there is nothing to write. Where I
// know roughly what the shape of a cost is, it goes in `note` as prose you can correct —
// never in the money column, where it would be summed and treated as fact.
//
// Steps are phrased as actions with a source attached ("check on GOV.UK", "ring two
// schools") rather than as statements of what the rules are. The rules are theirs to
// state. Mine is to get you to the point of asking.
const SEED = [
  {
    title: 'CBT or driving licence',
    why: 'Backlog #46. Independent transport. The fork — CBT and a motorcycle, or a full '
      + 'car licence — has never actually been decided, and that is why nothing after it '
      + 'has happened.',
    steps: [
      {
        title: 'Decide the route: CBT and a motorcycle, or a full car licence',
        note: 'This is the fork, and it is the whole reason this goal has not moved. Every '
          + 'step below reads differently depending on the answer. Nothing here has a view '
          + 'on which one is right for you.',
      },
      {
        title: 'Confirm the provisional licence is in hand and current',
        blocked_by: 'provisional licence replacement — see that goal',
        note: 'Marked blocked because I do not know whether you are holding it. If it is '
          + 'already in your wallet, clear the block and this becomes a tick. That is the '
          + 'honest state of an unknown prerequisite: blocked until checked, not assumed.',
      },
      {
        title: 'Ring two local schools or instructors and write the actual quotes into the cost field',
        note: 'Cost left blank on purpose. Prices vary by area and by school and I have '
          + 'verified none of them, so any figure I put here would be invented. Two real '
          + 'quotes beat one confident number.',
      },
      {
        title: 'Book the first session and put the date in the target field',
      },
    ],
  },
  {
    title: 'Passport renewal',
    why: 'Backlog #47. Nothing abroad can be booked until this is done — the dental trip '
      + 'is waiting on it.',
    steps: [
      {
        title: 'Find the current passport and write its expiry date in the note',
        note: 'The expiry date is what decides how urgent the rest of this is. Nothing here '
          + 'assumes it, because a guessed expiry date is a guessed deadline.',
      },
      {
        title: 'Read the current renewal route and fee on GOV.UK and put the fee in the cost field',
        note: 'Cost deliberately not set. Fees change and I have not checked the current '
          + 'one. GOV.UK is the only source worth copying a number from.',
      },
      {
        title: 'Get a digital photo that meets the rules the service states',
      },
      {
        title: 'Complete and submit the renewal application',
      },
      {
        title: 'Record the date you submitted it, and whatever the service says about timing',
        note: 'Processing time is not stated here on purpose. Whatever the service tells '
          + 'you on the day is the only figure worth writing down, and it is the one the '
          + 'dental trip has to be planned around.',
      },
    ],
  },
  {
    title: 'Provisional licence replacement',
    why: 'Backlog #48. Small, entirely admin, and it sits underneath the CBT/driving goal '
      + '— which makes it the cheapest thing on this list to clear.',
    steps: [
      {
        title: 'Establish what actually happened to it: lost, stolen, damaged, or expired',
        note: 'Genuinely step one, because the replacement route differs by case and there '
          + 'is no point reading about the wrong one.',
      },
      {
        title: 'Check the DVLA replacement route and the current fee, and put the fee in the cost field',
        note: 'Cost not set: no figure here has been verified by me, and a wrong fee in a '
          + 'total is worse than a gap in one.',
      },
      {
        title: 'Gather whatever details the application asks you for',
      },
      {
        title: 'Submit the replacement application',
      },
      {
        title: 'Record the date it arrives, then clear the block on the CBT goal',
      },
    ],
  },
  {
    title: 'Dental work abroad',
    why: 'Backlog #63. This is a cost and a checklist and nothing else. Nothing in this '
      + 'module has, or should be read as having, any opinion about dental treatment — '
      + 'your dentist and the clinic are the only sources for what work is appropriate.',
    steps: [
      {
        title: 'Write down, in your own words, what work you are pricing',
        note: 'Just the description you would give a clinic so it can quote. This module '
          + 'holds it as text and does nothing else with it.',
      },
      {
        title: 'Shortlist clinics and write the shortlist in the note',
      },
      {
        title: 'Get a written quote from each shortlisted clinic and put the figure in the cost field',
        note: 'Cost not set. A written quote is the only real number in this goal; anything '
          + 'I put in this field would be fiction dressed as a budget.',
      },
      {
        title: 'Price flights and accommodation for the number of visits the clinic quotes',
        note: 'Two unknowns at once — how many visits comes from the clinic, and travel '
          + 'prices come from the day you look. Both belong in the cost field once real.',
      },
      {
        title: 'Book the travel dates',
        blocked_by: 'passport — see the passport renewal goal',
        note: 'Blocked on purpose, and it is the one genuine cross-goal dependency here. '
          + 'Clear it the day the passport is back.',
      },
      {
        title: 'Book the treatment',
      },
    ],
  },
  {
    title: 'Research a 1-bed rented flat',
    why: 'Backlog #25. Research only — nothing in this goal commits you to moving. No '
      + 'figure in it is an affordability judgement either; that number lives in the '
      + 'budget module and this one does not get a second copy of it.',
    steps: [
      {
        title: 'Decide the area, or the two or three areas, you would actually live in',
      },
      {
        title: 'Collect ten real listings and write down what each one actually asks per month',
        note: 'Ten real numbers you have seen, not one average someone quoted. An average '
          + 'rent is a statistic; a listing is a thing you can apply for.',
      },
      {
        title: 'Write down the up-front cost each listing states, and put the typical one in the cost field',
        note: 'Cost not set here because it varies per listing and per agent. The listings '
          + 'are the source — copy from them, do not estimate.',
      },
      {
        title: 'Ask two agents what income evidence they want from a sole trader',
        note: 'Phrased as a question rather than an assumption. What is required is theirs '
          + 'to state, and guessing it is how you prepare the wrong paperwork.',
      },
      {
        title: 'Decide whether this is a this-year thing, and set a target date if it is',
        note: 'No target date is seeded on any goal in this module. An invented deadline '
          + 'produces an invented urgency, and the panel would then count down to it.',
      },
    ],
  },
];

db.migrate('goals', [
  (d) => {
    d.exec(`
      CREATE TABLE goals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        why         TEXT,                  -- why it is worth doing, in your words
        target_date TEXT,                  -- 'YYYY-MM-DD', NULL unless YOU set one
        -- 'active' | 'done' | 'parked' | 'abandoned'. Parked and abandoned are different
        -- on purpose: one is "not now", the other is "never", and collapsing them loses
        -- the only record of a decision you made.
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE goal_steps (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        position   INTEGER NOT NULL,       -- order within the goal; ties break by id
        title      TEXT NOT NULL,
        -- INTEGER PENCE. Never a float, and the unit is in the column name so a value
        -- cannot be misread. NULL means "not known", which is a different thing from 0 and
        -- is reported differently everywhere it is used.
        cost_pence INTEGER,
        blocked_by TEXT,                   -- free text; non-empty means this step cannot start
        done_on    TEXT,                   -- 'YYYY-MM-DD'; NULL means not done
        note       TEXT
      );

      CREATE INDEX idx_goal_steps_goal ON goal_steps(goal_id, position);
    `);

    // Seeded inside the migration, so it happens exactly once and inside the same
    // transaction as the tables. A re-run cannot duplicate it.
    const insGoal = d.prepare('INSERT INTO goals (title, why) VALUES (?, ?)');
    const insStep = d.prepare(
      'INSERT INTO goal_steps (goal_id, position, title, cost_pence, blocked_by, note) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const g of SEED) {
      const goalId = Number(insGoal.run(g.title, g.why).lastInsertRowid);
      g.steps.forEach((s, i) => {
        // cost_pence is NULL for every seeded row. See the comment above SEED.
        insStep.run(goalId, i + 1, s.title, null, s.blocked_by || null, s.note || null);
      });
    }
  },
]);

// ---------------------------------------------------------------------------- helpers
const GOAL_STATUSES = ['active', 'done', 'parked', 'abandoned'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Local date, taken from the same clock the DEFAULTs use. `new Date().toISOString()` is
// UTC and would roll over an hour early here for part of the year.
const today = () => db.prepare("SELECT date('now', 'localtime') AS d").get().d;

// Whole days between two 'YYYY-MM-DD' strings. Both parsed as UTC midnight so the answer
// is an exact integer and no DST boundary can shift it by one.
const daysBetween = (fromISO, toISO) =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);

const blocked = (step) => !!(step.blocked_by && String(step.blocked_by).trim());
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const stepsFor = (goalId) =>
  db.prepare('SELECT * FROM goal_steps WHERE goal_id = ? ORDER BY position, id').all(goalId);

// Handlers are wrapped so a thrown query answers 500 with the message, not an empty body.
// An empty table and a failed read must never arrive at the panel looking identical —
// good news that is actually a broken parser is the one thing nobody investigates.
const safe = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(500).json({ failed: true, error: err.message });
  }
};

// Pounds in, integer pence out. '' / null / undefined all mean "clear it", which is how a
// cost gets back to "not set" once you realise the number you typed was a guess.
function toPence(value) {
  if (value === undefined || value === null || value === '') return { ok: true, pence: null };
  const pence = Math.round(Number(value) * 100);
  if (!Number.isFinite(pence) || pence < 0) return { ok: false };
  return { ok: true, pence };
}

// ---------------------------------------------------------------------------- derivation
// THE WHOLE POINT OF THE MODULE. Nothing below is stored; it is all recomputed from the
// steps on every read, so it cannot describe a state the data left behind.
function derive(goal, steps) {
  const remaining = steps.filter((s) => !s.done_on);
  const doneCount = steps.length - remaining.length;

  // Two different questions, and conflating them is what makes a list unreadable:
  //   firstRemaining — the step that is nominally next. If IT is blocked, the goal is
  //                    blocked, because that is what you would hit if you sat down to it.
  //   nextAction     — the first step you could actually start today, which may be a
  //                    later one that happens not to be waiting on anything.
  const firstRemaining = remaining[0] || null;
  const nextAction = remaining.find((s) => !blocked(s)) || null;
  const isBlocked = !!firstRemaining && blocked(firstRemaining);

  // One sentence answering "what do I actually do next". Composed here rather than in the
  // panel so there is exactly one wording and one owner of it.
  let sentence;
  if (!steps.length) {
    sentence = 'No steps yet. Break this into steps and the next action appears here on its own.';
  } else if (!firstRemaining) {
    sentence = 'Every step is done. Marking the goal itself done is your call — nothing here decides that for you.';
  } else if (!nextAction) {
    sentence = `Nothing here is actionable: every remaining step is waiting on something. `
      + `Step ${firstRemaining.position} is waiting on ${firstRemaining.blocked_by}.`;
  } else if (isBlocked) {
    sentence = `Step ${firstRemaining.position} is waiting on ${firstRemaining.blocked_by}, so the next thing `
      + `you can actually do is step ${nextAction.position}: ${nextAction.title}`;
  } else {
    sentence = `Do this next — step ${nextAction.position} of ${steps.length}: ${nextAction.title}`;
  }

  // COST TO FINISH, and the number that stops it being read as a total. Reporting the sum
  // alone would quietly present a partial figure as a complete one, which is the same
  // failure as a filter that does not report its residue.
  const priced = remaining.filter((s) => s.cost_pence !== null && s.cost_pence !== undefined);
  const costUnknownSteps = remaining.length - priced.length;
  // null, not 0, when nothing is priced. £0.00 reads as free; "not known" reads as not known.
  const costToFinishPence = priced.length ? priced.reduce((sum, s) => sum + s.cost_pence, 0) : null;

  let costBasis;
  // "Nothing left to pay for" and "nothing to pay for yet" are different states and must
  // not share a sentence: a goal with no steps would otherwise read as one that is finished.
  if (!steps.length) costBasis = 'No steps yet, so there is nothing to cost.';
  else if (!remaining.length) costBasis = 'Nothing left to pay for on this one.';
  else if (!priced.length) costBasis = `No cost is set on any of the ${remaining.length} remaining steps, so there is no total to show.`;
  else if (costUnknownSteps) costBasis = `Sum of ${priced.length} priced step${priced.length === 1 ? '' : 's'}. `
    + `${costUnknownSteps} remaining step${costUnknownSteps === 1 ? ' has' : 's have'} no cost set, so this is a floor, not the total.`;
  else costBasis = `Every remaining step has a cost set, so this is the whole of it.`;

  // Days to target. Only ever computed from a date YOU set; nothing seeds one.
  let daysToTarget = null;
  let targetState = null;
  if (goal.target_date && DATE_RE.test(goal.target_date)) {
    daysToTarget = daysBetween(today(), goal.target_date);
    targetState = daysToTarget < 0 ? 'overdue' : daysToTarget === 0 ? 'today' : 'ahead';
  } else if (goal.target_date) {
    targetState = 'unreadable';   // stored but not a date — say so rather than showing NaN
  }

  return {
    id: goal.id,
    title: goal.title,
    why: goal.why,
    targetDate: goal.target_date,
    status: goal.status,
    createdAt: goal.created_at,

    stepsTotal: steps.length,
    stepsDone: doneCount,
    stepsRemaining: remaining.length,
    allStepsDone: steps.length > 0 && remaining.length === 0,

    nextAction: nextAction && {
      id: nextAction.id,
      position: nextAction.position,
      title: nextAction.title,
      costPence: nextAction.cost_pence,
      note: nextAction.note,
    },
    sentence,
    blocked: isBlocked,
    blockedBy: isBlocked ? firstRemaining.blocked_by : null,
    blockedAtPosition: isBlocked ? firstRemaining.position : null,
    // Blocks that are not stopping you yet, but will. Listed so a block you set three
    // weeks ago does not surprise you at the point you reach it.
    laterBlocks: remaining.filter((s) => blocked(s) && s !== firstRemaining)
      .map((s) => ({ position: s.position, title: s.title, blockedBy: s.blocked_by })),

    costToFinishPence,
    costKnownSteps: priced.length,
    costUnknownSteps,
    costComplete: remaining.length > 0 && costUnknownSteps === 0,
    costBasis,

    daysToTarget,
    targetState,

    steps: steps.map((s) => ({
      id: s.id,
      position: s.position,
      title: s.title,
      costPence: s.cost_pence,
      blockedBy: s.blocked_by,
      doneOn: s.done_on,
      done: !!s.done_on,
      note: s.note,
    })),
  };
}

const router = express.Router();

// ---------------------------------------------------------------------------- read
router.get('/', safe((req, res) => {
  const filter = GOAL_STATUSES.includes(req.query.status) ? req.query.status
    : req.query.status === 'all' ? 'all' : 'active';

  const all = db.prepare('SELECT * FROM goals').all();
  const rows = filter === 'all' ? all : all.filter((g) => g.status === filter);
  const goals = rows.map((g) => derive(g, stepsFor(g.id)));

  // Sort is arithmetic you can check, not a priority score: anything with a target date
  // comes first, soonest first, and everything else keeps the order you created it in.
  // Nothing here weighs one goal against another — a ranking built from weights I chose
  // would be the one figure on the page you could not audit.
  goals.sort((a, b) => {
    if (a.daysToTarget === null && b.daysToTarget === null) return a.id - b.id;
    if (a.daysToTarget === null) return 1;
    if (b.daysToTarget === null) return -1;
    return a.daysToTarget - b.daysToTarget;
  });

  const counts = GOAL_STATUSES.reduce((acc, s) => {
    acc[s] = all.filter((g) => g.status === s).length;
    return acc;
  }, {});

  const withSteps = goals.filter((g) => g.stepsTotal > 0);
  const actionable = withSteps.filter((g) => !g.blocked && g.stepsRemaining > 0);
  const blockedGoals = withSteps.filter((g) => g.blocked);

  // The portfolio cost, carrying its own incompleteness with it for the same reason the
  // per-goal one does.
  const pricedTotal = goals.reduce((sum, g) => sum + (g.costToFinishPence || 0), 0);
  const unknownTotal = goals.reduce((sum, g) => sum + g.costUnknownSteps, 0);
  const anyPriced = goals.some((g) => g.costToFinishPence !== null);

  const payload = {
    today: today(),
    filter,
    counts,
    shown: goals.length,
    actionableCount: actionable.length,
    blockedCount: blockedGoals.length,
    noStepsCount: goals.filter((g) => g.stepsTotal === 0).length,
    costToFinishPence: anyPriced ? pricedTotal : null,
    costUnknownSteps: unknownTotal,
    order: 'Goals with a target date first, soonest first; the rest in the order you added them. '
      + 'There is no priority score here and nothing is weighted.',
    scope: 'This module knows what these goals cost, not what you can afford. Affordability '
      + 'belongs to the budget module and is deliberately not recomputed here.',
    goals,
  };

  if (!goals.length) {
    // Empty is a state with a name and a message. It reaches the panel as `state: 'empty'`
    // and a failed read reaches it as an HTTP error — the two can never render the same.
    // "There are none" and "there are none MATCHING THIS FILTER" are different facts, and
    // reporting the second as the first is a filter failing to declare its own residue.
    return res.json({
      ...payload,
      state: 'empty',
      message: all.length === 0
        ? 'No goals yet. Add one and give it steps; the next action is worked out from them.'
        : `No goals with the status "${filter}" — the filter is hiding ${plural(all.length, 'goal')}. `
          + 'Switch it to "everything" to see them.',
    });
  }
  res.json({ ...payload, state: 'ok' });
}));

router.get('/goals/:id', safe((req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(req.params.id));
  if (!goal) return res.status(404).json({ error: 'no such goal' });
  res.json({ state: 'ok', today: today(), goal: derive(goal, stepsFor(goal.id)) });
}));

// ---------------------------------------------------------------------------- goals
router.post('/goals', safe((req, res) => {
  const { title, why, targetDate, status } = req.body || {};
  if (!String(title || '').trim()) return res.status(400).json({ error: 'title is required' });
  if (targetDate && !DATE_RE.test(targetDate)) return res.status(400).json({ error: 'targetDate must be YYYY-MM-DD' });
  if (status && !GOAL_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${GOAL_STATUSES.join(', ')}` });

  const info = db.prepare('INSERT INTO goals (title, why, target_date, status) VALUES (?, ?, ?, ?)')
    .run(String(title).trim(), why || null, targetDate || null, status || 'active');

  res.status(201).json({
    id: Number(info.lastInsertRowid),
    status: status || 'active',
    note: 'A goal with no steps has no next action — that is not a bug, it is the state. Add steps.',
  });
}));

router.patch('/goals/:id', safe((req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const sets = [];
  const args = [];

  // Only keys actually present are touched. `null` clears a field; absent leaves it alone.
  if ('title' in body) {
    if (!String(body.title || '').trim()) return res.status(400).json({ error: 'title cannot be blank' });
    sets.push('title = ?'); args.push(String(body.title).trim());
  }
  if ('why' in body) { sets.push('why = ?'); args.push(body.why || null); }
  if ('targetDate' in body) {
    if (body.targetDate && !DATE_RE.test(body.targetDate)) return res.status(400).json({ error: 'targetDate must be YYYY-MM-DD' });
    sets.push('target_date = ?'); args.push(body.targetDate || null);
  }
  if ('status' in body) {
    if (!GOAL_STATUSES.includes(body.status)) return res.status(400).json({ error: `status must be one of ${GOAL_STATUSES.join(', ')}` });
    sets.push('status = ?'); args.push(body.status);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to change' });

  args.push(id);
  const r = db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  if (!r.changes) return res.status(404).json({ error: 'no such goal' });

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  res.json({ state: 'ok', goal: derive(goal, stepsFor(id)) });
}));

router.delete('/goals/:id', safe((req, res) => {
  const id = Number(req.params.id);
  // Steps go with it via ON DELETE CASCADE — db.js sets PRAGMA foreign_keys = ON, without
  // which the cascade silently does nothing and orphan steps accumulate unseen.
  const stepCount = db.prepare('SELECT COUNT(*) AS c FROM goal_steps WHERE goal_id = ?').get(id).c;
  const r = db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'no such goal' });
  res.json({ deleted: id, stepsDeleted: stepCount });
}));

// ---------------------------------------------------------------------------- steps
router.post('/goals/:id/steps', safe((req, res) => {
  const goalId = Number(req.params.id);
  const goal = db.prepare('SELECT id FROM goals WHERE id = ?').get(goalId);
  if (!goal) return res.status(404).json({ error: 'no such goal' });

  const { title, cost, blockedBy, note, position } = req.body || {};
  if (!String(title || '').trim()) return res.status(400).json({ error: 'title is required' });

  const money = toPence(cost);
  if (!money.ok) return res.status(400).json({ error: 'cost must be a non-negative number of pounds, or empty for "not known"' });

  // Appends by default. An explicit position is allowed and ties break by id, so two steps
  // at the same position stay in insertion order rather than swapping about between reads.
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM goal_steps WHERE goal_id = ?').get(goalId).m;
  const pos = Number.isInteger(Number(position)) && Number(position) > 0 ? Number(position) : max + 1;

  const info = db.prepare(
    'INSERT INTO goal_steps (goal_id, position, title, cost_pence, blocked_by, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(goalId, pos, String(title).trim(), money.pence, blockedBy || null, note || null);

  res.status(201).json({ id: Number(info.lastInsertRowid), goalId, position: pos, costPence: money.pence });
}));

router.patch('/steps/:id', safe((req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const sets = [];
  const args = [];

  if ('title' in body) {
    if (!String(body.title || '').trim()) return res.status(400).json({ error: 'title cannot be blank' });
    sets.push('title = ?'); args.push(String(body.title).trim());
  }
  if ('cost' in body) {
    const money = toPence(body.cost);
    if (!money.ok) return res.status(400).json({ error: 'cost must be a non-negative number of pounds, or empty for "not known"' });
    // Clearing a cost back to NULL is a first-class action: realising the number you typed
    // was a guess must be as easy as typing it was.
    sets.push('cost_pence = ?'); args.push(money.pence);
  }
  if ('blockedBy' in body) {
    const b = body.blockedBy === null ? null : String(body.blockedBy).trim();
    sets.push('blocked_by = ?'); args.push(b || null);
  }
  if ('note' in body) { sets.push('note = ?'); args.push(body.note || null); }
  if ('position' in body) {
    const p = Number(body.position);
    if (!Number.isInteger(p) || p < 1) return res.status(400).json({ error: 'position must be a positive integer' });
    sets.push('position = ?'); args.push(p);
  }
  // `done` is the one-keystroke path; `doneOn` is there for recording something you did
  // last week without lying about the date.
  if ('doneOn' in body) {
    if (body.doneOn && !DATE_RE.test(body.doneOn)) return res.status(400).json({ error: 'doneOn must be YYYY-MM-DD' });
    sets.push('done_on = ?'); args.push(body.doneOn || null);
  } else if ('done' in body) {
    sets.push('done_on = ?'); args.push(body.done ? today() : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to change' });

  args.push(id);
  const r = db.prepare(`UPDATE goal_steps SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  if (!r.changes) return res.status(404).json({ error: 'no such step' });

  // Answer with the whole goal re-derived. The caller changed one step, but the next
  // action, the block and the cost floor may all have moved — and if the panel recomputed
  // any of that itself it would be a second owner of the same figure.
  const step = db.prepare('SELECT * FROM goal_steps WHERE id = ?').get(id);
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(step.goal_id);
  res.json({ state: 'ok', goal: derive(goal, stepsFor(goal.id)) });
}));

router.delete('/steps/:id', safe((req, res) => {
  const id = Number(req.params.id);
  const step = db.prepare('SELECT goal_id FROM goal_steps WHERE id = ?').get(id);
  if (!step) return res.status(404).json({ error: 'no such step' });
  db.prepare('DELETE FROM goal_steps WHERE id = ?').run(id);

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(step.goal_id);
  res.json({ deleted: id, state: 'ok', goal: derive(goal, stepsFor(goal.id)) });
}));

// Anything else under /api/goals answers JSON. Without this the static handler serves the
// dashboard's HTML to a fetch expecting JSON, and the parse error that follows sends you
// looking at the panel instead of at the URL you got wrong.
router.all('*', (req, res) => {
  res.status(404).json({ error: `no such goals endpoint: ${req.method} /api/goals${req.params[0]}` });
});

module.exports = router;
