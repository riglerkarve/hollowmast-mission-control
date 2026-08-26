'use strict';
const express = require('express');
const db = require('../db');

// VIABILITY — the venture-viability calculator. M128: unit cost, fixed costs, break-even
// volume, built once as a Mission Control module rather than a bespoke spreadsheet per
// venture. dropshipping/CLAUDE.md and print-shop/CLAUDE.md independently landed on the
// identical first step in near-identical words, so every future business idea gets the
// same before-you-spend discipline for free.
//
// One table, one derivation, the same shape as goals.js: nothing below is stored except
// the three numbers you actually typed. Margin, break-even volume and every sentence about
// them are recomputed on every read, so there is nowhere for a stale figure to hide.
//
//   unit margin   = price - unit cost, only once BOTH are set
//   break-even    = fixed costs / unit margin, only once the margin is POSITIVE
//
// A negative or zero margin is not a bigger break-even number — it is "no volume fixes
// this", and the module says that in words rather than printing Infinity or a negative
// unit count that reads as a typo. A missing input is not a zero either: an unset price
// reads "not set", never blank and never as if it were free.

const router = express.Router();

db.migrate('viability', [
  (d) => {
    d.exec(`
      CREATE TABLE viability_scenarios (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        venture            TEXT NOT NULL,      -- free text: which business idea this belongs to
        title              TEXT NOT NULL,      -- this scenario within the venture, e.g. 'Launch price'
        unit_price_pence   INTEGER,            -- what you sell one unit for; NULL = not set
        unit_cost_pence    INTEGER,            -- what one unit costs you (materials, fees); NULL = not set
        fixed_costs_pence  INTEGER,            -- fixed costs this venture needs to clear; NULL = not set
        -- 'one-off' | 'monthly'; what the fixed-costs figure covers. NULL until you say.
        fixed_period       TEXT,
        note               TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX idx_viability_venture ON viability_scenarios(venture);
    `);
  },
]);

// ---------------------------------------------------------------------------- helpers
const FIXED_PERIODS = ['one-off', 'monthly'];

const safe = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(500).json({ failed: true, error: err.message });
  }
};

