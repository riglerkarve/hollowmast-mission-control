// The daily triggers — the things worth interrupting you for.
//
//   node scripts/triggers.cjs          list what would fire right now, send nothing
//   node scripts/triggers.cjs --notify actually raise them
//
// Called from briefing.cjs's --notify block so there is ONE notification pass a day and
// no new scheduled task. Task Scheduler runs five live services on this machine and every
// task added is another thing that can silently stop.
//
// THE BAR IS THE POINT. "An alert you learn to dismiss is worse than no alert, because it
// teaches you to ignore the channel." So a trigger only earns a place here if it is:
//
//   1. an EVENT, not a standing condition. "26 items are blocked on you" is true every
//      day and would be pure noise; it belongs on the Backlog panel, where it already is.
//   2. UNAMBIGUOUS. No threshold I invented. Each one below fires on a sign change or a
//      date passing, not on a number I picked.
//   3. ACTIONABLE in one step. If reading it does not tell you what to do, it is a report,
//      and reports go in the briefing.
//
// DELIBERATELY NOT A TRIGGER: per-category budget breaches. Two are over right now, and
// one of them is "Other" at £75.50 against a £3.00 budget — a category whose median is
// near zero produces an enormous percentage overage from a trivial sum. Any absolute
// threshold that fixed it would be a number I chose. Those breaches are listed in the
// briefing, which you read, rather than pushed at you. Headroom going NEGATIVE is the
// unambiguous version of the same concern, and that is trigger 2.
'use strict';

const budget = require('../server/routes/budget');
const finance = require('../server/routes/finance');
const schedule = require('../server/routes/schedule');

const gbp = (p) => `£${(Math.abs(p || 0) / 100).toFixed(2)}`;

// Each check returns an alert object or null. Null means "looked, and it was fine" —
// which the caller reports differently from "could not look".
const CHECKS = [
  {
    kind: 'schedule_overdue',
    why: 'a date passed and nothing was decided',
    run() {
      const u = schedule.upcoming(7);
      if (!u.overdue.length) return null;
      const names = u.overdue.slice(0, 3).map((e) => e.title || 'untitled').join(', ');
      const more = u.overdue.length > 3 ? ` and ${u.overdue.length - 3} more` : '';
      return {
        title: `${u.overdue.length} overdue on the schedule`,
        body: `${names}${more}. Each needs marking done, missed or cancelled.`,
      };
    },
  },
  {
    kind: 'budget_headroom',
    why: 'committed spending now exceeds what is uncommitted',
    run() {
      const b = budget.breaches();
      // A sign change, not a threshold. Negative headroom means what has gone plus the
      // essentials still to come exceed what came in — that is arithmetic, not a judgement.
      if (b.headroomPence >= 0) return null;
      return {
        title: `Headroom is ${gbp(b.headroomPence)} short this month`,
        body: 'Income less spending less the essentials still to come is negative. '
          + 'Anything approved on the wishlist is already counted.',
      };
    },
  },
  {
    kind: 'ledger_stale',
    why: 'every money figure has quietly become history',
    run() {
      const s = finance.ledgerSpan();
      if (s.rows === 0 || s.staleDays == null) return null;
      // 40 days is not a preference: past a full statement cycle the ledger can no longer
      // describe "this month" at all, and the briefing already switches to a different
      // wording at the same point. One owner for the boundary.
      if (s.staleDays <= 40) return null;
      return {
        title: `The ledger is ${s.staleDays} days out of date`,
        body: `It ends ${s.last}. Every spending figure describes that period, not now. `
          + 'Import the latest statements.',
      };
    },
  },
];

function evaluate() {
  return CHECKS.map((c) => {
    try {
      const hit = c.run();
      // Three outcomes, never two: fired, checked-and-clear, or could-not-check.
      return hit ? { kind: c.kind, state: 'fires', ...hit } : { kind: c.kind, state: 'clear' };
    } catch (err) {
      return { kind: c.kind, state: 'error', error: err.message };
    }
  });
}

function run({ notify = false } = {}) {
  const results = evaluate();
  if (!notify) return results;

  const raise = require('./notify.cjs');
  for (const r of results) {
    if (r.state !== 'fires') continue;
    const out = raise(r.kind, r.title, r.body);
    r.delivered = !!out.delivered;
    r.suppressed = !!out.suppressed;
    if (out.error) r.error = out.error;
  }
  return results;
}

module.exports = { evaluate, run, CHECKS };

if (require.main === module) {
  const notify = process.argv.includes('--notify');
  const results = run({ notify });
  for (const r of results) {
    const c = CHECKS.find((x) => x.kind === r.kind);
    if (r.state === 'error') {
      console.error(`  ERROR   ${r.kind}: ${r.error}`);
    } else if (r.state === 'clear') {
      console.log(`  clear   ${r.kind.padEnd(18)} (${c.why})`);
    } else {
      const how = !notify ? 'would fire' : r.suppressed ? 'SUPPRESSED (muted)' : r.delivered ? 'SENT' : `FAILED: ${r.error || 'unknown'}`;
      console.log(`  FIRES   ${r.kind.padEnd(18)} ${how}\n          ${r.title}\n          ${r.body}`);
    }
  }
  const fired = results.filter((r) => r.state === 'fires').length;
  const errored = results.filter((r) => r.state === 'error').length;
  console.log(`\n${results.length} checks, ${fired} firing, ${errored} could not run.`);
}
