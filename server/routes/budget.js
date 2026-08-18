const express = require('express');
const db = require('../db');
const provenance = require('../provenance');
const finance = require('./finance');
const safety = require('./safety');

// BUDGET, and the wishlist — one module, because a wishlist item IS a proposed budget
// line. Splitting them would mean every affordability figure crossed a module boundary
// for no gain.
//
// It owns no spending figures of its own. Everything about what you actually spent comes
// from finance's accessors, so the two can never disagree — the module contract's rule
// that a figure has exactly one owner, applied in-process.
//
// What it derives, which is the whole point of it existing:
//   - a budget from YOUR OWN 63 months, not a number either of us invented
//   - headroom: what is genuinely uncommitted this month
//   - per wishlist item: affordable now, or how many months of headroom it needs

db.migrate('budget', [
  (d) => {
    d.exec(`
      CREATE TABLE budget_lines (
        category      TEXT PRIMARY KEY,
        monthly_pence INTEGER NOT NULL,
        source        TEXT NOT NULL,       -- 'derived' | 'manual'
        basis         TEXT,                -- how a derived figure was arrived at
        essential     INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE wishlist_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        price_pence INTEGER,
        url         TEXT,
        note        TEXT,
        -- proposed is the default and nothing leaves it without you. This table is the
        -- approval gate, so a row moving to 'approved' must always be your decision.
        status      TEXT NOT NULL DEFAULT 'proposed',
        added_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        decided_at  TEXT
      );

      CREATE INDEX idx_wish_status ON wishlist_items(status);
    `);
  },

  // 2 — business / personal scope. Everything existing becomes 'personal' because that is
  // what the rows were entered as; guessing which of the seven were really business would
  // put an invented judgement into the one table that is supposed to record yours.
  (d) => {
    d.exec(`
      ALTER TABLE wishlist_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal';
      CREATE INDEX idx_wish_scope ON wishlist_items(scope);
    `);
  },

  // Provenance. Default 'unknown' rather than 'you' — see server/provenance.js.
  (d) => {
    provenance.addColumn(d, 'wishlist_items');
  },
]);

const SCOPES = ['personal', 'business'];

// Which categories are things you cannot simply not spend. Used only to compute headroom,
// and every one is overridable — this is a starting point, not a judgement about your life.
const ESSENTIAL_BY_DEFAULT = new Set([
  'Groceries', 'Housing', 'Phone & internet', 'Transport', 'Fuel', 'Fees & charges',
]);

const STATUSES = ['proposed', 'approved', 'bought', 'declined'];
const thisMonth = () => new Date().toISOString().slice(0, 7);

const router = express.Router();

