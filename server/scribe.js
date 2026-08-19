'use strict';
// The Scribe -- the free local tier, and the one that keeps working when the paid ones stop.
//
// Owner decision, 20 August 2026, given in two parts:
//
//   1. "it would exclusively have finance and wellbeing"
//   2. "I want the free model to do actual work should all my subscriptions hit the
//      weekly or session caps"
//
// (2) is the reason this file exists. Claude Code has weekly and session caps and Codex
// runs on a subscription; when both are spent the workspace goes dark and the owner is the
// one who notices. A model on this machine has no cap at all, so the question is never
// "is it as good" -- it is "what can it be TRUSTED with while the good ones are away",
// and that question has a measured answer rather than an opinion.
//
// WHY THIS SHIPS ABLE TO DO NOTHING.
// Every capability starts unproven, and an unproven job is REFUSED rather than attempted.
// The temptation was to seed the table with the jobs I believe a 4B can do -- and seeding
// a guard with my own guesses is precisely the failure the guard exists to prevent. A
// capability list I wrote is a list of my predictions wearing a measurement's clothing.
// The list grows one way only: something scored the job against an oracle it did not supply.
//
// Measured on this machine, and the reason the bar sits where it does: qwen3.5:4b scored
// 10/12 on constrained classification against an enum, and on the Team Manager trial it
// returned the SAME verdict for evidence that supported a claim and evidence that
// contradicted it. It is good at "put this in one of four boxes" and bad at "is this true".
// The capability table is how that stays a fact about jobs rather than a mood about models.

const REFUSED_UNPROVEN = 'unproven';
const REFUSED_FAILED   = 'failed-measurement';
const REFUSED_STALE    = 'measurement-stale';

// How long a measurement is good for. Model behaviour changes between Ollama releases --
// gpt-oss silently stopped honouring JSON schemas exactly that way -- so a score from three
// months ago is a historical fact, not a current capability.
const MEASUREMENT_TTL_DAYS = 45;

// THE TWO DOMAINS THE SCRIBE HOLDS EXCLUSIVELY.
//
// This is custody, not authorship, and the difference is load-bearing.
//
//   finance   -- may READ and WRITE. The standing rule was always "local only", never
//                "no model", because nothing is disclosed by a model that cannot reach
//                the network. The Scribe is the only tier permitted there at all.
//
//   wellbeing -- may READ and COUNT and never WRITE. Fixed policy, unchanged by this
//                decision: nothing in that module may be model-generated -- no prose, no
//                pattern, no score -- and nothing may read as diagnosis or advice.
//                Exclusive custody means no OTHER model may see it. It does not mean
//                this one may write there.
//
// If that is ever relaxed it is relaxed by the owner in writing, in CLAUDE.md, and not by
// a capability being measured as accurate. Accuracy was never the objection.
const CUSTODY = {
  finance:   { read: true, write: true,  why: 'Local-only was always the rule; nothing is disclosed by a model that cannot reach the network.' },
  wellbeing: { read: true, write: false, why: 'FIXED POLICY: nothing in wellbeing may be model-generated. Custody keeps other models out; it does not let this one in.' },
};

function daysSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

