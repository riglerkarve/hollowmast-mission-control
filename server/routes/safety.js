const express = require('express');
const db = require('../db');

// SAFETY — the hard limits, in code rather than in prose.
//
// This module exists so that anything which could ever authorise money has one place to
// ask, and cannot get a different answer by asking differently. Backlog #11, and it is a
// prerequisite for #28: it had to exist BEFORE anything that can spend, not alongside it.
//
// THREE PROPERTIES, and they are the whole design:
//
//   1. IT FAILS CLOSED. The ceilings default to zero and the payee allowlist starts
//      empty, so check() refuses everything until you set limits deliberately. Zero is
//      not a figure I invented — it is the absence of permission, which is the only
//      honest default for a guard that has never been configured.
//
//   2. THERE IS NO OVERRIDE. check() takes no `force`, no `reason`, no admin flag. The
//      refusal path cannot be argued with because there is no argument to pass. If a
//      future caller needs a higher ceiling, the ceiling is raised deliberately and that
//      change is recorded — it is never waived at the call site.
//
//   3. EVERY CALL IS RECORDED, allowed or refused. A guard with no log cannot tell
//      "nothing was refused" apart from "nothing ever asked", and those are very
//      different states.
//
// WHAT THIS CANNOT DO, said plainly. The backlog item is titled "nothing illegal, do not
// bankrupt the owner, true analysis". The first two are mechanical and are enforced here.
// The third is not mechanically enforceable — no function can verify that an analysis is
// honest. The nearest real control already exists elsewhere: the briefing bars the local
// model from emitting any figure, and every number on the dashboard comes from SQL. This
// module does not pretend to cover it.
//
// AND IT STILL SPENDS NOTHING. Nothing in this codebase can move money. check() answers a
// question; it does not authorise a payment, because there is no payment path to
// authorise. It exists so that when one is proposed, the limit is already there.

db.migrate('safety', [
  (d) => {
    d.exec(`
      CREATE TABLE safety_limits (
        key         TEXT PRIMARY KEY,
        value_pence INTEGER NOT NULL,
        set_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        set_by      TEXT NOT NULL DEFAULT 'default'
      );

      CREATE TABLE safety_payees (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT NOT NULL,
        norm     TEXT NOT NULL UNIQUE,   -- lowercased/trimmed, so case cannot smuggle a duplicate
        note     TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE safety_decisions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        action       TEXT,
        payee        TEXT,
        amount_pence INTEGER,
        outcome      TEXT NOT NULL,      -- 'allowed' | 'refused'
        reasons      TEXT NOT NULL,      -- JSON array of stable reason codes
        asked_by     TEXT
      );

      CREATE INDEX idx_safety_dec_at ON safety_decisions(at);
      CREATE INDEX idx_safety_dec_out ON safety_decisions(outcome);
    `);

    // Explicit zeroes rather than absent rows: a missing limit and a limit of zero must
    // not be told apart by accident, and a row makes "never configured" visible in the UI.
    const ins = d.prepare("INSERT INTO safety_limits (key, value_pence, set_by) VALUES (?, 0, 'default')");
    ins.run('per_transaction_pence');
    ins.run('per_month_pence');
  },
]);

const LIMIT_KEYS = ['per_transaction_pence', 'per_month_pence'];
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const thisMonth = () => new Date().toISOString().slice(0, 7);

const router = express.Router();

function limits() {
  const rows = db.prepare('SELECT * FROM safety_limits').all();
  const out = {};
  for (const k of LIMIT_KEYS) {
    const r = rows.find((x) => x.key === k);
    out[k] = r
      ? { pence: r.value_pence, setBy: r.set_by, setAt: r.set_at }
      : { pence: 0, setBy: 'missing', setAt: null };
  }
  return out;
}

// How much this system has AUTHORISED in the current month — not how much you have spent.
// Those are different figures with different owners: finance owns real spend, safety owns
// what it let through. Conflating them would let a grocery shop consume a purchase ceiling.
function authorisedThisMonth(month = thisMonth()) {
  return db.prepare(
    `SELECT COALESCE(SUM(amount_pence), 0) AS pence, COUNT(*) AS n
       FROM safety_decisions
      WHERE outcome = 'allowed' AND substr(at, 1, 7) = ?`
  ).get(month);
}

