'use strict';
//
// inventory.js — what the business owns, what it is running out of, and what you own.
//
// Owner request, 20 August 2026: "Add inventory control, crm". Asked which of four scopes,
// the answer was "1 2 3" -- business equipment, consumable stock, AND physical possessions.
// So: ONE table with a category, not three modules. They share every field that matters
// (name, what it cost, when) and differ only in what question you ask of them.
//
// THE GATE, AND THE HONEST POSITION ON IT.
// Consumables and possessions are capture. There is nothing in the ledger to seed them from
// -- 6,839 transactions contain no filament, Prusa, Bambu, Elegoo or Creality -- so those
// two categories genuinely are surfaces you feed. That was put to the owner before building
// and he chose all three anyway, which is his call to make.
//
// What stops the module being pure storage is that each category is asked a question it
// cannot answer from what you typed:
//   equipment   -> GET /capital   totals spend per UK tax year for capital allowances,
//                  and /candidates finds likely purchases already in the ledger
//   consumable  -> GET /reorder   tells you what is at or below its own threshold
//   possession  -> GET /value     total, and what is uninsured
//
// If a category ever stops being asked its question, it has become a list, and the gate
// says cut it rather than adding a reminder to feed it.
//
// ENDPOINTS
//   GET    /api/inventory/items?category=      — list, newest first
//   POST   /api/inventory/items                — add
//   PATCH  /api/inventory/items/:id            — edit
//   DELETE /api/inventory/items/:id            — remove
//   POST   /api/inventory/items/:id/use        — consume { quantity } (consumables)
//   POST   /api/inventory/items/:id/restock    — add stock { quantity }
//   GET    /api/inventory/reorder              — consumables at or below threshold
//   GET    /api/inventory/capital              — equipment spend by UK tax year
//   GET    /api/inventory/value                — possessions total and uninsured
//   GET    /api/inventory/candidates           — ledger spend that looks like equipment
//
const express = require('express');
const db = require('../db.js');
const finance = require('./finance.js');
const lifestyle = require('./lifestyle.js');

const router = express.Router();

const CATEGORIES = ['equipment', 'consumable', 'possession'];

db.migrate('inventory', [
  (d) => {
    d.exec(`
      -- ONE table, three categories. The alternative -- three tables -- would have meant
      -- three routes computing "what is this lot worth" and three chances for them to
      -- disagree. Category-specific columns are nullable; the endpoints below never mix
      -- them, because "reorder level" on a printer means nothing.
      CREATE TABLE IF NOT EXISTS inventory_items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        category      TEXT NOT NULL,        -- equipment | consumable | possession
        name          TEXT NOT NULL,
        note          TEXT,

        -- money is PENCE everywhere, with the unit in the name. No total is a float.
        cost_pence    INTEGER,              -- what it cost (equipment, possession)
        acquired_on   TEXT,                 -- YYYY-MM-DD
        supplier      TEXT,                 -- matched against the ledger where possible
        serial        TEXT,
        disposed_on   TEXT,                 -- kept, not deleted: capital allowances need
                                            -- the disposal, not the absence of the row

        -- consumables
        quantity      REAL,                 -- REAL because 0.4 of a spool is a real state
        unit          TEXT,                 -- 'spool', 'kg', 'sheet'
        reorder_at    REAL,                 -- threshold in the same unit

        -- possessions
        location      TEXT,
        insured       INTEGER,              -- 0/1/NULL. NULL means nobody has said, which
                                            -- is different from "not insured".

        created_at    TEXT NOT NULL,
        updated_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inv_category ON inventory_items(category);
      CREATE INDEX IF NOT EXISTS idx_inv_reorder ON inventory_items(category, quantity);
    `);
  },
  // 2 -- food_id. Owner, 20 Aug 2026: "add items ordered to inventory so that when I look
  // at meal planning it can see what i have available."
  //
  // A nullable FK to lifestyle_foods. Nutrition is NOT copied here: lifestyle owns what a
  // food is, inventory owns how much of it is in the house, and the join is how meal
  // planning gets both without either module recomputing the other's figure.
  (d) => {
    const cols = d.prepare("SELECT name FROM pragma_table_info('inventory_items')").all().map((r) => r.name);
    if (!cols.includes('food_id')) d.exec('ALTER TABLE inventory_items ADD COLUMN food_id INTEGER');
    d.exec('CREATE INDEX IF NOT EXISTS idx_inv_food ON inventory_items(food_id)');
  },
]);

