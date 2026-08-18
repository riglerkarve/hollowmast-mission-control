const express = require('express');
const db = require('../db');

// This module owns these tables and their migrations. Append-only: never edit a shipped
// migration, add the next one. See ARCHITECTURE.md.
db.migrate('finance', [
  // v1 — accounts, transactions, and the deterministic rules table.
  (d) => {
    d.exec(`
      CREATE TABLE finance_accounts (
        id         TEXT PRIMARY KEY,          -- 'starling-personal'
        label      TEXT NOT NULL,
        kind       TEXT NOT NULL,             -- 'personal' | 'business'
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE finance_transactions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT NOT NULL REFERENCES finance_accounts(id),

        -- source file + row ordinal. Re-importing the same export updates rather than
        -- duplicates. Content cannot be the key: 15 of the 4,133 rows in the five-year
        -- Starling history are byte-identical to another row, balance included.
        import_key   TEXT NOT NULL UNIQUE,

        date         TEXT NOT NULL,           -- ISO 8601, always YYYY-MM-DD
        counterparty TEXT NOT NULL,
        reference    TEXT NOT NULL DEFAULT '',
        type         TEXT NOT NULL,           -- FASTER PAYMENT, ATM, CONTACTLESS, ...

        -- Money is INTEGER PENCE, everywhere, forever. A float total of five years of
        -- transactions is wrong by an amount you cannot predict and will not notice.
        amount_pence  INTEGER NOT NULL,
        balance_pence INTEGER,

        -- What the bank called it. Kept as provenance and NEVER treated as our category:
        -- measured over the real history, 41.8% of rows are "PAYMENTS" and 25.8% are
        -- "INCOME", which describe direction and mechanism, not purpose.
        bank_category TEXT,

        category        TEXT,                 -- ours; NULL until decided
        category_source TEXT,                 -- 'rule' | 'model' | 'manual'
        reviewed        INTEGER NOT NULL DEFAULT 0,

        imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX idx_fin_tx_date     ON finance_transactions(date);
      CREATE INDEX idx_fin_tx_cat      ON finance_transactions(category);
      CREATE INDEX idx_fin_tx_cp       ON finance_transactions(counterparty);
      CREATE INDEX idx_fin_tx_review   ON finance_transactions(reviewed) WHERE reviewed = 0;

      -- Deterministic, auditable, and exact. Measured on the real history: keying on
      -- counterparty alone leaves 51.1% of rows unambiguous; adding direction lifts it
      -- to 73.7%, because for a person "PAYMENTS" vs "INCOME" is the sign of the amount.
      CREATE TABLE finance_rules (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        match_type TEXT NOT NULL,             -- 'counterparty_exact' | 'counterparty_contains' | 'reference_contains'
        pattern    TEXT NOT NULL,
        direction  TEXT,                      -- 'in' | 'out' | NULL for either
        category   TEXT NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (match_type, pattern, direction)
      );
    `);
  },

  // v2 — the business flag. Independent of category, because "Argos, business" and
  // "Argos, personal" are the same category and different tax treatment, and folding the
  // split into the category list would double it.
  (d) => {
    d.exec(`
      ALTER TABLE finance_transactions ADD COLUMN business INTEGER;         -- 1 | 0 | NULL unknown
      ALTER TABLE finance_transactions ADD COLUMN business_source TEXT;     -- 'account' | 'rule' | 'manual'
      ALTER TABLE finance_rules ADD COLUMN business INTEGER;                -- a rule may set it too

      CREATE INDEX idx_fin_tx_business ON finance_transactions(business);
    `);

    // The account is the default and the strongest available evidence: money out of the
    // business account is business spending unless someone says otherwise. Recorded as
    // source 'account' so a later manual decision can be told apart from this assumption.
    d.exec(`
      UPDATE finance_transactions
         SET business = CASE WHEN account_id = 'starling-business' THEN 1 ELSE 0 END,
             business_source = 'account'
       WHERE category <> 'Own transfer' OR category IS NULL;
    `);
  },

  // v3 — holdings that are not in the ledger. Backlog #77, and it lives in FINANCE rather
  // than a new module because net worth is a money figure and finance owns those. A
  // separate module would have to read finance_transactions to get the cash half, which
  // the module contract forbids.
  //
  // EVERY ROW CARRIES ITS OWN as_of DATE, and that is the whole design rather than a
  // nicety. A manual figure is true on the day it is typed and decays from then on; a net
  // worth built by summing four figures entered on four different dates is a number with
  // no date at all. So each is dated, staleness is shown per row, and nothing is ever
  // silently carried forward as current.
  (d) => {
    d.exec(`
      CREATE TABLE finance_assets (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        label        TEXT NOT NULL,
        kind         TEXT NOT NULL,           -- 'savings' | 'crypto' | 'investment' | 'owed to me' | 'debt' | 'other'
        amount_pence INTEGER NOT NULL,        -- negative for a debt; integers, like every other money column
        as_of        TEXT NOT NULL,           -- the date YOU say this was true
        note         TEXT,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX idx_fin_assets_kind ON finance_assets(kind);
    `);
  },
]);

const router = express.Router();

const pounds = (pence) => (pence == null ? null : pence / 100);

router.get('/accounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM finance_accounts ORDER BY label').all());
});