// THE GUARD. Note the signature: there is no override argument, by design.
function check({ amountPence, payee, action, askedBy } = {}) {
  const L = limits();
  const perTxn = L.per_transaction_pence.pence;
  const perMonth = L.per_month_pence.pence;
  const reasons = [];

  const amount = Number(amountPence);
  if (!Number.isInteger(amount) || amount < 0) reasons.push('invalid_amount');

  // Fails closed: unconfigured is refused, and says so distinctly from "too expensive".
  if (perTxn <= 0 || perMonth <= 0) reasons.push('no_limits_set');

  if (Number.isInteger(amount) && amount >= 0) {
    if (perTxn > 0 && amount > perTxn) reasons.push('over_transaction_ceiling');
    const used = authorisedThisMonth().pence;
    if (perMonth > 0 && used + amount > perMonth) reasons.push('over_monthly_ceiling');
  }

  const payeeNorm = norm(payee);
  if (!payeeNorm) {
    reasons.push('no_payee');
  } else if (!db.prepare('SELECT 1 FROM safety_payees WHERE norm = ?').get(payeeNorm)) {
    reasons.push('payee_not_allowed');
  }

  const allowed = reasons.length === 0;
  db.prepare(
    `INSERT INTO safety_decisions (action, payee, amount_pence, outcome, reasons, asked_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    action == null ? null : String(action).slice(0, 300),
    payee == null ? null : String(payee).slice(0, 200),
    Number.isInteger(amount) ? amount : null,
    allowed ? 'allowed' : 'refused',
    JSON.stringify(reasons),
    askedBy == null ? null : String(askedBy).slice(0, 100)
  );

  return {
    allowed,
    reasons,
    // Restated on every answer so a caller cannot hold a stale idea of the ceiling.
    limits: { perTransactionPence: perTxn, perMonthPence: perMonth },
    authorisedThisMonthPence: authorisedThisMonth().pence,
  };
}

// ------------------------------------------------------------------------------ routes
router.get('/', (req, res) => {
  const L = limits();
  const used = authorisedThisMonth();
  const payees = db.prepare('SELECT * FROM safety_payees ORDER BY name').all();
  const recent = db
    .prepare('SELECT * FROM safety_decisions ORDER BY at DESC, id DESC LIMIT 25')
    .all()
    .map((r) => ({ ...r, reasons: JSON.parse(r.reasons) }));
  const totals = db.prepare('SELECT outcome, COUNT(*) n FROM safety_decisions GROUP BY outcome').all();

  const configured = L.per_transaction_pence.pence > 0 && L.per_month_pence.pence > 0;
  res.json({
    state: 'ok',
    configured,
    limits: L,
    month: thisMonth(),
    authorisedThisMonthPence: used.pence,
    authorisedThisMonthCount: used.n,
    payees,
    totals,
    recent,
    // Three states, never collapsed into one: never asked, asked and refused, asked and allowed.
    summary: recent.length === 0
      ? 'Nothing has asked this guard yet. That is not the same as nothing being refused.'
      : `${totals.reduce((s, t) => s + t.n, 0)} decisions recorded.`,
    note: configured
      ? 'Limits are set. check() refuses anything above them, and there is no override.'
      : 'FAILS CLOSED: no limits set, so check() refuses everything. Zero is the absence of '
        + 'permission, not a budget — set both ceilings deliberately before anything can pass.',
  });
});

router.post('/limits', (req, res) => {
  const { perTransaction, perMonth } = req.body || {};
  const toPence = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v) * 100));
  const t = toPence(perTransaction);
  const m = toPence(perMonth);
  if (t === null && m === null) {
    return res.status(400).json({ error: 'perTransaction or perMonth is required, in pounds' });
  }
  for (const [label, v] of [['perTransaction', t], ['perMonth', m]]) {
    if (v !== null && (!Number.isInteger(v) || v < 0)) {
      return res.status(400).json({ error: `${label} must be a non-negative number of pounds` });
    }
  }

  // Compare against what the OTHER ceiling will actually be after this write, not against
  // its current value — otherwise raising both in one call can be rejected on the strength
  // of a figure that is about to change.
  const L = limits();
  const finalT = t === null ? L.per_transaction_pence.pence : t;
  const finalM = m === null ? L.per_month_pence.pence : m;
  if (finalT > 0 && finalM > 0 && finalT > finalM) {
    return res.status(400).json({ error: 'the per-transaction ceiling cannot exceed the monthly ceiling' });
  }

  const set = db.prepare(
    `UPDATE safety_limits SET value_pence = ?, set_at = datetime('now','localtime'), set_by = 'user' WHERE key = ?`
  );
  if (t !== null) set.run(t, 'per_transaction_pence');
  if (m !== null) set.run(m, 'per_month_pence');
  res.json({ limits: limits() });
});

router.post('/payees', (req, res) => {
  const { name, note } = req.body || {};
  const clean = String(name || '').trim();
  if (!clean) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db
      .prepare('INSERT INTO safety_payees (name, norm, note) VALUES (?, ?, ?)')
      .run(clean, norm(clean), note || null);
    res.status(201).json({ id: Number(info.lastInsertRowid), name: clean });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'that payee is already on the allowlist' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/payees/:id', (req, res) => {
  const r = db.prepare('DELETE FROM safety_payees WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such payee' });
  res.json({ deleted: Number(req.params.id) });
});

// Ask the guard. This RECORDS the question, which is why it is a POST and not a GET:
// running a check is an event worth keeping, not a lookup.
router.post('/check', (req, res) => {
  const { amount, payee, action, askedBy } = req.body || {};
  const amountPence = amount === undefined || amount === null || amount === ''
    ? null
    : Math.round(Number(amount) * 100);
  res.json(check({ amountPence, payee, action, askedBy: askedBy || 'api' }));
});

module.exports = router;
module.exports.check = check;
module.exports.limits = limits;
module.exports.authorisedThisMonth = authorisedThisMonth;