// UK tax year runs 6 April to 5 April. Getting this wrong by a day puts a purchase in the
// wrong year's allowance, which is the kind of error nobody finds until an enquiry.
function ukTaxYear(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const beforeApr6 = (d.getUTCMonth() < 3) || (d.getUTCMonth() === 3 && d.getUTCDate() < 6);
  const start = beforeApr6 ? y - 1 : y;
  return start + '/' + String(start + 1).slice(2);
}

function bad(res, msg, extra) {
  return res.status(400).json({ error: msg, ...(extra || {}) });
}

router.get('/items', (req, res) => {
  const cat = req.query.category;
  if (cat && !CATEGORIES.includes(String(cat))) return bad(res, 'category must be one of: ' + CATEGORIES.join(', '));
  const rows = cat
    ? db.prepare('SELECT * FROM inventory_items WHERE category = ? ORDER BY id DESC').all(String(cat))
    : db.prepare('SELECT * FROM inventory_items ORDER BY id DESC').all();
  res.json({
    items: rows, count: rows.length, categories: CATEGORIES,
    by_category: CATEGORIES.reduce((a, c) => (a[c] = rows.filter((r) => r.category === c).length, a), {}),
    state: rows.length === 0 ? 'Nothing recorded yet. This is a real count, not a failed read.' : null,
  });
});

router.post('/items', express.json(), (req, res) => {
  const b = req.body || {};
  const category = String(b.category || '').trim();
  const name = String(b.name || '').trim();
  if (!CATEGORIES.includes(category)) return bad(res, 'category must be one of: ' + CATEGORIES.join(', '));
  if (!name) return bad(res, 'name is required');

  // A consumable with no threshold can never appear in /reorder, so it would sit in the
  // table doing nothing and the module would quietly become a list. Refused, with the
  // reason, rather than accepted and silently useless.
  if (category === 'consumable' && (b.reorder_at === undefined || b.reorder_at === null)) {
    return bad(res, 'reorder_at is required for a consumable',
      { why: 'Without a threshold it can never appear in /reorder, so it would be storage that tells you nothing.' });
  }

  // food_id is accepted here, not only via PATCH. Adding the column without wiring the
  // create path is the defect that already happened once on this project -- kind and
  // project were added to a table in a migration and silently dropped by the route, so
  // the API accepted them and stored nothing.
  const info = db.prepare(
    'INSERT INTO inventory_items (category, name, note, cost_pence, acquired_on, supplier, serial, '
  + 'quantity, unit, reorder_at, location, insured, food_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(category, name, b.note || null,
        b.cost_pence == null ? null : Math.round(Number(b.cost_pence)),
        b.acquired_on || null, b.supplier || null, b.serial || null,
        b.quantity == null ? null : Number(b.quantity), b.unit || null,
        b.reorder_at == null ? null : Number(b.reorder_at),
        b.location || null,
        b.insured == null ? null : (b.insured ? 1 : 0),
        b.food_id == null ? null : Number(b.food_id),
        new Date().toISOString());

  res.json({ ok: true, item: db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/items/:id', express.json(), (req, res) => {
  const row = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such item' });
  const b = req.body || {};
  const fields = ['name', 'note', 'cost_pence', 'acquired_on', 'supplier', 'serial', 'disposed_on',
                  'quantity', 'unit', 'reorder_at', 'location', 'insured', 'food_id'];
  const set = [], vals = [];
  for (const f of fields) if (b[f] !== undefined) { set.push(f + ' = ?'); vals.push(b[f]); }
  if (!set.length) return bad(res, 'nothing to update');
  set.push('updated_at = ?'); vals.push(new Date().toISOString());
  vals.push(row.id);
  db.prepare('UPDATE inventory_items SET ' + set.join(', ') + ' WHERE id = ?').run(...vals);
  res.json({ ok: true, item: db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(row.id) });
});

router.delete('/items/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such item' });
  if (row.category === 'equipment' && row.cost_pence) {
    // Deleting equipment destroys a capital-allowance record. Disposal is a date, not an
    // absence, and the two are not interchangeable to anyone reading it back later.
    return res.status(409).json({
      error: 'equipment with a cost is disposed of, not deleted',
      why: 'Capital allowances need the disposal recorded. Deleting the row loses the purchase too.',
      instead: 'PATCH /api/inventory/items/' + row.id + ' with { "disposed_on": "YYYY-MM-DD" }',
    });
  }
  db.prepare('DELETE FROM inventory_items WHERE id = ?').run(row.id);
  res.json({ ok: true, removed: row.name });
});