// Deliberately paged. Five years is 4,133 rows and a panel that fetches all of them
// teaches you nothing you could not learn from a smaller, faster page.
router.get('/transactions', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const where = [];
  const params = [];
  if (req.query.from) { where.push('date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('date <= ?'); params.push(req.query.to); }
  if (req.query.uncategorised === '1') where.push('category IS NULL');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM finance_transactions ${clause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM finance_transactions ${clause}`).get(...params).c;

  res.json({
    total,
    limit,
    offset,
    transactions: rows.map((r) => ({ ...r, amount: pounds(r.amount_pence), balance: pounds(r.balance_pence) })),
  });
});

// The import summary is the one number the panel shows before anything else: how much of
// the ledger is actually categorised. An empty ledger and a broken importer must not
// produce the same screen, so `imported` is reported separately from `categorised`.
router.get('/summary', (req, res) => {
  const row = db.prepare(
    `SELECT COUNT(*) AS imported,
            COUNT(category) AS categorised,
            SUM(CASE WHEN category IS NULL THEN 1 ELSE 0 END) AS uncategorised,
            -- Only MODEL suggestions await review. A rule is deterministic, auditable and
            -- inspectable in finance_rules; putting its 6,221 rows in a review queue makes
            -- the queue unusable and hides the handful of rows that genuinely need a human.
            SUM(CASE WHEN reviewed = 0 AND category_source = 'model' THEN 1 ELSE 0 END) AS awaiting_review,
            SUM(CASE WHEN category_source = 'rule' THEN 1 ELSE 0 END) AS by_rule,
            SUM(CASE WHEN category_source = 'manual' THEN 1 ELSE 0 END) AS by_hand,
            MIN(date) AS first_date, MAX(date) AS last_date
     FROM finance_transactions`
  ).get();
  res.json(row);
});

// Months that actually have data, newest first. The panel picks its default from this
// rather than from today's date — the ledger is an import and ends when the last
// statement ended, so "this month" and "the latest month with data" are different things.
// The services audit — what is still charging you. Backlog #39.
router.get('/recurring', (req, res) => {
  const min = Math.min(12, Math.max(2, Number(req.query.minCharges) || 3));
  res.json(recurring({ minCharges: min }));
});

router.get('/months', (req, res) => {
  res.json(db.prepare(
    `SELECT substr(date, 1, 7) AS month, COUNT(*) AS n, MAX(date) AS last_day
       FROM finance_transactions GROUP BY month ORDER BY month DESC`
  ).all());
});

// Where the money went. Own transfers are excluded everywhere — with two accounts each
// one appears twice, so including them would inflate the total by nearly a third. Cash is
// reported SEPARATELY rather than as a category of spending, because the ledger genuinely
// does not know what it bought and folding it in would imply otherwise.
router.get('/spending', (req, res) => {
  const account = req.query.account && req.query.account !== 'all' ? req.query.account : null;
  const latest = db.prepare('SELECT MAX(substr(date, 1, 7)) AS m FROM finance_transactions').get().m;
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : latest;

  const prevDate = new Date(`${month}-01T00:00:00Z`);
  prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
  const prev = prevDate.toISOString().slice(0, 7);

  // Is this month complete? If the ledger stops mid-month, comparing 11 days against a
  // full previous month would show a fake collapse in every category. So the comparison
  // is clipped to the same day-of-month on both sides, and the panel is told it is.
  const ledgerEnd = db.prepare('SELECT MAX(date) AS d FROM finance_transactions').get().d;
  const monthEnd = new Date(Date.UTC(prevDate.getUTCFullYear(), prevDate.getUTCMonth() + 2, 0))
    .toISOString().slice(0, 10);
  const partial = ledgerEnd < monthEnd && ledgerEnd.slice(0, 7) === month;
  const throughDay = partial ? Number(ledgerEnd.slice(8, 10)) : 31;

  const spend = (m) => {
    const params = [m];
    let sql = `SELECT category, COUNT(*) n, SUM(-amount_pence) p
                 FROM finance_transactions
                WHERE amount_pence < 0 AND substr(date, 1, 7) = ?
                  AND category IS NOT 'Own transfer'
                  AND CAST(substr(date, 9, 2) AS INTEGER) <= ?`;
    params.push(throughDay);
    if (account) { sql += ' AND account_id = ?'; params.push(account); }
    sql += ' GROUP BY category';
    return db.prepare(sql).all(...params);
  };

  const income = (m) => {
    const params = [m, throughDay];
    let sql = `SELECT SUM(amount_pence) p FROM finance_transactions
                WHERE amount_pence > 0 AND substr(date, 1, 7) = ?
                  AND category IS NOT 'Own transfer'
                  AND CAST(substr(date, 9, 2) AS INTEGER) <= ?`;
    if (account) { sql += ' AND account_id = ?'; params.push(account); }
    return db.prepare(sql).get(...params).p || 0;
  };

  const now = spend(month);
  const was = new Map(spend(prev).map((r) => [r.category, r.p]));

  const CASH = 'Cash withdrawn';
  const categories = now
    .filter((r) => r.category !== CASH)
    .map((r) => ({ category: r.category, n: r.n, pence: r.p, wasPence: was.get(r.category) || 0 }))
    .map((r) => ({ ...r, deltaPence: r.pence - r.wasPence }))
    .sort((a, b) => b.pence - a.pence);

  // A category that dropped to zero disappears from `now` entirely. Reporting only what
  // is present would silently hide the largest possible change there is.
  for (const [cat, p] of was) {
    if (cat !== CASH && !categories.some((c) => c.category === cat)) {
      categories.push({ category: cat, n: 0, pence: 0, wasPence: p, deltaPence: -p });
    }
  }

  const cashNow = now.find((r) => r.category === CASH) || { n: 0, p: 0 };

  // Each account's own last day. The business account stops at 2026-05-31 while the
  // personal one runs to August, so "no spending in August" is true for it and the
  // REASON is that its statements end in May. An empty month and an account with no
  // data yet must not render the same sentence.
  const accountEnd = account
    ? db.prepare('SELECT MAX(date) AS d FROM finance_transactions WHERE account_id = ?').get(account).d
    : ledgerEnd;

  res.json({
    month,
    prev,
    account: account || 'all',
    accountEnd,
    partial,
    throughDay,
    ledgerEnd,
    totalPence: categories.reduce((s, c) => s + c.pence, 0),
    prevTotalPence: categories.reduce((s, c) => s + c.wasPence, 0),
    incomePence: income(month),
    prevIncomePence: income(prev),
    cash: { n: cashNow.n, pence: cashNow.p },
    categories,
  });
});

// ------------------------------------------------------------------------------------
// ITEM 36 — "spot a pattern in income and correctly predict a forecast".
//
// The standing rule is "never present a forecast from thin data". 63 months is not thin,
// so a forecast is defensible — but only for income that is actually REGULAR and still
// ARRIVING. Projecting a contract that ended two years ago would be arithmetic on a
// corpse, and it would look exactly as confident as a real projection.
//
// So each source is tested on two things before it may be projected:
//   regularity  distinct months with a payment / months in its span, inclusive
//   still alive  something arrived within the last 45 days
//
// Everything excluded is reported, with the reason. A forecast that quietly drops
// two-thirds of the history looks far more certain than it is.
// ------------------------------------------------------------------------------------
const MIN_MONTHS = 6;
const MIN_REGULARITY = 0.75;
const ALIVE_DAYS = 45;

function monthsBetween(a, b) {
  const [ay, am] = a.slice(0, 7).split('-').map(Number);
  const [by, bm] = b.slice(0, 7).split('-').map(Number);
  return (by - ay) * 12 + (bm - am) + 1;
}

router.get('/income-outlook', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const sources = db.prepare(
    `SELECT counterparty, COUNT(*) n, COUNT(DISTINCT substr(date,1,7)) months,
            MIN(date) first, MAX(date) last, SUM(amount_pence) total
       FROM finance_transactions
      WHERE amount_pence > 0 AND category IS NOT NULL AND category <> 'Own transfer'
      GROUP BY counterparty`
  ).all();

  const judged = sources.map((s) => {
    const span = monthsBetween(s.first, s.last);
    const regularity = Math.min(1, s.months / span);
    const quietDays = Math.round((new Date(today) - new Date(s.last)) / 86400000);
    const alive = quietDays <= ALIVE_DAYS;

    // The per-month figure is the MEDIAN of months it actually paid — a mean is dragged
    // by a single large arrears payment into a monthly figure that never occurs.
    const perMonth = db.prepare(
      `SELECT SUM(amount_pence) p FROM finance_transactions
        WHERE counterparty = ? AND amount_pence > 0 AND category <> 'Own transfer'
        GROUP BY substr(date,1,7) ORDER BY p`
    ).all(s.counterparty).map((r) => r.p);
    const median = perMonth.length ? perMonth[Math.floor(perMonth.length / 2)] : 0;

    let excluded = null;
    if (s.months < MIN_MONTHS) excluded = `only ${s.months} month(s) of history, needs ${MIN_MONTHS}`;
    else if (regularity < MIN_REGULARITY) excluded = `paid in ${s.months} of ${span} months (${Math.round(regularity * 100)}%), too irregular`;
    else if (!alive) excluded = `nothing for ${quietDays} days — it has stopped`;

    return {
      source: s.counterparty,
      payments: s.n, months: s.months, span,
      regularity: Math.round(regularity * 100),
      first: s.first, last: s.last, quietDays, alive,
      totalPence: s.total, medianMonthlyPence: median,
      projectable: !excluded, excluded,
    };
  }).sort((a, b) => b.totalPence - a.totalPence);

  const projectable = judged.filter((j) => j.projectable);
  const monthlyPence = projectable.reduce((s, j) => s + j.medianMonthlyPence, 0);

  // What the projection leaves out, in money. This is the residue, and it is the number
  // that stops a small forecast reading as a small income.
  const stoppedTotal = judged.filter((j) => !j.projectable).reduce((s, j) => s + j.totalPence, 0);

  res.json({
    generatedAt: today,
    method: {
      regularity: `distinct paying months / months in span, must be at least ${MIN_REGULARITY * 100}%`,
      history: `at least ${MIN_MONTHS} paying months`,
      alive: `something received within ${ALIVE_DAYS} days`,
      perMonth: 'median of the months it actually paid, not the mean — one arrears payment would otherwise set a monthly figure that never occurs',
    },
    projectable: projectable.map((p) => ({ source: p.source, monthlyPence: p.medianMonthlyPence, regularity: p.regularity, months: p.months })),
    projectedMonthlyPence: monthlyPence,
    projectedAnnualPence: monthlyPence * 12,
    excluded: judged.filter((j) => !j.projectable).map((j) => ({ source: j.source, totalPence: j.totalPence, why: j.excluded })),
    excludedHistoricalTotalPence: stoppedTotal,
    caveat: projectable.length
      ? `Projects ${projectable.length} source(s) only. GBP ${(stoppedTotal / 100).toFixed(2)} of historical income comes from sources that have stopped and is deliberately NOT projected.`
      : 'Nothing qualifies. No source is both regular enough and still paying, so there is no forecast to give — which is itself the finding.',
  });
});

router.get('/rules', (req, res) => {
  res.json(db.prepare('SELECT * FROM finance_rules ORDER BY category, pattern').all());
});

// The review queue: model suggestions only, biggest first. A suggestion is a proposal,
// never a decision — nothing here has been accepted.
router.get('/review', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = db.prepare(
    `SELECT id, date, counterparty, reference, type, amount_pence, category
     FROM finance_transactions
     WHERE category_source = 'model' AND reviewed = 0
     ORDER BY ABS(amount_pence) DESC LIMIT ?`
  ).all(limit);
  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM finance_transactions WHERE category_source = 'model' AND reviewed = 0`
  ).get().c;
  res.json({ total, transactions: rows.map((r) => ({ ...r, amount: pounds(r.amount_pence) })) });
});

// Accept a suggestion as-is, or replace it. Either way the row becomes 'manual' and is
// then immune to re-running the rules or the model — a human decision is the top of the
// precedence order, not another input to it.
router.post('/transactions/:id/category', (req, res) => {
  const id = Number(req.params.id);
  const { category } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });

  const known = db.prepare('SELECT 1 FROM finance_rules WHERE category = ? LIMIT 1').get(category);
  if (!category || (!known && category !== 'Other')) {
    return res.status(400).json({ error: `unknown category "${category}"` });
  }

  const r = db.prepare(
    `UPDATE finance_transactions SET category = ?, category_source = 'manual', reviewed = 1 WHERE id = ?`
  ).run(category, id);

  if (!r.changes) return res.status(404).json({ error: 'no such transaction' });
  res.json(db.prepare('SELECT * FROM finance_transactions WHERE id = ?').get(id));
});

