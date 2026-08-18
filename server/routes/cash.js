// Cash reconciliation — backlog #M36. Reads only /api/cash, owns only cash_counts.
//
// THE PROBLEM THIS EXISTS FOR, measured rather than assumed: 166 withdrawals totalling
// GBP 14,081.45 in twelve months. Cash and person-to-person payments are 77.6% of all
// measured spending, and the rent-affordability work had to REFUSE to produce a figure
// because of it. This is the largest single thing standing between the ledger and an honest
// picture of where money goes.
//
// IT IS NOT AN EXPENSE TRACKER, and that is the whole design. Itemising every cash purchase
// is exactly the surface you stop feeding in week three — the workspace gate rejects it, and
// rightly. Instead it reconciles the TIN:
//
//     the ledger knows what you WITHDREW since the last count
//     you count the tin and type ONE number
//     the difference is what was spent, without recording a single purchase
//
// A whole category moves from unknown to known for one keystroke. It says nothing about what
// the money bought and it is not supposed to.
//
// WHAT IT REFUSES TO DO:
//   - no judgement. No "you are spending too much cash", no target, no category guessing.
//   - no fabricated zero. "Not counted since 3 Aug" is not "GBP 0 spent", and the two are
//     rendered differently everywhere.
//   - no clamping. A count implying NEGATIVE spend means cash arrived from somewhere the
//     ledger cannot see. That is a real and interesting fact, so it is reported as itself
//     rather than floored at zero.
'use strict';

const express = require('express');
const db = require('../db');
const finance = require('./finance');

db.migrate('cash', [
  (d) => {
    d.exec(`
      CREATE TABLE cash_counts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        counted_on TEXT NOT NULL,              -- the DAY you counted, not when you typed it
        pence      INTEGER NOT NULL,           -- integers, like every other money column here
        note       TEXT,
        by_whom    TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX idx_cash_counts_on ON cash_counts(counted_on);
    `);
  },
]);

const router = express.Router();

const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);