function moveStock(req, res, sign) {
  const row = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such item' });
  if (row.category !== 'consumable') return bad(res, 'only consumables have stock levels', { category: row.category });
  const q = Number((req.body || {}).quantity);
  if (!Number.isFinite(q) || q <= 0) return bad(res, 'quantity must be a positive number');
  const before = Number(row.quantity || 0);
  // Clamped at zero: a negative stock level is not a thing that can be true, and letting it
  // go negative would make /reorder report a state that cannot exist.
  const after = Math.max(0, before + sign * q);
  db.prepare('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?')
    .run(after, new Date().toISOString(), row.id);
  const needs = row.reorder_at != null && after <= Number(row.reorder_at);
  res.json({ ok: true, before, after, unit: row.unit,
             needs_reorder: needs,
             clamped: (before + sign * q) < 0 ? 'requested more than was in stock; clamped to 0' : null });
}

router.post('/items/:id/use', express.json(), (req, res) => moveStock(req, res, -1));
router.post('/items/:id/restock', express.json(), (req, res) => moveStock(req, res, +1));

// TELLS YOU: what to buy. The whole justification for the consumable category.
router.get('/reorder', (req, res) => {
  const rows = db.prepare("SELECT * FROM inventory_items WHERE category = 'consumable'").all();
  const withThreshold = rows.filter((r) => r.reorder_at != null && r.quantity != null);
  const low = withThreshold.filter((r) => Number(r.quantity) <= Number(r.reorder_at));
  res.json({
    reorder: low.map((r) => ({ ...r, short_by: Number(r.reorder_at) - Number(r.quantity) })),
    count: low.length,
    // Residue: items that CANNOT be judged are named, not silently excluded. An item with
    // no quantity is not "in stock", it is unmeasured, and the difference matters when the
    // answer is "nothing needs reordering".
    residue: {
      no_threshold_or_quantity: rows.length - withThreshold.length,
      why: 'cannot be judged low without both a quantity and a reorder_at',
    },
    state: rows.length === 0 ? 'No consumables recorded. This is a real count, not a failed read.'
         : low.length === 0 ? 'Nothing at or below its threshold, out of ' + withThreshold.length + ' judgeable item(s).'
         : null,
  });
});

// DERIVES: capital spend per UK tax year, which is the number a self-assessment needs.
router.get('/capital', (req, res) => {
  const rows = db.prepare("SELECT * FROM inventory_items WHERE category = 'equipment'").all();
  const priced = rows.filter((r) => r.cost_pence != null && r.acquired_on);
  const years = {};
  for (const r of priced) {
    const y = ukTaxYear(r.acquired_on);
    if (!y) continue;
    years[y] = years[y] || { tax_year: y, total_pence: 0, items: [] };
    years[y].total_pence += Number(r.cost_pence);
    years[y].items.push({ id: r.id, name: r.name, cost_pence: r.cost_pence, acquired_on: r.acquired_on,
                          disposed_on: r.disposed_on });
  }
  res.json({
    years: Object.values(years).sort((a, b) => b.tax_year.localeCompare(a.tax_year)),
    basis: 'UK tax year, 6 April to 5 April',
    residue: {
      no_cost_or_date: rows.length - priced.length,
      why: 'equipment with no cost_pence or no acquired_on cannot be placed in a tax year',
    },
    // Said plainly, because a total that looks like a tax figure will be treated as one.
    caveat: 'This is a total of what you recorded. It is not a capital allowances claim, and '
          + 'nothing here decides whether an item qualifies or which pool it belongs in.',
  });
});