// ------------------------------------------------------------------------------------
// Accessors for other modules. The module contract says a module never reads another's
// TABLES — it asks the owner. These are that asking, in-process. Finance remains the one
// owner of every spending figure; budget calls this rather than writing its own SQL, so
// the two can never disagree.
//
// Own transfer is excluded in both, always: with two accounts each transfer appears
// twice, so including it inflates the total by nearly a third.
// ------------------------------------------------------------------------------------

function monthlySpend(month, { includeCash = false } = {}) {
  const exclude = includeCash ? "('Own transfer')" : "('Own transfer', 'Cash withdrawn')";
  return db.prepare(
    `SELECT category, SUM(-amount_pence) AS pence
       FROM finance_transactions
      WHERE amount_pence < 0 AND substr(date, 1, 7) = ?
        AND category IS NOT NULL AND category NOT IN ${exclude}
      GROUP BY category`
  ).all(month);
}

function monthlyIncome(month) {
  return db.prepare(
    `SELECT COALESCE(SUM(amount_pence), 0) AS pence
       FROM finance_transactions
      WHERE amount_pence > 0 AND substr(date, 1, 7) = ?
        AND category IS NOT NULL AND category <> 'Own transfer'`
  ).get(month).pence;
}

// Typical spend per category, as the MEDIAN of the last n complete months. Median, not
// mean: one Christmas or one laptop drags a mean into a budget you would never hit, and
// a budget you cannot hit gets ignored within a fortnight.
function typicalMonthly(months = 12, { includeCash = false } = {}) {
  const exclude = includeCash ? "('Own transfer')" : "('Own transfer', 'Cash withdrawn')";
  const last = db.prepare('SELECT MAX(substr(date, 1, 7)) AS m FROM finance_transactions').get().m;

  // The final month of an import is usually partial and would pull every median down.
  const rows = db.prepare(
    `SELECT substr(date, 1, 7) AS month, category, SUM(-amount_pence) AS pence
       FROM finance_transactions
      WHERE amount_pence < 0 AND category IS NOT NULL AND category NOT IN ${exclude}
        AND substr(date, 1, 7) < ? AND substr(date, 1, 7) >= ?
      GROUP BY month, category`
  ).all(last, `${new Date(new Date(`${last}-01T00:00:00Z`).setUTCMonth(new Date(`${last}-01T00:00:00Z`).getUTCMonth() - months)).toISOString().slice(0, 7)}`);

  const byCat = new Map();
  const monthsSeen = new Set();
  for (const r of rows) {
    monthsSeen.add(r.month);
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r.pence);
  }

  const n = monthsSeen.size;
  return [...byCat].map(([category, vals]) => {
    // A category absent in a month is a ZERO for that month, not a missing sample.
    // Without this, something bought twice a year looks like a monthly commitment.
    const full = [...vals, ...Array(Math.max(0, n - vals.length)).fill(0)].sort((a, b) => a - b);
    return {
      category,
      medianPence: full[Math.floor(full.length / 2)],
      monthsPresent: vals.length,
      monthsConsidered: n,
    };
  }).sort((a, b) => b.medianPence - a.medianPence);
}