const dayDiff = (a, b) => Math.round(
  (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000,
);

// The two most recent counts, newest first. Two is all the arithmetic needs.
function lastTwo() {
  return db.prepare('SELECT * FROM cash_counts ORDER BY counted_on DESC, id DESC LIMIT 2').all();
}

// ---------------------------------------------------------------------------------- state
function state() {
  const counts = lastTwo();
  const total = db.prepare('SELECT COUNT(*) AS c FROM cash_counts').get().c;
  const ledgerEnd = finance.ledgerSpan ? null : null;   // span is not needed; withdrawn carries the end

  if (!counts.length) {
    // NEVER COUNTED. Distinct from "counted and nothing has changed", and it carries no
    // spend figure at all rather than a zero that would read as "you spent nothing".
    const since = finance.cashWithdrawn({});
    return {
      state: 'never counted',
      why: 'No count has ever been recorded, so there is no earlier balance to compare against. '
        + 'This is not a report that no cash was spent — nothing here can know that yet.',
      counts: 0,
      spentSinceLastCount: null,
      firstCountWillNotDeriveSpend: true,
      ledger: since.ok ? { withdrawalsAllTime: since.withdrawals, penceAllTime: since.pence, endsOn: since.to } : since,
    };
  }

  const [latest, previous] = counts;
  const since = finance.cashWithdrawn({ from: latest.counted_on });
  if (!since.ok) return { state: 'error', why: since.message, counts: total };

  const today = localToday();
  const staleDays = dayDiff(today, since.ledgerEndsOn);
  const sinceCountDays = dayDiff(today, latest.counted_on);

  const base = {
    counts: total,
    lastCount: { on: latest.counted_on, pence: latest.pence, note: latest.note || null, daysAgo: dayDiff(today, latest.counted_on) },
    ledger: {
      endsOn: since.ledgerEndsOn,
      staleByDays: staleDays,
      withdrawalsSinceLastCount: since.withdrawals,
      penceSinceLastCount: since.pence,
    },
  };

  if (!previous) {
    // A BASELINE, not a measurement. One count establishes a starting balance and nothing
    // else; deriving spend needs two. Said plainly so the first count does not look broken.
    return {
      ...base,
      state: 'baseline only',
      spentSinceLastCount: null,
      why: 'Only one count exists. It sets the starting balance; spend is the difference '
        + 'between two counts, so the next one is the first that can derive anything.',
    };
  }

  // THE DERIVATION, and it is the whole module:
  //   tin_now = tin_prev + withdrawn_between - spent
  //   => spent = tin_prev + withdrawn_between - tin_now
  const between = finance.cashWithdrawn({ from: previous.counted_on, to: latest.counted_on });
  const spent = previous.pence + between.pence - latest.pence;
  const windowDays = dayDiff(latest.counted_on, previous.counted_on);

  return {
    ...base,
    state: 'reconciled',
    previousCount: { on: previous.counted_on, pence: previous.pence },
    window: { from: previous.counted_on, to: latest.counted_on, days: windowDays },
    withdrawnInWindow: between.pence,
    withdrawalsInWindow: between.withdrawals,
    spentInWindow: spent,
    // Negative spend is NOT an error and is never clamped. It means the tin gained more than
    // the ledger explains, i.e. cash came from somewhere this system cannot see -- a gift,
    // a repayment in cash, an account not imported. That is worth knowing, not hiding.
    cashArrivedFromOutsideLedger: spent < 0 ? -spent : 0,
    perDay: windowDays > 0 ? Math.round(spent / windowDays) : null,
    why: spent < 0
      ? 'The tin holds MORE than the withdrawals explain. Cash came in from somewhere the '
        + 'ledger cannot see. Not an error, and deliberately not rounded up to zero.'
      : `Derived from two counts ${windowDays} day${windowDays === 1 ? '' : 's'} apart: `
        + 'previous balance plus withdrawals in between, minus what is in the tin now. '
        + 'No purchase was recorded to produce this.',
    // Reported rather than assumed away: the window this covers, and what it cannot see.
    blindTo: [
      'What the money bought. This measures a total, never a purchase.',
      'Cash withdrawn after the ledger ends'
        + (staleDays > 0 ? ` — it is ${staleDays} day${staleDays === 1 ? '' : 's'} behind today, so anything since is missing.` : '.'),
      'Cash spent straight from a withdrawal without reaching the tin — it lands in this '
        + 'figure identically, which is correct for a total and wrong for a location.',
      sinceCountDays > 0
        ? `Anything since the last count ${sinceCountDays} day${sinceCountDays === 1 ? '' : 's'} ago; the next count closes that window.`
        : 'Nothing yet — the last count is today.',
    ],
  };
}

router.get('/', (req, res) => res.json(state()));

// ------------------------------------------------------------------------------ recording
router.post('/counts', express.json(), (req, res) => {
  const { pounds, pence, countedOn, note } = req.body || {};

  // Accept pounds (what you type) or pence (what a caller computes), never guess between
  // them. A bare number meaning either is how a GBP 40 count becomes GBP 0.40.
  let p;
  if (pence !== undefined) p = Math.round(Number(pence));
  else if (pounds !== undefined) p = Math.round(Number(pounds) * 100);
  else return res.status(400).json({ error: 'send pounds (e.g. 42.50) or pence (e.g. 4250)' });
  if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'the amount must be a non-negative number' });

  const on = String(countedOn || localToday()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return res.status(400).json({ error: 'countedOn must be YYYY-MM-DD' });
  if (on > localToday()) return res.status(400).json({ error: 'a count cannot be dated in the future' });

  db.prepare('INSERT INTO cash_counts (counted_on, pence, note, by_whom) VALUES (?, ?, ?, ?)')
    .run(on, p, note || null, req.by);

  // The derivation comes back IMMEDIATELY in the same response. That is the workspace rule
  // for manual capture: one keystroke, and the value returns without you going to look.
  res.status(201).json(state());
});

router.get('/counts', (req, res) => {
  res.json(db.prepare('SELECT * FROM cash_counts ORDER BY counted_on DESC, id DESC LIMIT 50').all());
});

router.delete('/counts/:id', (req, res) => {
  const info = db.prepare('DELETE FROM cash_counts WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'no such count' });
  res.json(state());
});

module.exports = router;
module.exports.state = state;
