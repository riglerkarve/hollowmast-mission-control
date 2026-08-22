'use strict';
//
// browsing-recall.js — weekly recall of browsing activity from the
// browsing_domain_days table.
//
// GET /api/browsing-recall — returns the top 20 domains visited in the last
// 7 days, with total visits, total domains, and the day count so the panel
// can label the window. Nothing here derives anything from other sources;
// it reads the table that the browsing tracker already populates.
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT domain, SUM(visits) as visits, MAX(day) as lastVisit
       FROM browsing_domain_days
       WHERE day >= date('now', '-7 days')
       GROUP BY domain
       ORDER BY visits DESC
       LIMIT 20`
    ).all();

    if (!rows.length) {
      return res.json({
        domains: [],
        totalVisits: 0,
        totalDomains: 0,
        days: 7,
        state: 'No browsing data in the last 7 days. This is a real count, not a failed read.',
      });
    }

    const totalVisits = rows.reduce((sum, r) => sum + r.visits, 0);

    // totalDomains is the count of distinct domains in the full window, not
    // just the top 20 — the panel uses it to say "of N domains" accurately.
    const totalRow = db.prepare(
      `SELECT COUNT(DISTINCT domain) as n
       FROM browsing_domain_days
       WHERE day >= date('now', '-7 days')`
    ).get();
    const totalDomains = totalRow ? totalRow.n : rows.length;

    res.json({
      domains: rows.map((r) => ({
        domain: r.domain,
        visits: r.visits,
        lastVisit: r.lastVisit,
      })),
      totalVisits,
      totalDomains,
      days: 7,
    });
  } catch (e) {
    res.json({
      domains: [],
      totalVisits: 0,
      totalDomains: 0,
      days: 7,
      state: `Could not read browsing data — ${e.message}. That is a failure to look, not an empty week.`,
    });
  }
});

module.exports = router;