// Income, spend and last activity for one ACCOUNT KIND ('personal' | 'business').
//
// Added for the wishlist scope split. It deliberately does NOT return a headroom: for a
// sole trader there is no second wallet, so a per-purse headroom would be a separation
// the law does not grant. This answers "is the business purse actually active", which is
// a fact, and leaves the judgement to the caller.
function accountKindSummary(kind, { months = 12 } = {}) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN t.amount_pence > 0 THEN t.amount_pence END), 0) AS income_pence,
            COALESCE(SUM(CASE WHEN t.amount_pence < 0 THEN -t.amount_pence END), 0) AS spend_pence,
            COUNT(*) AS n,
            MAX(t.date) AS last_activity
       FROM finance_transactions t
       JOIN finance_accounts a ON a.id = t.account_id
      WHERE a.kind = ?
        AND t.category IS NOT NULL AND t.category <> 'Own transfer'
        AND t.date >= date((SELECT MAX(date) FROM finance_transactions), '-' || ? || ' months')`
  ).get(kind, months);

  return {
    kind,
    months,
    incomePence: row.income_pence,
    spendPence: row.spend_pence,
    transactions: row.n,
    // null means no qualifying rows in the window, which is different from £0 of activity
    // in a window that does have rows. The caller must be able to tell those apart.
    lastActivity: row.last_activity,
  };
}

// How far the ledger actually reaches, and how stale it is.
//
// THE LEDGER IS AN IMPORT, NOT A FEED: it ends when the last statement ended. Anything
// that reports "recent" spending has to know that, or an empty window reads as "you spent
// nothing" rather than "not imported yet". asOf defaults to today and is injectable so a
// caller generating a briefing for a past date gets that date's staleness, not today's.
function ledgerSpan(asOf) {
  const r = db.prepare('SELECT MIN(date) a, MAX(date) b, COUNT(*) n FROM finance_transactions').get();
  if (!r || !r.n) return { first: null, last: null, rows: 0, staleDays: null };
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf || '')) ? asOf : new Date().toISOString().slice(0, 10);
  return {
    first: r.a,
    last: r.b,
    rows: r.n,
    staleDays: Math.floor((new Date(ref) - new Date(r.b)) / 86400000),
  };
}

// RECURRING PAYMENTS — the services audit, derived rather than typed. Backlog #39.
//
// It answers one question the ledger can actually answer: WHAT IS STILL CHARGING YOU.
// Nothing here judges what anything is for. It is an inventory, not a verdict.
//
// WHY IT DOES NOT CLAIM A BILLING CYCLE. The obvious version reports "every 30 days" from
// the median gap. Measured on this ledger, Netflix's gaps run 28, 33, 35, 35, 35, 36, 39,
// 41, 42, 43, 47, 49, 51, 164, 927 — median 41, which is not a billing cycle. It is the
// average of a subscription that lapsed twice and resumed. A tidy "every 41 days" would be
// a plausible figure describing nothing real, so the SPREAD is returned beside the median
// and the panel shows both. A wide spread is meant to visibly undermine its own median.
//
// STALENESS IS MEASURED FROM THE LEDGER END, NOT TODAY. The ledger is an import, not a
// feed. Counting from today would add the import lag to every single row and make live
// subscriptions look abandoned.
// WHICH COUNTERPARTIES COUNT AS A SERVICE IS DECIDED BY THE CATEGORY, NOT BY ME.
//
// The first version of this grouped EVERY counterparty by recurrence, and the result was
// useless in an instructive way: Tesco (175 charges) came back as "stopped charging",
// Co-op as "every ~2 days", KFC as "every ~329 days", and several friends appeared as
// services. Shopping recurs, so shops dominate any list built on recurrence alone.
//
// The obvious rescue was a second signal — subscriptions charge a consistent amount. It
// does not separate cleanly either: measured here, Spotify scores 0.00 and Netflix 0.14 on
// median-absolute-deviation over the median, but Google Play scores 0.60 (it is many app
// purchases, not one subscription) and lands among the supermarkets, while repeated
// round-number transfers to a person score 0.34 and land among the services. Any cut-off
// between them would have been a number I chose.
//
// The categoriser already answers "what kind of thing is this", with 108 auditable rules
// covering 95.3% of the ledger. Building a second classifier here would have been a second
// owner for that question. So the category is the gate, and recurrence is only the derived
// fact reported inside it.
const SERVICE_CATEGORIES = ['Subscriptions', 'Phone & internet'];

function recurring({ minCharges = 3, categories = SERVICE_CATEGORIES } = {}) {
  const span = ledgerSpan();
  if (!span.rows) return { state: 'empty', asOf: null, services: [] };

  const cats = Array.isArray(categories) && categories.length ? categories : SERVICE_CATEGORIES;
  const rows = db.prepare(
    `SELECT counterparty, date, -amount_pence AS pence, category
       FROM finance_transactions
      WHERE amount_pence < 0
        AND counterparty IS NOT NULL AND TRIM(counterparty) <> ''
        AND category IN (${cats.map(() => '?').join(',')})
      ORDER BY counterparty, date`
  ).all(...cats);

  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.counterparty)) byName.set(r.counterparty, []);
    byName.get(r.counterparty).push(r);
  }

  const services = [];
  // THE RESIDUE. A counterparty with one or two charges is not yet recurrence and must not
  // be given a median gap — but dropping it silently hides exactly the thing worth seeing:
  // a subscription that started last month. Measured here, the single most recent service
  // charge in the whole ledger was Anthropic, £18.00, ONE charge — invisible under any
  // minimum. So it is reported beside the list rather than filtered into nothing.
  const notEnoughHistory = [];
  for (const [name, charges] of byName) {
    if (charges.length < minCharges) {
      const last = charges[charges.length - 1];
      notEnoughHistory.push({
        name,
        charges: charges.length,
        lastOn: last.date,
        lastPence: last.pence,
        daysSinceLast: Math.round((Date.parse(span.last) - Date.parse(last.date)) / 86400000),
        why: `Only ${charges.length} charge${charges.length === 1 ? '' : 's'} on record, so there is no gap to measure. `
          + 'That is not the same as "not recurring" — a subscription that started recently looks identical.',
      });
      continue;
    }

    const gaps = [];
    for (let i = 1; i < charges.length; i++) {
      gaps.push(Math.round((Date.parse(charges[i].date) - Date.parse(charges[i - 1].date)) / 86400000));
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const medianGap = sorted[Math.floor(sorted.length / 2)];
    const last = charges[charges.length - 1];
    const daysSinceLast = Math.round((Date.parse(span.last) - Date.parse(last.date)) / 86400000);

    // The only inference, and it is one division. Anything past twice its own typical gap
    // has missed at least one charge — that is arithmetic, not a prediction about intent.
    // 'unclear' is a real answer and is not folded into either of the others.
    const status = medianGap <= 0 ? 'unclear'
      : daysSinceLast <= medianGap * 2 ? 'still charging'
        : 'stopped charging';

    services.push({
      name,
      charges: charges.length,
      totalPence: charges.reduce((s, c) => s + c.pence, 0),
      lastPence: last.pence,
      firstOn: charges[0].date,
      lastOn: last.date,
      daysSinceLast,
      medianGapDays: medianGap,
      gapRange: sorted.length ? { min: sorted[0], max: sorted[sorted.length - 1] } : null,
      // Stated so the median can be distrusted where it deserves to be.
      gapsAreRegular: sorted.length > 1 && sorted[sorted.length - 1] <= medianGap * 2,
      categories: [...new Set(charges.map((c) => c.category).filter(Boolean))],
      status,
    });
  }

  services.sort((a, b) => a.daysSinceLast - b.daysSinceLast || b.charges - a.charges);

  return {
    state: 'ok',
    asOf: span.last,
    ledgerStaleDays: span.staleDays,
    minCharges,
    counted: services.length,
    notEnoughHistory: notEnoughHistory.sort((a, b) => a.daysSinceLast - b.daysSinceLast),
    categories: cats,
    basis: `Counterparties in ${cats.join(' and ')} with ${minCharges}+ charges. The CATEGORY decides what counts as a service — those rules already exist and are auditable; recurrence alone would rank supermarkets above subscriptions. `
      + `"Days since last" is measured from the ledger's end (${span.last}), not from today — `
      + 'the ledger is an import, so counting from today would add the import lag to every row. '
      + 'Status is one division: past twice its own median gap means at least one charge was missed. '
      + 'Where the gap range is wide the median is not a billing cycle and should not be read as one.',
    services,
  };
}