router.get('/value', (req, res) => {
  const rows = db.prepare("SELECT * FROM inventory_items WHERE category = 'possession'").all();
  const priced = rows.filter((r) => r.cost_pence != null);
  const total = priced.reduce((a, r) => a + Number(r.cost_pence), 0);
  res.json({
    total_pence: total,
    counted: priced.length,
    unpriced: rows.length - priced.length,
    // insured IS NULL is "nobody has said", which is not the same as uninsured. Reported
    // separately so an unanswered question never reads as a settled answer.
    uninsured: rows.filter((r) => r.insured === 0).length,
    insurance_unknown: rows.filter((r) => r.insured == null).length,
    state: rows.length === 0 ? 'No possessions recorded. This is a real count, not a failed read.' : null,
  });
});

// DERIVES: ledger spend that plausibly bought equipment, so the equipment list starts from
// data rather than from memory.
router.get('/candidates', (req, res) => {
  let out;
  try {
    out = finance.counterparties({ direction: 'out', businessOnly: true });
  } catch (e) {
    return res.status(503).json({ error: 'ledger unreadable', why: 'finance.counterparties() failed: ' + e.message });
  }
  const known = new Set(db.prepare('SELECT supplier FROM inventory_items WHERE supplier IS NOT NULL')
    .all().map((r) => r.supplier));
  const minPence = Number(req.query.min_pence || 5000);
  const candidates = out.filter((c) => !known.has(c.counterparty) && c.total_pence >= minPence);
  res.json({
    candidates: candidates.slice(0, 100),
    count: candidates.length,
    shown: Math.min(100, candidates.length),
    // A cap is a biased sample: this keeps the largest, so the tail is invisible. Said, not
    // hidden, because a truncated list reads as a complete one.
    capped: candidates.length > 100 ? 'showing the 100 largest of ' + candidates.length + ' by total spend' : null,
    residue: { below_min: out.filter((c) => c.total_pence < minPence).length, min_pence: minPence,
               already_a_supplier: out.filter((c) => known.has(c.counterparty)).length },
    not_keyed_on: [
      'whether the spend was capital or an expense -- most of this will be consumables and services',
      'individual transaction size; this totals a counterparty over the whole ledger',
    ],
    caveat: 'These are counterparties you paid, not a list of equipment. It is a starting point '
          + 'for recall, not a classification.',
  });
});

// What food is actually in the house, with its nutrition attached.
//
// THE ACCESSOR meal planning calls. It asks lifestyle for the definitions rather than
// reading lifestyle_foods, so if a food's macros are corrected there is exactly one place
// that happens and this reflects it immediately.
function foodInStock(opts) {
  const includeEmpty = !!(opts && opts.includeEmpty);
  const rows = db.prepare(
    "SELECT * FROM inventory_items WHERE category = 'consumable' AND food_id IS NOT NULL"
  ).all();
  const inStock = includeEmpty ? rows : rows.filter((r) => Number(r.quantity || 0) > 0);

  let defs = new Map();
  let defState = null;
  try {
    defs = lifestyle.foodsByIds(inStock.map((r) => r.food_id));
  } catch (e) {
    // Could not look. Must NOT render as 'these foods have no nutrition' -- that is a
    // statement about the food, and this is a statement about the lookup.
    defState = 'COULD NOT READ food definitions from lifestyle: ' + e.message.slice(0, 80);
  }

  return {
    ok: true,
    items: inStock.map((r) => ({
      inventory_id: r.id, name: r.name, quantity: r.quantity, unit: r.unit,
      reorder_at: r.reorder_at, food_id: r.food_id,
      food: defs.get(r.food_id) || null,
      food_state: defState ? defState
        : defs.get(r.food_id) ? 'linked' : 'food_id set but no such food in lifestyle_foods',
    })),
    count: inStock.length,
    // Out-of-stock rows are EXCLUDED by default and counted, not hidden: 'you have no Huel'
    // and 'you never recorded Huel' are different answers to a meal planner.
    residue: { out_of_stock: rows.length - inStock.length },
    definitions_state: defState,
  };
}

router.get('/food', (req, res) => {
  const r = foodInStock({ includeEmpty: req.query.include_empty === '1' });
  res.json({
    ...r,
    state: r.count === 0
      ? 'No food linked to a lifestyle food definition is in stock. This is a real count, not a failed read.'
      : null,
  });
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
module.exports.ukTaxYear = ukTaxYear;

module.exports.foodInStock = foodInStock;