// Pounds in, integer pence out. '' / null / undefined all mean "not set" — clearing a
// figure back to unknown has to be as easy as typing it was, same rule as goals.js.
function toPence(value) {
  if (value === undefined || value === null || value === '') return { ok: true, pence: null };
  const pence = Math.round(Number(value) * 100);
  if (!Number.isFinite(pence) || pence < 0) return { ok: false };
  return { ok: true, pence };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------- derivation
function derive(row) {
  const price = row.unit_price_pence;
  const cost = row.unit_cost_pence;
  const fixed = row.fixed_costs_pence;

  const hasPrice = price !== null && price !== undefined;
  const hasCost = cost !== null && cost !== undefined;
  const hasFixed = fixed !== null && fixed !== undefined;

  const unitMarginPence = (hasPrice && hasCost) ? price - cost : null;
  const marginPct = (unitMarginPence !== null && hasPrice && price > 0)
    ? Math.round((unitMarginPence / price) * 1000) / 10   // one decimal place
    : null;
  const losesPerUnit = unitMarginPence !== null && unitMarginPence <= 0;

  let breakEvenUnits = null;
  if (unitMarginPence !== null && !losesPerUnit && hasFixed) {
    breakEvenUnits = Math.ceil(fixed / unitMarginPence);
  }

  // One sentence, composed here so there is exactly one wording and one owner of it —
  // the same discipline goals.js uses for "what do I do next".
  let sentence;
  if (!hasPrice || !hasCost) {
    const missing = [!hasPrice && 'a unit price', !hasCost && 'a unit cost'].filter(Boolean).join(' and ');
    sentence = `Set ${missing} to see the margin on one unit.`;
  } else if (losesPerUnit) {
    const perUnit = unitMarginPence === 0 ? 'breaks even' : `loses ${Math.abs(unitMarginPence) / 100}`;
    sentence = unitMarginPence === 0
      ? 'Price equals unit cost — this breaks even on the unit itself, before a single fixed cost is covered. No volume makes that better; only a price or cost change does.'
      : `This loses £${(Math.abs(unitMarginPence) / 100).toFixed(2)} on every unit sold at these numbers. No volume fixes that — raise the price or cut the unit cost first.`;
  } else if (!hasFixed) {
    sentence = `Margin is £${(unitMarginPence / 100).toFixed(2)} per unit (${marginPct}%). Set fixed costs to see the break-even volume.`;
  } else {
    const period = row.fixed_period === 'monthly' ? ' a month' : '';
    sentence = `Break even at ${plural(breakEvenUnits, 'unit')}${period} against £${(fixed / 100).toFixed(2)} in fixed costs, `
      + `at £${(unitMarginPence / 100).toFixed(2)} margin per unit.`;
  }

  return {
    id: row.id,
    venture: row.venture,
    title: row.title,
    unitPricePence: price,
    unitCostPence: cost,
    fixedCostsPence: fixed,
    fixedPeriod: row.fixed_period,
    note: row.note,
    createdAt: row.created_at,

    unitMarginPence,
    marginPct,
    losesPerUnit,
    breakEvenUnits,
    sentence,
  };
}

// ---------------------------------------------------------------------------- read
router.get('/', safe((req, res) => {
  const ventureFilter = req.query.venture ? String(req.query.venture) : null;

  const all = db.prepare('SELECT * FROM viability_scenarios ORDER BY venture, id').all();
  const rows = ventureFilter ? all.filter((r) => r.venture === ventureFilter) : all;
  const scenarios = rows.map(derive);

  // Grouped by venture, because the whole point of this module is one calculator reused
  // across ideas — a flat list would make you re-scan the venture column on every row.
  // Derived here, not stored, so this can never disagree with the flat list above it.
  const byVenture = new Map();
  for (const s of scenarios) {
    if (!byVenture.has(s.venture)) byVenture.set(s.venture, []);
    byVenture.get(s.venture).push(s);
  }
  const ventures = Array.from(byVenture.entries()).map(([name, list]) => ({
    venture: name,
    count: list.length,
    scenarios: list,
  }));

  const withBreakEven = scenarios.filter((s) => s.breakEvenUnits !== null).length;
  const losingMoney = scenarios.filter((s) => s.losesPerUnit).length;
  const missingInputs = scenarios.filter((s) => s.unitMarginPence === null).length;

  const payload = {
    ventures,
    scenarios,
    counts: {
      total: scenarios.length,
      distinctVentures: byVenture.size,
      withBreakEven,
      losingMoney,
      missingInputs,
    },
  };

  if (!scenarios.length) {
    // Empty is a named state, not a blank screen — the same rule board.js and goals.js
    // hold: an empty table and a failed read must never render the same.
    return res.json({
      ...payload,
      state: 'empty',
      message: ventureFilter
        ? `No scenarios for "${ventureFilter}".`
        : 'No scenarios yet. Add one and give it a price and a unit cost — the break-even volume is worked out from them.',
    });
  }
  res.json({ ...payload, state: 'ok' });
}));

router.get('/:id', safe((req, res) => {
  const row = db.prepare('SELECT * FROM viability_scenarios WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'no such scenario' });
  res.json({ state: 'ok', scenario: derive(row) });
}));

// ---------------------------------------------------------------------------- write
router.post('/', safe((req, res) => {
  const { venture, title, unitPrice, unitCost, fixedCosts, fixedPeriod, note } = req.body || {};
  if (!String(venture || '').trim()) return res.status(400).json({ error: 'venture is required' });
  if (!String(title || '').trim()) return res.status(400).json({ error: 'title is required' });
  if (fixedPeriod && !FIXED_PERIODS.includes(fixedPeriod)) {
    return res.status(400).json({ error: `fixedPeriod must be one of ${FIXED_PERIODS.join(', ')}` });
  }

  const price = toPence(unitPrice);
  const cost = toPence(unitCost);
  const fixed = toPence(fixedCosts);
  if (!price.ok) return res.status(400).json({ error: 'unitPrice must be a non-negative number of pounds, or empty for "not set"' });
  if (!cost.ok) return res.status(400).json({ error: 'unitCost must be a non-negative number of pounds, or empty for "not set"' });
  if (!fixed.ok) return res.status(400).json({ error: 'fixedCosts must be a non-negative number of pounds, or empty for "not set"' });

  const info = db.prepare(
    `INSERT INTO viability_scenarios
       (venture, title, unit_price_pence, unit_cost_pence, fixed_costs_pence, fixed_period, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(String(venture).trim(), String(title).trim(), price.pence, cost.pence, fixed.pence, fixedPeriod || null, note || null);

  const row = db.prepare('SELECT * FROM viability_scenarios WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ state: 'ok', scenario: derive(row) });
}));

router.patch('/:id', safe((req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const sets = [];
  const args = [];

  if ('venture' in body) {
    if (!String(body.venture || '').trim()) return res.status(400).json({ error: 'venture cannot be blank' });
    sets.push('venture = ?'); args.push(String(body.venture).trim());
  }
  if ('title' in body) {
    if (!String(body.title || '').trim()) return res.status(400).json({ error: 'title cannot be blank' });
    sets.push('title = ?'); args.push(String(body.title).trim());
  }
  if ('unitPrice' in body) {
    const p = toPence(body.unitPrice);
    if (!p.ok) return res.status(400).json({ error: 'unitPrice must be a non-negative number of pounds, or empty for "not set"' });
    sets.push('unit_price_pence = ?'); args.push(p.pence);
  }
  if ('unitCost' in body) {
    const c = toPence(body.unitCost);
    if (!c.ok) return res.status(400).json({ error: 'unitCost must be a non-negative number of pounds, or empty for "not set"' });
    sets.push('unit_cost_pence = ?'); args.push(c.pence);
  }
  if ('fixedCosts' in body) {
    const f = toPence(body.fixedCosts);
    if (!f.ok) return res.status(400).json({ error: 'fixedCosts must be a non-negative number of pounds, or empty for "not set"' });
    sets.push('fixed_costs_pence = ?'); args.push(f.pence);
  }
  if ('fixedPeriod' in body) {
    if (body.fixedPeriod && !FIXED_PERIODS.includes(body.fixedPeriod)) {
      return res.status(400).json({ error: `fixedPeriod must be one of ${FIXED_PERIODS.join(', ')}` });
    }
    sets.push('fixed_period = ?'); args.push(body.fixedPeriod || null);
  }
  if ('note' in body) { sets.push('note = ?'); args.push(body.note || null); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to change' });

  args.push(id);
  const r = db.prepare(`UPDATE viability_scenarios SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  if (!r.changes) return res.status(404).json({ error: 'no such scenario' });

  const row = db.prepare('SELECT * FROM viability_scenarios WHERE id = ?').get(id);
  res.json({ state: 'ok', scenario: derive(row) });
}));

router.delete('/:id', safe((req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM viability_scenarios WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'no such scenario' });
  res.json({ deleted: id });
}));

// Anything else under /api/viability answers JSON, same reason goals.js gives: without
// this the static handler serves the dashboard's HTML to a fetch expecting JSON.
router.all('*', (req, res) => {
  res.status(404).json({ error: `no such viability endpoint: ${req.method} /api/viability${req.params[0]}` });
});

module.exports = router;