// Monthly totals for ONE category, published so another module never has to read
// finance_transactions itself. Returns rows sorted by total, so the caller can take a
// median without re-sorting — and a median is what it should take: one heavy month is not
// a baseline.
function categoryMonthly(category, months = 12) {
  return db.prepare(
    `SELECT substr(date, 1, 7) AS month, SUM(-amount_pence) AS pence, COUNT(*) AS n
       FROM finance_transactions
      WHERE category = ? AND amount_pence < 0
        AND date >= date('now', 'localtime', '-' || ? || ' months')
      GROUP BY month ORDER BY pence`
  ).all(category, months);
}

module.exports = router;
module.exports.recurring = recurring;
module.exports.categoryMonthly = categoryMonthly;
module.exports.monthlySpend = monthlySpend;
module.exports.monthlyIncome = monthlyIncome;
module.exports.typicalMonthly = typicalMonthly;
module.exports.accountKindSummary = accountKindSummary;
module.exports.ledgerSpan = ledgerSpan;

// ------------------------------------------------------------------------- exposure
// WHAT LEAVES THE MACHINE. Backlog #14, whose rationale was the specification: personal
// finance data is ALLOWED to a frontier model and kept under review — and "under review"
// only means something if there is a record rather than an intention.
//
// The distinction that matters and is easy to blur: the LOCAL model does not leave the
// machine. Ollama runs on 127.0.0.1:11434, so sending it a counterparty is not disclosure.
// A frontier model is a different question, and this register keeps them apart rather than
// reporting a comforting single number.
//
// It is a REGISTER, not a monitor. It cannot observe a Claude session reading the ledger in
// conversation — that is the honest gap, and it is stated rather than papered over, because
// a register that looked complete while missing the main route would be worse than none.
const EXPOSURE_ROUTES = [
  {
    id: 'categoriser-local',
    what: 'counterparty, reference, amount_pence',
    to: 'Ollama qwen3.5:9b on 127.0.0.1:11434',
    leavesMachine: false,
    status: 'in use',
    note: 'Local. The data does not leave this computer, so it is not disclosure — but it is '
      + 'listed because "went to a model" and "left the machine" are different facts and the '
      + 'register would be misleading if it only showed one.',
  },
  {
    id: 'briefing-local',
    what: 'category names and movement directions only — never a figure',
    to: 'Ollama qwen3.5:9b on 127.0.0.1:11434',
    leavesMachine: false,
    status: 'in use',
    note: 'The model is barred from emitting a number and a guard enforces it; the numbers in '
      + 'the briefing all come from SQL.',
  },
  {
    id: 'frontier-automated',
    what: 'nothing',
    to: 'any frontier model, by scheduled or automated code',
    leavesMachine: true,
    status: 'NOT IN USE',
    note: 'No scheduled task, script or route in this repo sends finance data to a frontier '
      + 'model. Verified by the offload audit: the only model call sites are briefing.cjs, '
      + 'categorise-model.cjs and llm-probe.cjs, and all three point at 127.0.0.1:11434.',
  },
  {
    id: 'frontier-conversation',
    what: 'whatever is read during a session — descriptors, counterparties, balances',
    to: 'a frontier model, via a Claude Code session',
    leavesMachine: true,
    status: 'in use, and NOT observable from here',
    note: 'This is the real exposure and this register cannot measure it. A session reading '
      + 'the ledger to build a feature sends what it reads. You permitted this on 17 Aug; it '
      + 'is recorded here so the decision is revisited against a stated fact rather than a '
      + 'vague sense of it.',
  },
];

