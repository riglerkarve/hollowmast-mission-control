'use strict';
//
// recurring-costs.js — reads finance_transactions for recurring/subscription patterns.
//
// GET / — returns { items: [{ description, totalPaid, count, lastDate,
//   avgMonthly }], totalMonthly, count }
//
// Groups matching transactions by description, computes total paid, count,
// last paid date, and average monthly cost per group. An empty result is
// reported as empty, not as a failure — the two must never look the same.
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  let rows;
  try {
    rows = db.prepare(
      `SELECT counterparty, reference, amount_pence, date
         FROM finance_transactions
        WHERE counterparty LIKE '%subscription%'
           OR counterparty LIKE '%monthly%'
           OR counterparty LIKE '%recur%'
           OR reference LIKE '%subscription%'
           OR reference LIKE '%monthly%'
           OR reference LIKE '%recur%'
        ORDER BY date DESC LIMIT 100`
    ).all();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!rows.length) {
    return res.json({
      items: [],
      totalMonthly: 0,
      count: 0,
      state: 'No recurring costs found. This is a real query, not a failed read.',
    });
  }

  // Group by description. totalPaid is the sum of every matching transaction;
  // avgMonthly is totalPaid divided by the number of DISTINCT months that
  // contributed a charge, so a charge that landed twice in one month does not
  // read as twice its monthly cost.
  const groups = new Map();
  for (const r of rows) {
    const key = r.counterparty || r.reference || '(unknown)';
    if (!groups.has(key)) {
      groups.set(key, {
        description: key,
        totalPaid: 0,
        count: 0,
        lastDate: r.date,
        months: new Set(),
      });
    }
    const g = groups.get(key);
    g.totalPaid += Number(r.amount_pence) || 0;
    g.count += 1;
    if (r.date > g.lastDate) g.lastDate = r.date;
    g.months.add(String(r.date).slice(0, 7));
  }

  const items = [...groups.values()].map((g) => ({
    description: g.description,
    totalPaid: g.totalPaid,
    totalPaidGBP: (g.totalPaid / 100).toFixed(2),
    count: g.count,
    lastDate: g.lastDate,
    avgMonthly: g.totalPaid / (g.months.size || 1),
    avgMonthlyGBP: (g.totalPaid / (g.months.size || 1) / 100).toFixed(2),
  }));

  // Sort by avgMonthly descending — the most expensive recurring charge first.
  items.sort((a, b) => b.avgMonthly - a.avgMonthly);

  const totalMonthly = items.reduce((s, i) => s + i.avgMonthly, 0);

  res.json({
    items,
    totalMonthly,
    count: items.length,
  });
});

module.exports = router;