// ---------------------------------------------------------------------------- budget
router.post('/derive', (req, res) => {
  const months = Math.min(24, Math.max(3, Number(req.body && req.body.months) || 12));
  const typical = finance.typicalMonthly(months);

  if (!typical.length) {
    return res.status(400).json({ error: 'no spending history to derive from — import statements first' });
  }

  const ins = db.prepare(
    `INSERT INTO budget_lines (category, monthly_pence, source, basis, essential)
     VALUES (?, ?, 'derived', ?, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_pence = excluded.monthly_pence,
       basis = excluded.basis, updated_at = datetime('now','localtime')
     WHERE budget_lines.source <> 'manual'`      // a figure you set is never re-derived over
  );

  let written = 0;
  try {
    db.withTransaction(() => {
      for (const t of typical) {
        const basis = `median of ${t.monthsConsidered} complete months, present in ${t.monthsPresent}`;
        written += ins.run(t.category, t.medianPence, basis, ESSENTIAL_BY_DEFAULT.has(t.category) ? 1 : 0).changes;
      }
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  res.json({ derivedFromMonths: months, categories: typical.length, written,
    note: 'Median, not mean — one Christmas would drag a mean into a budget you never hit.' });
});

router.put('/lines/:category', (req, res) => {
  const { monthly, essential } = req.body || {};
  const pence = Math.round(Number(monthly) * 100);
  if (!Number.isFinite(pence) || pence < 0) return res.status(400).json({ error: 'monthly must be a non-negative number of pounds' });

  db.prepare(
    `INSERT INTO budget_lines (category, monthly_pence, source, basis, essential)
     VALUES (?, ?, 'manual', 'set by you', ?)
     ON CONFLICT(category) DO UPDATE SET monthly_pence = excluded.monthly_pence,
       source = 'manual', basis = 'set by you', essential = excluded.essential,
       updated_at = datetime('now','localtime')`
  ).run(req.params.category, pence, essential ? 1 : 0);

  res.json({ category: req.params.category, monthlyPence: pence, source: 'manual' });
});

// The state of the month, and the only figure that matters: what is actually uncommitted.
function headroom(month) {
  const lines = db.prepare('SELECT * FROM budget_lines').all();
  const spend = new Map(finance.monthlySpend(month).map((r) => [r.category, r.pence]));
  const income = finance.monthlyIncome(month);

  const rows = lines.map((l) => {
    const spent = spend.get(l.category) || 0;
    return {
      category: l.category,
      budgetPence: l.monthly_pence,
      spentPence: spent,
      remainingPence: l.monthly_pence - spent,
      overspent: spent > l.monthly_pence,
      essential: !!l.essential,
      source: l.source,
      basis: l.basis,
    };
  }).sort((a, b) => b.budgetPence - a.budgetPence);

  // Categories with real spend and no budget line — otherwise they vanish from the view
  // and headroom quietly overstates what is left.
  const unbudgeted = [...spend].filter(([c]) => !lines.some((l) => l.category === c))
    .map(([category, pence]) => ({ category, spentPence: pence }));

  const spentTotal = [...spend.values()].reduce((a, b) => a + b, 0);
  const essentialRemaining = rows.filter((r) => r.essential && r.remainingPence > 0)
    .reduce((s, r) => s + r.remainingPence, 0);

  // HOW COMPLETE IS THIS MONTH? Two separate ways it can be short, and they mean
  // different things:
  //   - the calendar month is not over yet
  //   - the LEDGER stopped before today, because it is an import and not a feed
  // Without this, "Groceries OVER" is 11 days of spending judged against a whole month's
  // budget, and a headroom figure computed from a third of a month reads as a full one.
  const ledgerEnd = db.prepare('SELECT MAX(date) AS d FROM finance_transactions').get().d;
  const today = new Date().toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString().slice(0, 10);
  const coveredTo = ledgerEnd < monthEnd ? ledgerEnd : monthEnd;
  const daysInMonth = Number(monthEnd.slice(8, 10));
  const daysCovered = coveredTo.slice(0, 7) === month ? Number(coveredTo.slice(8, 10)) : daysInMonth;

  return {
    month,
    coverage: {
      complete: daysCovered >= daysInMonth,
      daysCovered,
      daysInMonth,
      ledgerEndsOn: ledgerEnd,
      staleByDays: Math.max(0, Math.round((new Date(today) - new Date(ledgerEnd)) / 86400000)),
      // Stated rather than applied. Scaling the budget down to match would invent a
      // figure; saying what fraction is covered lets you read the comparison correctly.
      note: daysCovered >= daysInMonth
        ? 'Full month.'
        : `Only ${daysCovered} of ${daysInMonth} days are covered — the ledger ends ${ledgerEnd}. `
          + 'Budgets below are whole-month figures, so anything not yet "over" may still get there.',
    },
    incomePence: income,
    spentPence: spentTotal,
    unbudgetedSpendPence: unbudgeted.reduce((s, u) => s + u.spentPence, 0),
    essentialRemainingPence: essentialRemaining,
    // Uncommitted = what came in, less what has gone, less the essentials still to come.
    headroomPence: income - spentTotal - essentialRemaining,
    lines: rows,
    unbudgeted,
  };
}

router.get('/', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : thisMonth();
  const h = headroom(month);
  if (!h.lines.length) {
    // Empty and broken must not read the same.
    return res.json({ ...h, state: 'no-budget', message: 'No budget lines yet. POST /api/budget/derive to build one from your own history.' });
  }
  res.json({ ...h, state: 'ok' });
});

// ---------------------------------------------------------------------------- wishlist
router.get('/wishlist', (req, res) => {
  const month = thisMonth();
  const h = headroom(month);
  const scopeFilter = SCOPES.includes(req.query.scope) ? req.query.scope : null;
  const all = db.prepare('SELECT * FROM wishlist_items ORDER BY status, price_pence DESC').all();
  const items = scopeFilter ? all.filter((i) => i.scope === scopeFilter) : all;

  // The derived part. A wishlist that only lists things is the surface the gate rejects;
  // what makes it worth having is this answer.
  const monthlyHeadroom = h.headroomPence;

  // Anything already approved is money you have decided to spend. It comes off the
  // headroom before anything else is judged affordable — otherwise six items each
  // "affordable this month" can total double what exists, which is exactly the failure
  // an approval gate is supposed to prevent.
  const approvedPence = items.filter((i) => i.status === 'approved')
    .reduce((s, i) => s + (i.price_pence || 0), 0);
  const remainingPence = monthlyHeadroom - approvedPence;

  const decorated = items.map((i) => {
    const price = i.price_pence;
    if (price == null) return { ...i, affordability: 'no price set' };
    if (i.status === 'bought' || i.status === 'declined') return { ...i, affordability: i.status };
    if (i.status === 'approved') return { ...i, affordability: 'approved — counted against headroom' };
    if (remainingPence <= 0) {
      return { ...i, affordability: approvedPence > 0
        ? 'nothing left once approved items are counted' : 'nothing uncommitted this month', monthsNeeded: null };
    }
    if (price <= remainingPence) return { ...i, affordability: 'fits in what is left', monthsNeeded: 0 };
    return { ...i, affordability: 'needs saving', monthsNeeded: Math.ceil(price / monthlyHeadroom) };
  });

  // What would happen if you said yes to everything still waiting. A total is the only
  // way to see that a set of individually affordable things is not collectively affordable.
  const proposedPence = items.filter((i) => i.status === 'proposed')
    .reduce((s, i) => s + (i.price_pence || 0), 0);

  // Per-scope subtotals. Note what this deliberately does NOT do: it does not compute a
  // separate business headroom. You are a sole trader, so there is no second wallet — the
  // money is one pot and a per-purse headroom would invent a separation the law does not
  // grant. Both scopes are therefore judged against the SAME headroom above, and the split
  // is here to answer "how much of what I want is for the business", which is a real
  // question with an honest answer.
  const byScope = {};
  for (const s of SCOPES) {
    const inScope = all.filter((i) => i.scope === s);
    byScope[s] = {
      count: inScope.length,
      proposedCount: inScope.filter((i) => i.status === 'proposed').length,
      proposedPence: inScope.filter((i) => i.status === 'proposed').reduce((t, i) => t + (i.price_pence || 0), 0),
      approvedPence: inScope.filter((i) => i.status === 'approved').reduce((t, i) => t + (i.price_pence || 0), 0),
    };
  }

  // Context for the business scope, asked of finance rather than computed here — finance
  // owns every ledger figure. This is why the business list is not judged separately: if
  // the purse has taken nothing in for months, a "business headroom" would be a constant
  // zero, which teaches you to ignore the panel rather than telling you anything.
  const bus = finance.accountKindSummary('business', { months: 12 });

  res.json({
    month,
    headroomPence: monthlyHeadroom,
    byScope,
    businessPurse: {
      ...bus,
      note: bus.transactions === 0
        ? 'No business-account activity in the last 12 months of the ledger.'
        : `${bus.transactions} transactions in the last 12 months; last activity ${bus.lastActivity}.`,
      whyNotSeparate: 'Sole trader — one pot. Business items are judged against the same '
        + 'headroom as personal ones. This purse is shown so you can see what the business '
        + 'side is actually doing, not as a second budget to spend against.',
    },
    approvedPence,
    remainingPence,
    proposedPence,
    allProposedFit: proposedPence <= remainingPence,
    overBy: proposedPence > remainingPence ? proposedPence - remainingPence : 0,
    // Said explicitly, because "you could afford this in 3 months" is a projection and
    // must show what it rests on rather than appearing as a fact.
    basis: 'Months needed assumes this month\'s headroom repeats. It is arithmetic on one month, not a forecast.',
    totalProposedPence: items.filter((i) => i.status === 'proposed').reduce((s, i) => s + (i.price_pence || 0), 0),
    items: decorated,
  });
});

router.post('/wishlist', (req, res) => {
  const { name, price, url, note, scope } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name is required' });
  if (scope && !SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of ${SCOPES.join(', ')}` });
  const pence = price === undefined || price === null || price === '' ? null : Math.round(Number(price) * 100);
  if (pence !== null && (!Number.isFinite(pence) || pence < 0)) return res.status(400).json({ error: 'price must be a non-negative number of pounds' });

  const info = db.prepare('INSERT INTO wishlist_items (name, price_pence, url, note, scope, by_whom) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(name).trim(), pence, url || null, note || null, scope || 'personal', req.by);
  res.status(201).json({ id: Number(info.lastInsertRowid), status: 'proposed', scope: scope || 'personal' });
});

// THE PROPOSITION — backlog #28. What you need in front of you before you decide, and
// nothing more. It prepares; it does not buy, and there is no code path here that could.
//
// TWO THINGS IT DELIBERATELY DOES NOT DO.
//
// It does not call safety.check(). That function RECORDS every call, so consulting the
// guard just to draw a screen would fill your audit log with refusals generated by
// looking. Viewing a proposition is not asking permission, so it reads safety.limits()
// and compares — the guard is asked only when something actually seeks authorisation.
//
// It does not invent an urgency. "Cost of waiting" is reported as the number of months of
// headroom the item needs and nothing else: no ledger figure prices the delay itself, and
// a manufactured "act now" is the one thing that would make this untrustworthy.
router.get('/wishlist/:id/proposition', (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM wishlist_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'no such item' });

  const month = thisMonth();
  const h = headroom(month);
  const all = db.prepare('SELECT * FROM wishlist_items').all();
  const approvedPence = all.filter((i) => i.status === 'approved').reduce((s, i) => s + (i.price_pence || 0), 0);
  const remainingPence = h.headroomPence - approvedPence;
  const price = item.price_pence;

  const fitsNow = price != null && price <= remainingPence;
  const remainingAfterPence = price == null ? remainingPence : remainingPence - price;

  // WHAT IT DISPLACES. The figure the per-item view cannot show: approving this changes
  // what else is still affordable, and six things each "affordable on their own" is how a
  // wishlist quietly commits double what exists.
  const others = all.filter((i) => i.id !== id && i.status === 'proposed' && i.price_pence != null);
  const displaces = others
    .filter((i) => i.price_pence <= remainingPence && i.price_pence > remainingAfterPence)
    .map((i) => ({ id: i.id, name: i.name, pricePence: i.price_pence }))
    .sort((a, b) => b.pricePence - a.pricePence);

  // The guard's view, as INFORMATION. It governs what this system may ever authorise on
  // its own — it is not a limit on what YOU may buy, and it must never read as one.
  const L = safety.limits();
  const perTxn = L.per_transaction_pence.pence;
  const withinAutomatable = perTxn > 0 && price != null && price <= perTxn;

  res.json({
    state: 'ok',
    item: { id: item.id, name: item.name, pricePence: price, scope: item.scope, status: item.status, note: item.note },
    month,
    cost: { pricePence: price, priceKnown: price != null },
    budgetFit: {
      headroomPence: h.headroomPence,
      approvedPence,
      remainingPence,
      fitsNow,
      remainingAfterPence,
      monthsNeeded: price == null || h.headroomPence <= 0 || fitsNow ? null : Math.ceil(price / h.headroomPence),
      coverageComplete: h.coverage.complete,
      basis: `Headroom is income less what has gone less the essentials still to come, for ${month}. `
        + `${h.coverage.note} Approved items are subtracted first, so this is what is genuinely left.`,
    },
    costOfWaiting: {
      months: price == null || fitsNow || h.headroomPence <= 0 ? null : Math.ceil(price / h.headroomPence),
      note: 'Months of headroom needed, and nothing else. No figure in the ledger prices the '
        + 'delay itself, so this does not manufacture an urgency it cannot support.',
    },
    displaces,
    displacesNote: displaces.length
      ? 'These currently fit in what is left and would not after approving this one.'
      : 'Nothing else currently proposed stops fitting because of this.',
    safety: {
      limitsSet: L.per_transaction_pence.pence > 0 && L.per_month_pence.pence > 0,
      perTransactionPence: perTxn,
      perMonthPence: L.per_month_pence.pence,
      withinAutomatable,
      meaning: withinAutomatable
        ? 'Within the ceiling this system may ever authorise by itself.'
        : 'Above the ceiling this system may authorise by itself, so it could only ever reach you as a proposal. '
          + 'That is not a limit on what you may buy — it is a limit on what anything here may do without you.',
    },
    // Stated in the payload, not just the UI, so a future caller cannot miss it.
    nothingHereBuys: 'This is preparation. Approving records your decision. Nothing in this '
      + 'codebase can move money, and no payment details are ever entered by it.',
  });
});

router.post('/wishlist/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });

  const r = db.prepare(
    `UPDATE wishlist_items SET status = ?, decided_at = datetime('now','localtime') WHERE id = ?`
  ).run(status, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such item' });

  // Approving is a decision, never a purchase. Nothing in this codebase can spend money,
  // and this endpoint is the closest thing to it — so it says so in its own response.
  res.json({
    id: Number(req.params.id),
    status,
    note: status === 'approved'
      ? 'Approved means you have decided to buy it. Nothing here buys anything — you do that yourself.'
      : undefined,
  });
});

// Scope is a correction, not a decision, so unlike /status it does not stamp decided_at:
// moving an item to 'business' says what it is FOR, not that anything has been settled.
router.post('/wishlist/:id/scope', (req, res) => {
  const { scope } = req.body || {};
  if (!SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of ${SCOPES.join(', ')}` });
  const r = db.prepare('UPDATE wishlist_items SET scope = ? WHERE id = ?').run(scope, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such item' });
  res.json({ id: Number(req.params.id), scope });
});

router.delete('/wishlist/:id', (req, res) => {
  const r = db.prepare('DELETE FROM wishlist_items WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such item' });
  res.json({ deleted: Number(req.params.id) });
});

// Published for the daily triggers, so nothing else has to read budget_lines to find out
// whether a category has gone over. Returns the breaches only — the caller decides
// whether that is worth interrupting you for, and the module contract keeps the figure
// owned here.
function breaches(month) {
  // Defaulted here rather than at the call site: headroom() binds the month straight into
  // SQL, so an omitted argument reaches the driver as undefined and throws.
  const h = headroom(/^\d{4}-\d{2}$/.test(String(month || '')) ? month : thisMonth());
  return {
    month: h.month,
    headroomPence: h.headroomPence,
    coverageComplete: h.coverage.complete,
    over: (h.lines || [])
      .filter((l) => l.budgetPence > 0 && l.spentPence > l.budgetPence)
      .map((l) => ({
        category: l.category,
        budgetPence: l.budgetPence,
        spentPence: l.spentPence,
        overByPence: l.spentPence - l.budgetPence,
      }))
      .sort((a, b) => b.overByPence - a.overByPence),
  };
}

module.exports = router;
module.exports.breaches = breaches;