router.get('/exposure', (req, res) => {
  const offMachine = EXPOSURE_ROUTES.filter((r) => r.leavesMachine && r.status.startsWith('in use'));
  res.json({
    state: 'ok',
    routes: EXPOSURE_ROUTES,
    summary: {
      automatedOffMachine: EXPOSURE_ROUTES.filter((r) => r.leavesMachine && r.status === 'NOT IN USE').length,
      offMachineInUse: offMachine.length,
      localOnly: EXPOSURE_ROUTES.filter((r) => !r.leavesMachine).length,
    },
    honest: 'Nothing automated in this repo sends finance data off the machine. The one route '
      + 'that does is a Claude session reading it during work, which this register lists and '
      + 'cannot measure. A register that omitted it would look complete while missing the '
      + 'only path that matters.',
    revisit: 'The permission was given 17 Aug 2026. Re-read this list before renewing it.',
  });
});

module.exports.EXPOSURE_ROUTES = EXPOSURE_ROUTES;

// ------------------------------------------------------------------------- forecast
// INCOME PATTERNS. Backlog #36, whose rationale drew the line and this obeys it:
// "Forecast only what is regular, and show the residual."
//
// The standing rule is never to present a forecast from thin data. 63 months is not thin —
// but thinness was never the only risk. The measured position on 18 Aug:
//
//   Benefits         coefficient of variation 0.226   near-deterministic
//   Income - people  coefficient of variation 1.538   seven times more variable
//
// So benefits are projected and nothing else is. The residual is reported beside it, at its
// full size, so the projection can never be mistaken for total income.
//
// PARTIAL MONTHS ARE EXCLUDED, and this is the trap that would have made it wrong. The
// ledger is an import: its final month is always incomplete. August 2026 shows £394.65 from
// one payment because the data stops on the 11th — including it drags the mean down by about
// £950 and the projection with it, silently and plausibly.
function incomeForecast({ months = 12 } = {}) {
  const span = ledgerSpan();
  if (!span.rows) return { state: 'empty' };

  // A month is complete only if the ledger reaches its final day.
  const lastMonth = span.last.slice(0, 7);
  const rows = db.prepare(
    `SELECT substr(date,1,7) AS month, category, SUM(amount_pence) AS pence, COUNT(*) AS n
       FROM finance_transactions
      WHERE amount_pence > 0 AND category IS NOT NULL AND category <> 'Own transfer'
        AND substr(date,1,7) < ?
        AND date >= date(?, '-' || ? || ' months')
      GROUP BY month, category`
  ).all(lastMonth, span.last, months);

  const byCat = {};
  for (const r of rows) {
    (byCat[r.category] = byCat[r.category] || []).push(r.pence);
  }

  const stat = (v) => {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
    return { mean: Math.round(mean), sd: Math.round(sd), cv: mean ? sd / mean : null, months: v.length };
  };

  // The threshold is stated, not hidden: below it a category is regular enough that a
  // monthly figure means something; above it the mean describes nothing you would recognise.
  const CV_REGULAR = 0.35;

  const projected = [];
  const residual = [];
  for (const [category, v] of Object.entries(byCat)) {
    const s = stat(v);
    // Fewer than 6 complete months is not enough to call anything regular, whatever the CV.
    const regular = s.months >= 6 && s.cv !== null && s.cv <= CV_REGULAR;
    (regular ? projected : residual).push({ category, ...s, regular });
  }

  const projectedTotal = projected.reduce((s, p) => s + p.mean, 0);
  const residualTotal = residual.reduce((s, p) => s + p.mean, 0);

  return {
    state: 'ok',
    completeMonthsUsed: Math.max(0, ...Object.values(byCat).map((v) => v.length)),
    excludedMonth: lastMonth,
    projected,
    residual,
    projectedMonthlyPence: projectedTotal,
    residualMonthlyPence: residualTotal,
    basis: `Only categories with 6+ complete months and a coefficient of variation at or `
      + `below ${CV_REGULAR} are projected. Measured now: Benefits 0.226 (near-deterministic), `
      + 'Income - people 1.538 — seven times more variable, so it is reported as residual and '
      + 'never added to the projection.',
    excludedNote: `${lastMonth} is EXCLUDED because the ledger ends ${span.last}, mid-month. `
      + 'Its partial total would drag the mean down by hundreds of pounds and the projection '
      + 'with it — plausibly, and without erroring.',
    warning: residualTotal > projectedTotal
      ? 'The residual is LARGER than the projection. Most of what arrives is not regular, so '
        + 'the projected figure is a floor at best and must not be read as expected income.'
      : undefined,
  };
}