// The gate. Every Scribe job passes through here and the default answer is no.
//
// Returns a REASON in every case, including the allowed one, because a caller that logs
// only the boolean produces a run record where "did the work" and "silently skipped it"
// look identical -- and this tier exists to run unattended while nobody is watching.
function scribeCan(db, job) {
  const row = db.prepare('SELECT * FROM scribe_capabilities WHERE job = ?').get(job);

  if (!row) {
    return {
      allowed: false, status: REFUSED_UNPROVEN, job,
      why: 'This job has never been measured. An unmeasured job is refused rather than attempted, '
         + 'because a plausible answer from an unproven capability is the failure nobody catches.',
      how_to_clear: 'Score it against an oracle it did not supply, then POST /api/team/scribe/measure.',
    };
  }
  if (row.status === 'failed') {
    return {
      allowed: false, status: REFUSED_FAILED, job, score: row.score, floor: row.floor,
      why: 'Measured at ' + row.score + ' against a floor of ' + row.floor + ' and failed. '
         + 'Re-measure to change this; do not lower the floor to clear it.',
    };
  }
  if (row.status !== 'proven') {
    return { allowed: false, status: REFUSED_UNPROVEN, job, why: 'Recorded as ' + row.status + '.' };
  }
  const age = daysSince(row.measured_at);
  if (age > MEASUREMENT_TTL_DAYS) {
    return {
      allowed: false, status: REFUSED_STALE, job, score: row.score, measured_at: row.measured_at,
      why: 'Scored ' + row.score + ', but that was ' + Math.round(age) + ' days ago and measurements '
         + 'expire after ' + MEASUREMENT_TTL_DAYS + '. Model behaviour changes between Ollama releases; '
         + 'an old score is a historical fact, not a current capability.',
    };
  }
  return {
    allowed: true, status: 'proven', job,
    score: row.score, floor: row.floor, sample_n: row.sample_n, oracle: row.oracle,
    measured_at: row.measured_at, age_days: Math.round(age),
    why: 'Scored ' + row.score + ' on ' + row.sample_n + ' items against ' + row.oracle
       + ', floor ' + row.floor + ', ' + Math.round(age) + ' days ago.',
  };
}

// Custody, asked of a MODULE rather than a job.
// engine is the tier wanting the data: 'scribe' | 'claude' | 'codex' | 'ollama-cloud'.
function custodyAllows(module, engine, intent /* 'read' | 'write' */) {
  const c = CUSTODY[module];
  if (!c) return { allowed: true, why: module + ' is not under exclusive custody.' };

  if (engine !== 'scribe') {
    return {
      allowed: false,
      why: module + ' is under the Scribe\'s exclusive custody (owner decision, 20 Aug 2026). '
         + engine + ' may not ' + intent + ' it. ' + c.why,
    };
  }
  if (intent === 'write' && !c.write) {
    return { allowed: false, why: 'The Scribe holds custody of ' + module + ' but has no pen there. ' + c.why };
  }
  return { allowed: true, why: c.why };
}

// Which paid tiers are currently spent.
//
// THIS CANNOT BE DETECTED FROM HERE, and pretending otherwise would be the worst kind of
// guess: a cap-detector that reports "not capped" when it simply cannot see is
// indistinguishable from a working one right up until the moment it matters. So a cap is
// DECLARED -- by the owner, or by a session that hit one -- and an undeclared cap leaves
// the Scribe idle, which is the safe direction to be wrong in.
function cappedTiers(db) {
  const now = new Date().toISOString();
  return db.prepare(
    'SELECT tier, declared_at, until, note FROM scribe_caps '
  + ' WHERE until IS NULL OR until > ? ORDER BY declared_at DESC'
  ).all(now);
}

function anythingCapped(db) { return cappedTiers(db).length > 0; }

// Record what happened. Called on EVERY attempt including refusals, because "ran and wrote
// nothing" and "never ran" are different states, and a table holding only successes cannot
// tell them apart.
function recordRun(db, { job, model, items, wrote, refused, reason, detail }) {
  return db.prepare(
    'INSERT INTO scribe_runs (job, model, at, items, wrote, refused, reason, detail) '
  + 'VALUES (?,?,?,?,?,?,?,?)'
  ).run(job, model || null, new Date().toISOString(),
        items == null ? null : items, wrote || 0, refused ? 1 : 0, reason || null,
        detail ? JSON.stringify(detail) : null);
}

module.exports = {
  scribeCan, custodyAllows, cappedTiers, anythingCapped, recordRun,
  CUSTODY, MEASUREMENT_TTL_DAYS,
  REFUSED_UNPROVEN, REFUSED_FAILED, REFUSED_STALE,
};
