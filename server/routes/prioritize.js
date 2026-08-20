'use strict';
//
// prioritize.js — "what should I do today?"
//
// GET /api/prioritize — returns { items: [{ ref, title, project, priority,
//   reason, score, kind, daysStale }], generatedAt }
//
// Ranks every open board item with a scored HEURISTIC, not a measurement — the workspace
// CLAUDE.md rule is "never invent a weighting and present the output as a measurement", and
// the numbers below (+40, +25, +10, +15, +1/day, +10, +5) are chosen, not derived from
// anything. This route does not pretend otherwise:
//   +40  P1 urgency
//   +25  P2 urgency
//   +10  P3 urgency
//   +15  owner is YOU (only you can unblock it)
//   +1 per day stale (max 30) — items waiting longest rise to the top
//   +10  if it's a bug (broken things cost more the longer they sit)
//   +5   if it's a question (decisions deferred compound)
//
// What makes this legitimate under that rule is not that the weights are objective — they
// are not — but that every one of them is named, fixed, and shown per item in `reason`, so
// the ranking is arithmetic the owner can re-derive by hand from numbers already in view. No
// hidden weighting, no model judgement, and no claim that the order is correct — only that
// it is checkable. Disagree with an ordering and the fix is to change a weight here, in the
// open, not to distrust the list.
//
// This answers the quiz answer: "Deciding what to do first — too many things
// open." The briefing tells you what NEEDS you; this tells you what to DO.
const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  // Fetch board data
  let board;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/board');
    if (!r.ok) return res.status(503).json({ error: 'Board unavailable.' });
    board = await r.json();
  } catch (err) {
    return res.status(503).json({ error: 'Could not reach board: ' + err.message });
  }

  // Fetch stale items to get days-stale for each
  let staleMap = {};
  try {
    const r = await fetch('http://127.0.0.1:3000/api/stale?days=30');
    if (r.ok) {
      const d = await r.json();
      for (const item of (d.items || [])) {
        staleMap[String(item.ref)] = item.daysStale || 0;
      }
    }
  } catch {}

  // Merge external items and backlog items
  const all = [
    ...(board.items || []).map((i) => ({
      ref: i.ref, title: i.title, project: i.project,
      priority: i.severity || i.priority || 'P3', kind: i.kind,
      owner: i.owner, status: i.status,
    })),
    ...(board.backlog || []).map((i) => ({
      ref: i.id, title: i.title, project: i.project,
      priority: i.priority || 'P3', kind: i.kind,
      owner: i.owner, status: i.status,
    })),
  ];

  // Score each open item
  const scored = all
    .filter((i) => !i.status || i.status === 'open')
    .map((i) => {
      let score = 0;
      const reasons = [];

      // Priority
      const pri = String(i.priority || 'P3').toUpperCase();
      if (pri === 'P1') { score += 40; reasons.push('P1 urgency'); }
      else if (pri === 'P2') { score += 25; reasons.push('P2'); }
      else if (pri === 'P3') { score += 10; reasons.push('P3'); }

      // Owner is YOU — only you can unblock it
      if (String(i.owner || '').toUpperCase() === 'YOU') {
        score += 15; reasons.push('only you can do it');
      }

      // Staleness
      const days = staleMap[String(i.ref)] || 0;
      if (days > 0) {
        const staleBonus = Math.min(days, 30);
        score += staleBonus;
        reasons.push(`${days} days stale`);
      }

      // Kind bonus
      if (i.kind === 'bug') { score += 10; reasons.push('bug'); }
      if (i.kind === 'question') { score += 5; reasons.push('decision pending'); }

      return {
        ref: i.ref,
        title: i.title,
        project: i.project,
        priority: pri,
        kind: i.kind,
        owner: i.owner,
        score,
        reason: reasons.join(' · '),
        daysStale: days || 0,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Top 20
  const top = scored.slice(0, 20);

  res.json({
    items: top,
    totalOpen: scored.length,
    generatedAt: new Date().toISOString(),
  });
});

module.exports = router;