router.get('/forecast', (req, res) => res.json(incomeForecast()));
module.exports.incomeForecast = incomeForecast;

// ---------------------------------------------------------------------------------------
// NET WORTH — backlog #77. Two halves, deliberately never merged into one undated figure.
//
// THE PROBLEM THIS SHAPE SOLVES. A current-account ledger records FLOW, not holdings. It
// happens to carry a running balance_pence per row, so the cash half IS derivable — but
// only as of the last transaction, which today is 7 days old for the personal account and
// 79 for the business one. Everything else you own is invisible to it entirely.
//
// So: cash is derived and dated from the ledger; anything else is a row you typed, dated
// by you. Both halves are reported with their own as-of date and their own staleness, and
// the total is shown as arithmetic over figures the reader can see rather than as a
// headline that hides four different dates inside it.
const ASSET_KINDS = ['savings', 'crypto', 'investment', 'owed to me', 'debt', 'other'];

const daysSince = (d) => Math.round((Date.now() - new Date(d).getTime()) / 86400000);

function derivedCash() {
  // The closing balance is the balance_pence on each account's most recent row. Summing
  // amount_pence instead would give a different number whenever an import starts partway
  // through an account's life, and there would be no way to tell which was right.
  //
  // ROW_NUMBER, not a correlated subquery. The first version of this asked "is this row the
  // latest for its account?" once per row — 6,839 inner sorts — and took 7.5 SECONDS,
  // enough that a 5s health probe recorded it as unreachable. The window function does one
  // pass. Measured after the change rather than assumed.
  return db.prepare(`
    SELECT id, label, kind, pence, asOf FROM (
      SELECT t.account_id AS id, a.label, a.kind, t.balance_pence AS pence, t.date AS asOf,
             ROW_NUMBER() OVER (PARTITION BY t.account_id ORDER BY t.date DESC, t.id DESC) AS rn
        FROM finance_transactions t
        JOIN finance_accounts a ON a.id = t.account_id
    ) WHERE rn = 1
      ORDER BY kind, label
  `).all().map((r) => ({ ...r, staleDays: daysSince(r.asOf) }));
}

