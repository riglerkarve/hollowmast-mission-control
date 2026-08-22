'use strict';
//
// safety-retro.js — a spending retrospective over the safety_decisions table.
//
// The safety module (safety.js) owns the guard: check() fails closed, records
// every question, and never overrides. THIS ROUTE IS THE RETROSPECTIVE VIEW:
// it reads what was already recorded and shapes it so the panel can answer
// "how has spending permission been used over time?" — which months were
// quiet or busy, which payees dominate, and which limits are in force.
//
// NOTHING HERE DERIVES ANYTHING THE SAFETY MODULE DOES NOT ALREADY RECORD.
// The amounts are amount_pence from safety_decisions; the limits are
// value_pence from safety_limits. We read; we never write. If the safety
// module has not been migrated yet, we return empty rather than throw, so a
// panel that mounts before the guard exists reports nothing rather than erroring.
const express = require('express');
const db = require('../db');

const router = express.Router();

// The safety_decisions and safety_limits tables are owned by the safety module,
// which created them in its own migration. We read them here; we never write.
// If either table is absent (safety module not yet migrated on a fresh
// database), we return empty rather than throw.
function tableExists(name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return !!row;
}

// Convert pence to pounds for display. The database stores amount_pence and
// value_pence (integers); the panel wants pounds as a readable number.
const toPounds = (pence) => {
  const n = Number(pence);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
};

// Shape a safety_decisions row for the panel. The route owns the field names
// so the panel does not reach into the database's own column names.
function shapeDecision(row) {
  return {
    id: row.id,
    decidedAt: row.at,
    action: row.action || null,
    payee: row.payee || null,
    amount: toPounds(row.amount_pence),
    amountPence: row.amount_pence,
    outcome: row.outcome,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    askedBy: row.asked_by || null,
  };
}

// Shape a safety_limits row for the panel.
function shapeLimit(row) {
  return {
    key: row.key,
    value: toPounds(row.value_pence),
    valuePence: row.value_pence,
    setAt: row.set_at,
    setBy: row.set_by,
  };
}

// Group decisions by month (YYYY-MM) and return an array of
// { month, count, totalPence } sorted by month ascending.
function groupByMonth(decisions) {
  const map = new Map();
  for (const d of decisions) {
    const month = String(d.decidedAt || '').slice(0, 7);
    if (!month) continue;
    if (!map.has(month)) map.set(month, { month, count: 0, totalPence: 0 });
    const entry = map.get(month);
    entry.count += 1;
    entry.totalPence += Number(d.amountPence) || 0;
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Given the monthly breakdown, find the quietest and busiest months.
// "Quietest" = fewest decisions (ties broken by lowest total amount).
// "Busiest" = most decisions (ties broken by highest total amount).
// Returns null when there are no months to compare.
function findExtremes(months) {
  if (!months.length) return { quietestMonth: null, busiestMonth: null };

  let quietest = months[0];
  let busiest = months[0];
  for (const m of months) {
    if (m.count < quietest.count || (m.count === quietest.count && m.totalPence < quietest.totalPence)) {
      quietest = m;
    }
    if (m.count > busiest.count || (m.count === busiest.count && m.totalPence > busiest.totalPence)) {
      busiest = m;
    }
  }

  return {
    quietestMonth: {
      month: quietest.month,
      count: quietest.count,
      totalPence: quietest.totalPence,
      total: toPounds(quietest.totalPence),
    },
    busiestMonth: {
      month: busiest.month,
      count: busiest.count,
      totalPence: busiest.totalPence,
      total: toPounds(busiest.totalPence),
    },
  };
}

// GET /api/safety-retro — a retrospective over spending decisions, the limits
// in force, and the payees that dominate by total amount.
router.get('/', (req, res) => {
  // If the safety module has not been migrated, return empty gracefully.
  if (!tableExists('safety_decisions') || !tableExists('safety_limits')) {
    return res.json({
      decisions: [],
      limits: [],
      payees: [],
      quietestMonth: null,
      busiestMonth: null,
      totalDecisions: 0,
      totalAmount: 0,
    });
  }

  const decisionRows = db.prepare(
    'SELECT * FROM safety_decisions ORDER BY at DESC LIMIT 50'
  ).all();
  const decisions = decisionRows.map(shapeDecision);

  const limitRows = db.prepare(
    'SELECT * FROM safety_limits ORDER BY set_at DESC'
  ).all();
  const limits = limitRows.map(shapeLimit);

  // Top payees by total amount. amount_pence may be NULL for rows where no
  // amount was offered; those are excluded from the sum but counted.
  const payeeRows = db.prepare(
    'SELECT payee, SUM(amount_pence) as total, COUNT(*) as count ' +
    'FROM safety_decisions GROUP BY payee ORDER BY total DESC LIMIT 10'
  ).all();
  const payees = payeeRows
    .filter((r) => r.payee != null)
    .map((r) => ({
      payee: r.payee,
      total: toPounds(r.total),
      totalPence: r.total || 0,
      count: r.count,
    }));

  const months = groupByMonth(decisions);
  const extremes = findExtremes(months);

  const totalDecisions = decisions.length;
  const totalAmount = toPounds(
    decisions.reduce((sum, d) => sum + (Number(d.amountPence) || 0), 0)
  );

  res.json({
    decisions,
    limits,
    payees,
    quietestMonth: extremes.quietestMonth,
    busiestMonth: extremes.busiestMonth,
    totalDecisions,
    totalAmount,
  });
});

module.exports = router;