function netWorth() {
  const cash = derivedCash();
  const assets = db.prepare('SELECT * FROM finance_assets ORDER BY as_of DESC, id DESC').all()
    .map((r) => ({ ...r, staleDays: daysSince(r.as_of) }));

  const cashTotal = cash.reduce((a, r) => a + r.pence, 0);
  const assetTotal = assets.reduce((a, r) => a + r.amount_pence, 0);

  // The oldest input dates the whole figure. A total is only as current as its stalest part,
  // and quoting the newest date beside a sum containing a 79-day-old number would be the
  // flattering answer.
  const dates = [...cash.map((c) => c.asOf), ...assets.map((a) => a.as_of)].filter(Boolean).sort();

  return {
    cash,
    assets,
    kinds: ASSET_KINDS,
    cashTotalPence: cashTotal,
    assetTotalPence: assetTotal,
    totalPence: cashTotal + assetTotal,
    asOf: dates.length ? dates[0] : null,
    stalestDays: dates.length ? daysSince(dates[0]) : null,
    // Absence and failure differ, and so do two kinds of absence: no assets recorded is a
    // statement about the RECORD, never about what you own.
    assetsRecorded: assets.length,
    caveat: assets.length
      ? 'The total is only as current as its oldest input, which is why the date shown is the '
        + 'earliest and not the latest. Manual figures are true on the day you typed them.'
      : 'Nothing beyond the bank is recorded, so this is a CASH figure and not a net worth. '
        + 'It says nothing about what you own — only that nothing else has been entered.',
    derivedNote: 'Bank balances come from the running balance on each account\'s last '
      + 'imported transaction. That is the balance on that date, not today\'s.',
  };
}

router.get('/net-worth', (req, res) => res.json(netWorth()));

router.post('/assets', express.json(), (req, res) => {
  const label = String((req.body && req.body.label) || '').trim();
  const kind = String((req.body && req.body.kind) || '').trim();
  const asOf = String((req.body && req.body.asOf) || '').trim();
  const pounds = Number(req.body && req.body.amount);

  if (!label) return res.status(400).json({ error: 'a label is required' });
  if (!ASSET_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${ASSET_KINDS.join(', ')}` });
  if (!Number.isFinite(pounds)) return res.status(400).json({ error: 'amount must be a number' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return res.status(400).json({ error: 'asOf must be YYYY-MM-DD — a figure with no date cannot be aged' });
  if (new Date(asOf).getTime() > Date.now()) return res.status(400).json({ error: 'asOf cannot be in the future' });

  // A debt is stored negative so the total is a plain sum. Storing magnitudes and a sign
  // column would mean every consumer had to remember to apply it, and one eventually would not.
  const signed = kind === 'debt' ? -Math.abs(Math.round(pounds * 100)) : Math.round(pounds * 100);

  const info = db.prepare(
    'INSERT INTO finance_assets (label, kind, amount_pence, as_of, note) VALUES (?, ?, ?, ?, ?)'
  ).run(label, kind, signed, asOf, String((req.body && req.body.note) || '').trim() || null);

  res.status(201).json({ id: Number(info.lastInsertRowid), amountPence: signed });
});

router.patch('/assets/:id', express.json(), (req, res) => {
  const row = db.prepare('SELECT * FROM finance_assets WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'no such asset' });

  const pounds = req.body && req.body.amount !== undefined ? Number(req.body.amount) : row.amount_pence / 100;
  if (!Number.isFinite(pounds)) return res.status(400).json({ error: 'amount must be a number' });
  const asOf = req.body && req.body.asOf ? String(req.body.asOf).trim() : row.as_of;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return res.status(400).json({ error: 'asOf must be YYYY-MM-DD' });

  const signed = row.kind === 'debt' ? -Math.abs(Math.round(pounds * 100)) : Math.round(pounds * 100);
  db.prepare(
    `UPDATE finance_assets SET amount_pence = ?, as_of = ?, updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(signed, asOf, row.id);

  res.json({ id: row.id, amountPence: signed, asOf });
});

router.delete('/assets/:id', (req, res) => {
  const r = db.prepare('DELETE FROM finance_assets WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such asset' });
  res.json({ deleted: Number(req.params.id) });
});

module.exports.netWorth = netWorth;

// ---------------------------------------------------------------------------------------
// WHO HAS READ THE LEDGER — backlog #14. The owner's decision on 17 Aug was that personal
// finance data is ALLOWED to a frontier model, kept under review. This is the "under
// review" half: without it, that decision can only ever be revisited from memory.
//
// The counting is db.js's, not this module's — it instruments every caller of the shared
// database module, which is the only place that sees the server AND the tools alike. This
// route only asks for the finance slice and shapes it for the panel. A second count here
// would be a second owner for the same figure.
router.get('/access-log', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const log = db.accessLog({ days, prefix: 'finance_' });

  // Folded to one row per actor, since "who" is the question the item actually asks.
  const byActor = new Map();
  for (const r of log.rows) {
    const a = byActor.get(r.actor) || { actor: r.actor, reads: 0, writes: 0, tables: new Set(), lastAt: null };
    if (r.op === 'read') a.reads += r.n; else a.writes += r.n;
    a.tables.add(r.table_name);
    if (!a.lastAt || r.last_at > a.lastAt) a.lastAt = r.last_at;
    byActor.set(r.actor, a);
  }

  const actors = [...byActor.values()]
    .map((a) => ({ ...a, tables: [...a.tables].sort() }))
    .sort((x, y) => (y.reads + y.writes) - (x.reads + x.writes));

  res.json({
    days,
    actors,
    rows: log.rows,
    watching: log.watching,
    // Absence and failure must not render the same: an empty log because nothing was read
    // is a different statement from an empty log because logging only started today.
    startedAt: db.prepare('SELECT MIN(day) AS d FROM data_access_log').get().d || null,
    isFloor: log.isFloor,
    blindTo: log.blindTo,
    caveat: 'This is a FLOOR, never a total. Real exposure is at least this and cannot be '
      + 'less. Anything that opens the database file without going through server/db.js is '
      + 'invisible here, and no in-process log can change that.',
  });
});
