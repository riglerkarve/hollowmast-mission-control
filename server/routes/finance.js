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
                                              -- SUPERSEDED by migration 4: NOT NULL DEFAULT ''.
                                              -- This migration has shipped and must not be
                                              -- edited; migration 4 is the live shape.
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

  // 4. Make UNIQUE (match_type, pattern, direction) actually constrain the rules.
  //
  // It never did for a rule that omits a direction. SQLite treats NULLs as DISTINCT in a
  // UNIQUE index -- standard SQL, not a quirk -- so two rows with the same match_type and
  // pattern and a NULL direction do not conflict. seed-rules.cjs relies on
  // ON CONFLICT(match_type, pattern, direction) DO UPDATE, which therefore degraded
  // silently to a plain INSERT for exactly those rows.
  //
  // Measured before the fix: 120 rules, 108 distinct, 25 with direction NULL, 12 already
  // duplicated -- including all four 'Own transfer' rules, which is what the turnover
  // figure in the tax report depends on. Every further seed run would have duplicated up
  // to 25 more, unbounded.
  //
  // NOT WRONG TODAY, and that is what made it easy to leave: both copies said the same
  // thing, so classification was unaffected. It cost correctness two ways later --
  // unbounded growth, and an edit to one copy leaving the other in place, so the edit
  // appears to do nothing and nothing errors.
  //
  // The fix makes the constraint TRUE rather than working around it: direction becomes
  // NOT NULL DEFAULT '', and '' means "either direction" exactly as NULL did.
  // Deliberately '' and not a sentinel word: seed-rules.cjs tests `if (r.direction && ...)`
  // to mean "applies to either", and '' is falsy while 'any' would not be. The existing
  // matching logic therefore keeps working unchanged, rather than needing a second edit
  // somewhere else that could be missed.
  (d) => {
    // Verified before writing this: the 12 duplicate pairs differ in created_at ONLY.
    // Category, pattern, note and business are identical across every pair, so which copy
    // survives cannot change how any transaction is classified. Keeping the LOWEST id
    // keeps the row from the first seed run -- the one any manual edit would have hit.
    d.exec(`
      DELETE FROM finance_rules
       WHERE direction IS NULL
         AND id NOT IN (
           SELECT MIN(id) FROM finance_rules WHERE direction IS NULL
            GROUP BY match_type, pattern
         );
    `);

    // SQLite cannot ALTER a column to NOT NULL, so the table is rebuilt. Safe here, and
    // checked rather than assumed: nothing in sqlite_master references finance_rules --
    // no foreign key, no view, no trigger, no extra index.
    d.exec(`
      CREATE TABLE finance_rules_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        match_type TEXT NOT NULL,
        pattern    TEXT NOT NULL,
        direction  TEXT NOT NULL DEFAULT '',   -- 'in' | 'out' | '' for either. NEVER NULL:
                                               -- a NULL here silently voids the UNIQUE key
                                               -- below, which is the bug this fixes.
        category   TEXT NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        business   INTEGER,
        UNIQUE (match_type, pattern, direction)
      );

      INSERT INTO finance_rules_new
             (id, match_type, pattern, direction, category, note, created_at, business)
        SELECT id, match_type, pattern, COALESCE(direction, ''), category, note,
               created_at, business
          FROM finance_rules;

      DROP TABLE finance_rules;
      ALTER TABLE finance_rules_new RENAME TO finance_rules;
    `);
  },

  // v5 — recorded purpose. WHAT the money was actually for, which is a different question
  // from `category` (WHAT KIND of transaction it is) and does not replace it.
  //
  // The problem it exists for, measured: over the last twelve complete months 310 payments
  // worth GBP 24,228 are "Cash withdrawn" or "Payments to people". The bank cannot say what
  // any of them bought, so 77.3% of measured spending has no purpose recorded and every
  // affordability question is answered from the other 22%.
  //
  // SCOPED, BECAUSE 310 TICK BOXES IS A CHORE WITH A NICE FONT. The money is concentrated:
  // five counterparties are 88% of it. So a purpose attaches to a COUNTERPARTY by default
  // and to a single TRANSACTION only where that is wrong. Five decisions explain most of
  // the money; the rest can be left alone without the tool nagging.
  //
  // 'unknown' IS A REAL PURPOSE and must be storable. A payment the owner has looked at and
  // genuinely cannot place is not the same fact as one nobody has opened yet, and collapsing
  // them would let a reviewed ledger and an ignored one render identically — the failure this
  // project keeps meeting. The summary therefore reports three states, never two.
  (d) => {
    d.exec(`
      CREATE TABLE finance_purposes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope      TEXT NOT NULL,             -- 'counterparty' | 'transaction'
        match_key  TEXT NOT NULL,             -- the counterparty name, or the transaction id
        direction  TEXT NOT NULL DEFAULT 'out',
        purpose    TEXT NOT NULL,             -- from PURPOSES; 'unknown' is a valid answer
        note       TEXT,
        by_whom    TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (scope, match_key, direction)
      );

      CREATE INDEX finance_purposes_key ON finance_purposes (scope, match_key);
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

// Per-counterparty payment history. THE owner of this figure is finance, and every other
// module asks for it here rather than querying finance_transactions.
//
// direction: 'in' (money received -- clients) | 'out' (money paid -- suppliers)
//
// Amounts stay in PENCE. A float total is how two views of one number come to disagree in
// the third decimal place and neither of them errors.
function counterparties(opts) {
  const o = opts || {};
  const dir = o.direction === 'out' ? 'out' : 'in';
  const cmp = dir === 'in' ? '>' : '<';
  const params = [];
  let where = 'amount_pence ' + cmp + ' 0 AND counterparty IS NOT NULL AND TRIM(counterparty) <> \'\'';
  if (o.businessOnly) where += ' AND business = 1';
  // minPence is applied AFTER grouping, in JS below -- it is a threshold on the SUM, and a
  // WHERE clause runs per row, so putting it here would filter individual payments instead
  // of clients. The first draft had a fragment here referencing a column that never existed.

  const rows = db.prepare(
    'SELECT counterparty,'
  + '       COUNT(*)                AS payments,'
  + '       SUM(ABS(amount_pence))  AS total_pence,'
  + '       MIN(date)               AS first_at,'
  + '       MAX(date)               AS last_at'
  + '  FROM finance_transactions'
  + ' WHERE ' + where +
    ' GROUP BY counterparty'
  + ' ORDER BY total_pence DESC'
  ).all(...params);

  const today = new Date();
  return rows
    .filter((r) => !o.minPence || r.total_pence >= o.minPence)
    .map((r) => {
      const last = Date.parse(r.last_at);
      const first = Date.parse(r.first_at);
      const daysSince = Number.isFinite(last) ? Math.floor((today - last) / 86400000) : null;
      // Average gap between payments, which is what makes 'lapsed' meaningful. A client
      // who pays yearly is not lapsed at 90 days; one who pays weekly is. A fixed
      // threshold would flag the first and miss the second.
      const spanDays = (Number.isFinite(last) && Number.isFinite(first))
        ? Math.max(0, Math.floor((last - first) / 86400000)) : null;
      const avgGapDays = (spanDays != null && r.payments > 1)
        ? Math.round(spanDays / (r.payments - 1)) : null;
      return {
        counterparty: r.counterparty,
        payments: r.payments,
        total_pence: r.total_pence,
        first_at: r.first_at,
        last_at: r.last_at,
        days_since_last: daysSince,
        avg_gap_days: avgGapDays,
        // null, not false, when there is no basis to judge -- a single payment gives no
        // cadence, and guessing one would manufacture a lapsed flag out of nothing.
        lapsed: (avgGapDays == null || daysSince == null) ? null : daysSince > avgGapDays * 2,
      };
    });
}

// ============================================================ recorded purpose (v5)
//
// WHICH SPEND IS OPAQUE is defined in ONE place. Everything below — the queue, the summary,
// the accessor other tools call — reads this constant, so the queue can never describe a
// different population from the figure it prints beside it.
const OPAQUE_CATEGORIES = ['Cash withdrawn', 'Payments to people'];

// A fixed vocabulary, not free text. Free text fragments into "food", "Food" and "groceries"
// and then nothing can be totalled. 'unknown' is deliberately IN the list: see the migration.
const PURPOSES = [
  'rent', 'bills', 'food', 'transport', 'debt-repaid', 'lent',
  'gift', 'business', 'personal', 'savings', 'unknown',
];

const opaqueWhere = `category IN (${OPAQUE_CATEGORIES.map(() => '?').join(',')}) AND amount_pence < 0`;

// ONE window helper for all three purpose endpoints.
//
// The first version of this read `ledgerSpan().lastCompleteMonthEnd`, a field ledgerSpan has
// never returned — it returns { first, last, rows, staleDays }. That would have put
// `undefined` into the date arithmetic and produced an invalid window matching either nothing or
// everything, with no error either way. Caught by reading the function rather than trusting
// the name.
//
// The last calendar month is ALWAYS partial: the ledger is an import that stops mid-month, so
// including the stub drags every monthly figure down by an amount nobody can see.
function purposeWindow(months = 12) {
  const last = db.prepare('SELECT MAX(date) AS d FROM finance_transactions').get().d;
  if (!last) return { from: null, to: null, months };
  const [y, m, d] = last.split('-').map(Number);
  const endOfThatMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = d >= endOfThatMonth ? last : new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  const [ty, tm] = to.split('-').map(Number);
  const from = new Date(Date.UTC(ty, tm - months, 1)).toISOString().slice(0, 10);
  return { from, to, months };
}

// Resolve the purpose for a row: a TRANSACTION assignment beats a COUNTERPARTY one, because
// the per-transaction form exists precisely to say "this one was different". Precedence by
// test order is invisible, so it is a single expression here rather than two lookups whose
// order some later caller could reverse.
const RESOLVED = `
  COALESCE(
    (SELECT p.purpose FROM finance_purposes p
      WHERE p.scope = 'transaction' AND p.match_key = CAST(t.id AS TEXT)),
    (SELECT p.purpose FROM finance_purposes p
      WHERE p.scope = 'counterparty' AND p.match_key = t.counterparty)
  )`;

// GET /purpose/summary — three states, never two.
router.get('/purpose/summary', (req, res) => {
  const { from, to, months } = purposeWindow(Number(req.query.months) || 12);

  const row = db.prepare(`
    SELECT
      COUNT(*) AS n,
      COALESCE(SUM(-t.amount_pence), 0) AS pence,
      COALESCE(SUM(CASE WHEN ${RESOLVED} IS NULL THEN -t.amount_pence ELSE 0 END), 0) AS unreviewed_pence,
      SUM(CASE WHEN ${RESOLVED} IS NULL THEN 1 ELSE 0 END) AS unreviewed_n,
      COALESCE(SUM(CASE WHEN ${RESOLVED} = 'unknown' THEN -t.amount_pence ELSE 0 END), 0) AS unknown_pence,
      SUM(CASE WHEN ${RESOLVED} = 'unknown' THEN 1 ELSE 0 END) AS unknown_n,
      COALESCE(SUM(CASE WHEN ${RESOLVED} IS NOT NULL AND ${RESOLVED} <> 'unknown' THEN -t.amount_pence ELSE 0 END), 0) AS explained_pence,
      SUM(CASE WHEN ${RESOLVED} IS NOT NULL AND ${RESOLVED} <> 'unknown' THEN 1 ELSE 0 END) AS explained_n
    FROM finance_transactions t
    WHERE t.date >= ? AND t.date <= ? AND ${opaqueWhere}`
  ).get(from, to, ...OPAQUE_CATEGORIES);

  const byPurpose = db.prepare(`
    SELECT ${RESOLVED} AS purpose, COUNT(*) AS n, SUM(-t.amount_pence) AS pence
      FROM finance_transactions t
     WHERE t.date >= ? AND t.date <= ? AND ${opaqueWhere} AND ${RESOLVED} IS NOT NULL
     GROUP BY purpose ORDER BY pence DESC`
  ).all(from, to, ...OPAQUE_CATEGORIES);

  res.json({
    from, to, months, purposes: PURPOSES, categories: OPAQUE_CATEGORIES, ...row, byPurpose,
  });
});

// GET /purpose/queue — what to ask about next, biggest money first.
//
// It DECIDES the order rather than listing rows: the point is that a handful of decisions
// move most of the money, and a date-ordered list of 310 payments hides that completely.
router.get('/purpose/queue', (req, res) => {
  const { from, to, months } = purposeWindow(Number(req.query.months) || 12);

  const rows = db.prepare(`
    SELECT t.counterparty,
           COUNT(*) AS n,
           SUM(-t.amount_pence) AS pence,
           MIN(t.date) AS first_seen,
           MAX(t.date) AS last_seen,
           (SELECT p.purpose FROM finance_purposes p
             WHERE p.scope = 'counterparty' AND p.match_key = t.counterparty) AS counterparty_purpose,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM finance_purposes p
                 WHERE p.scope = 'transaction' AND p.match_key = CAST(t.id AS TEXT)) THEN 1 ELSE 0 END) AS overridden_n,
           SUM(CASE WHEN ${RESOLVED} IS NULL THEN -t.amount_pence ELSE 0 END) AS unreviewed_pence
      FROM finance_transactions t
     WHERE t.date >= ? AND t.date <= ? AND ${opaqueWhere}
     GROUP BY t.counterparty
     ORDER BY pence DESC`
  ).all(from, to, ...OPAQUE_CATEGORIES);

  const total = rows.reduce((a, r) => a + r.pence, 0);
  let running = 0;
  const withShare = rows.map((r) => {
    running += r.pence;
    return { ...r, shareOfOpaque: total ? r.pence / total : 0, cumulativeShare: total ? running / total : 0 };
  });
  res.json({ from, to, months, total, purposes: PURPOSES, counterparties: withShare });
});

// GET /purpose/transactions?counterparty=X — the rows behind one counterparty, so a single
// payment that was different can be overridden without abandoning the counterparty rule.
router.get('/purpose/transactions', (req, res) => {
  const cp = String(req.query.counterparty || '');
  if (!cp) return res.status(400).json({ error: 'counterparty is required' });
  // WINDOWED, to the same period as the queue and the summary.
  //
  // Without this it returned every payment to the counterparty across the whole ledger —
  // 662 rows for a counterparty with 128 in the window. Caught by opening the panel and
  // counting. The rows outside the window are real payments, but they contribute nothing to
  // the figures printed beside them, so assigning one appeared to do nothing. A detail list
  // that describes a different population from the total above it is worse than no detail
  // list: both are plausible and only one is being measured.
  //
  // `outsideWindow` is reported rather than hidden, because "128 shown" and "128 exist" are
  // different claims and the difference here is 534 payments.
  const { from, to } = purposeWindow(Number(req.query.months) || 12);
  const rows = db.prepare(`
    SELECT t.id, t.date, t.counterparty, -t.amount_pence AS pence, t.category, t.reference,
           (SELECT p.purpose FROM finance_purposes p
             WHERE p.scope = 'transaction' AND p.match_key = CAST(t.id AS TEXT)) AS own_purpose,
           ${RESOLVED} AS resolved_purpose
      FROM finance_transactions t
     WHERE t.counterparty = ? AND t.date >= ? AND t.date <= ? AND ${opaqueWhere}
     ORDER BY t.date DESC`
  ).all(cp, from, to, ...OPAQUE_CATEGORIES);
  const outside = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(-t.amount_pence), 0) AS pence
      FROM finance_transactions t
     WHERE t.counterparty = ? AND (t.date < ? OR t.date > ?) AND ${opaqueWhere}`
  ).get(cp, from, to, ...OPAQUE_CATEGORIES);
  res.json({ counterparty: cp, from, to, purposes: PURPOSES, transactions: rows, outsideWindow: outside });
});

// POST /purpose — assign. { scope, key, purpose, note? }
router.post('/purpose', express.json(), (req, res) => {
  const { scope, key, purpose, note } = req.body || {};
  if (scope !== 'counterparty' && scope !== 'transaction') {
    return res.status(400).json({ error: "scope must be 'counterparty' or 'transaction'" });
  }
  if (!String(key || '').trim()) return res.status(400).json({ error: 'key is required' });
  // Refused rather than coerced: an out-of-vocabulary purpose would total into nothing and
  // look like a working entry. Same reasoning as the enum on the local model's output.
  if (!PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: `purpose must be one of ${PURPOSES.join(', ')}` });
  }
  // A transaction key must actually exist AND be in the opaque set. Assigning a purpose to
  // a row this surface does not cover would store a fact nothing ever reads.
  if (scope === 'transaction') {
    const t = db.prepare(`SELECT id FROM finance_transactions t WHERE t.id = ? AND ${opaqueWhere}`)
      .get(Number(key), ...OPAQUE_CATEGORIES);
    if (!t) return res.status(404).json({ error: `transaction ${key} is not an unexplained payment` });
  }
  try {
    db.prepare(`
      INSERT INTO finance_purposes (scope, match_key, direction, purpose, note, by_whom)
      VALUES (?, ?, 'out', ?, ?, ?)
      ON CONFLICT (scope, match_key, direction)
      DO UPDATE SET purpose = excluded.purpose, note = excluded.note,
                    by_whom = excluded.by_whom, created_at = datetime('now', 'localtime')`
    ).run(scope, String(key), purpose, note || null, req.by || 'unknown');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.status(201).json({ scope, key: String(key), purpose, note: note || null });
});

// DELETE /purpose — remove an assignment, returning the row to unreviewed.
router.delete('/purpose', express.json(), (req, res) => {
  const { scope, key } = req.body || {};
  const r = db.prepare('DELETE FROM finance_purposes WHERE scope = ? AND match_key = ? AND direction = ?')
    .run(String(scope), String(key), 'out');
  if (!r.changes) return res.status(404).json({ error: 'no such assignment' });
  res.json({ removed: r.changes, scope, key: String(key) });
});

// The accessor other modules and tools call. rent-affordability.cjs asks THIS rather than
// recomputing the opaque share, so the figure has one owner.
function purposeSummary(months = 12) {
  const { from, to } = purposeWindow(months);
  const row = db.prepare(`
    SELECT COALESCE(SUM(-t.amount_pence), 0) AS pence,
           COALESCE(SUM(CASE WHEN ${RESOLVED} IS NULL THEN -t.amount_pence ELSE 0 END), 0) AS unreviewed_pence,
           COALESCE(SUM(CASE WHEN ${RESOLVED} = 'unknown' THEN -t.amount_pence ELSE 0 END), 0) AS unknown_pence,
           COALESCE(SUM(CASE WHEN ${RESOLVED} IS NOT NULL AND ${RESOLVED} <> 'unknown' THEN -t.amount_pence ELSE 0 END), 0) AS explained_pence
      FROM finance_transactions t
     WHERE t.date >= ? AND t.date <= ? AND ${opaqueWhere}`
  ).get(from, to, ...OPAQUE_CATEGORIES);
  const byPurpose = db.prepare(`
    SELECT ${RESOLVED} AS purpose, SUM(-t.amount_pence) AS pence
      FROM finance_transactions t
     WHERE t.date >= ? AND t.date <= ? AND ${opaqueWhere}
       AND ${RESOLVED} IS NOT NULL AND ${RESOLVED} <> 'unknown'
     GROUP BY purpose ORDER BY pence DESC`
  ).all(from, to, ...OPAQUE_CATEGORIES);
  return { from, to, ...row, byPurpose };
}

module.exports = router;
module.exports.purposeSummary = purposeSummary;
module.exports.PURPOSES = PURPOSES;
module.exports.counterparties = counterparties;
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
//   Benefits         coefficient of variation 0.147   near-deterministic
//   Income - people  coefficient of variation 1.539   ten times more variable
//
// So benefits are projected and nothing else is. The residual is reported beside it, at its
// full size, so the projection can never be mistaken for total income.
//
// Those two figures were 0.226 and 1.538 in this comment and in the `basis` string until
// 18 Aug, when the route was finally displayed and the prose was checked against the
// output it describes. The string now computes them; this comment is a snapshot and says
// so. If they disagree again, the string is right.
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
    // COMPUTED, not typed. This sentence carried "Benefits 0.226" and "Income - people
    // 1.538" as literals; the live figures are 0.147 and 1.539, so the prose describing the
    // rule disagreed with the rule's own output — by a third, on the number that decides
    // whether a category is projected at all. A figure written into a sentence is accurate
    // exactly once. Same defect as the hard-coded GBP 22,628 in the MTD check, same day.
    basis: `Only categories with 6+ complete months and a coefficient of variation at or `
      + `below ${CV_REGULAR} are projected. Measured now: `
      + (projected.length
        ? projected.map((p) => `${p.category} ${p.cv.toFixed(3)}`).join(', ')
        : 'nothing qualifies')
      + (residual.length
        ? `. Held back as residual: ${residual.map((r) => `${r.category} ${r.cv === null ? 'cv unmeasurable' : r.cv.toFixed(3)}${r.months < 6 ? ` (only ${r.months} month${r.months === 1 ? '' : 's'})` : ''}`).join(', ')}`
        : '')
      + '. Residual is never added to the projection.',
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

// ---------------------------------------------------------------------------
// Own-transfer suspects — backlog #M11
//
// Money INTO the business account counts as TURNOVER unless it is categorised
// 'Own transfer'. That figure feeds the self-assessment report and the Making Tax
// Digital threshold test for 2026/2027 — the year that decides April 2028 mandation.
// So a personal transfer in, under a spelling no rule matches, becomes turnover with
// no error and nothing to look at.
//
// This REPORTS SUSPICION AND CHANGES NOTHING. There is no write path in it. The
// categoriser already owns "what kind of thing is this" (108 rules over 95.3% of the
// ledger); a second classifier here would be a second owner for that question, and the
// last time recurrence was used to answer it, it returned Tesco as a stopped subscription.
//
// The owner's name is NOT written down here. It is read from the counterparties the
// ledger already asserts are the owner — the ones categorised 'Own transfer'. A
// hard-coded name would be a second owner for "who is the owner", and it would go stale
// the moment a spelling changed.

// A one-character token is an initial. It cannot distinguish anybody, so it is dropped.
// That is a property of the token, not a cut-off chosen to make the output look tidy.
function nameTokens(s) {
  const m = String(s == null ? '' : s).toLowerCase().match(/[a-z0-9']+/g);
  return m ? m.filter((t) => t.length > 1) : [];
}

// UK tax year starts 6 April. A suspect in a closed year is history; one in the year
// currently being measured is live, and that is a different thing to be told.
function taxYearStart(isoDate) {
  const parts = String(isoDate).split('-').map(Number);
  const y = parts[0], mo = parts[1], d = parts[2];
  return (mo > 4 || (mo === 4 && d >= 6)) ? (y + '-04-06') : ((y - 1) + '-04-06');
}

function ownTransferSuspects(opts) {
  const accountKind = (opts && opts.accountKind) || 'business';
  const accounts = db.prepare('SELECT id, label FROM finance_accounts WHERE kind = ?').all(accountKind);
  if (!accounts.length) {
    // "could not look" is not "found nothing".
    return { ok: false, reason: 'no_account', message: 'No ' + accountKind + ' account exists in the ledger.' };
  }
  const ids = accounts.map((a) => a.id);
  const holes = ids.map(() => '?').join(',');

  // The strings the ledger already asserts are the owner. Read across the WHOLE ledger,
  // not just this account: a spelling recognised on the personal side is still evidence
  // about who that name is.
  const ownCps = db.prepare("SELECT DISTINCT counterparty FROM finance_transactions WHERE category = 'Own transfer'")
    .all().map((r) => r.counterparty);
  if (!ownCps.length) {
    return {
      ok: false,
      reason: 'no_own_transfers',
      message: 'Nothing in the ledger is categorised "Own transfer", so there is no statement '
        + 'of who the owner is to compare against. This is not an all-clear.',
    };
  }

  // The account's own trading name is NOT the owner's personal name. "Private Security
  // Services (business)" makes every counterparty in the same trade share a token with it
  // — five real clients worth £43k here. Derived from finance_accounts.label rather than
  // judged, so it is a fact about the data and not an opinion about the clients.
  const tradeTokens = new Set(accounts.reduce((acc, a) => acc.concat(nameTokens(a.label)), ['business', 'personal']));

  const ownTokenSource = new Map();          // token -> the own-transfer strings it came from
  ownCps.forEach((cp) => nameTokens(cp).forEach((t) => {
    if (!ownTokenSource.has(t)) ownTokenSource.set(t, new Set());
    ownTokenSource.get(t).add(cp);
  }));

  // Discriminating power, measured rather than assumed: across the whole ledger, how many
  // DISTINCT counterparties contain this token? A token in 200 counterparties identifies
  // nobody. It is reported, never thresholded on — the ranking stays arithmetic you can check.
  const allCps = db.prepare('SELECT DISTINCT counterparty FROM finance_transactions').all().map((r) => r.counterparty);
  const spread = new Map();
  allCps.forEach((cp) => new Set(nameTokens(cp)).forEach((t) => spread.set(t, (spread.get(t) || 0) + 1)));

  const credits = db.prepare(
    'SELECT counterparty, COALESCE(category, \'(uncategorised)\') AS cat, COUNT(*) AS n, '
    + 'SUM(amount_pence) AS pence, MIN(date) AS first_seen, MAX(date) AS last_seen '
    + 'FROM finance_transactions '
    + 'WHERE account_id IN (' + holes + ') AND amount_pence > 0 '
    + 'GROUP BY counterparty, cat'
  ).all(...ids);

  const ledgerEnd = db.prepare(
    'SELECT MAX(date) AS d FROM finance_transactions WHERE account_id IN (' + holes + ')'
  ).get(...ids).d;
  const thisTaxYear = ledgerEnd ? taxYearStart(ledgerEnd) : null;

  const candidates = [];
  let alreadyOwnTransfer = 0, sharedNothing = 0, unjudgeable = 0;
  let examinedTx = 0, examinedRows = 0;

  credits.forEach((r) => {
    examinedTx += r.n; examinedRows += 1;
    if (r.cat === 'Own transfer') { alreadyOwnTransfer += r.n; return; }
    const toks = [...new Set(nameTokens(r.counterparty))];
    if (!toks.length) { unjudgeable += r.n; return; }        // e.g. a counterparty of only digits
    const shared = toks.filter((t) => ownTokenSource.has(t));
    if (!shared.length) { sharedNothing += r.n; return; }

    const matches = shared.map((t) => ({
      token: t,
      alsoIn: spread.get(t),
      via: [...ownTokenSource.get(t)],
      fromTradingName: tradeTokens.has(t),
    })).sort((a, b) => a.alsoIn - b.alsoIn);

    candidates.push({
      counterparty: r.counterparty,
      category: r.cat,
      transactions: r.n,
      amountPence: r.pence,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      inCurrentTaxYear: !!(thisTaxYear && r.last_seen >= thisTaxYear),
      // A match on the account's own trading name is the weak kind, and it is LABELLED
      // rather than dropped — a filter that removed these would report a clean run it had
      // not earned.
      onlyTradingName: matches.every((m) => m.fromTradingName),
      matches,
    });
  });

  candidates.sort((a, b) =>
    (a.onlyTradingName ? 1 : 0) - (b.onlyTradingName ? 1 : 0)
    || (b.inCurrentTaxYear ? 1 : 0) - (a.inCurrentTaxYear ? 1 : 0)
    || a.matches[0].alsoIn - b.matches[0].alsoIn
    || b.amountPence - a.amountPence);

  const strong = candidates.filter((c) => !c.onlyTradingName);

  return {
    ok: true,
    accounts: ids,
    ledgerEndsOn: ledgerEnd,
    currentTaxYearFrom: thisTaxYear,
    ownTransferStrings: ownCps,
    tradingNameTokens: [...tradeTokens].filter((t) => ownTokenSource.has(t)),
    candidates,
    counts: {
      creditRowsExamined: examinedRows,
      creditTransactionsExamined: examinedTx,
      candidates: candidates.length,
      candidatesNotOnTradingName: strong.length,
      candidatesInCurrentTaxYear: candidates.filter((c) => c.inCurrentTaxYear).length,
    },
    // A filter must report its residue, or a clean run reads as an all-clear it did not earn.
    residue: {
      alreadyOwnTransfer,
      sharedNoTokenWithOwner: sharedNothing,
      couldNotJudge: unjudgeable,
      note: alreadyOwnTransfer + ' credits are already categorised "Own transfer" and were not '
        + 'examined. ' + sharedNothing + ' share no name token with any string the ledger calls '
        + 'the owner. ' + unjudgeable + ' have no token longer than one character to compare.',
    },
    blindTo: [
      'A transfer in under a name sharing NO token with any known spelling of the owner. This '
        + 'compares strings; it cannot recognise a name it has never seen.',
      'A genuine third party who happens to share a surname. That is exactly why this reports '
        + 'and never recategorises.',
      'Anything not yet imported. It reads the ledger, so it is silent about a payment the bank '
        + 'has and the ledger has not.',
    ],
  };
}

router.get('/own-transfer-suspects', (req, res) => {
  res.json(ownTransferSuspects({ accountKind: req.query.accountKind || 'business' }));
});

module.exports.ownTransferSuspects = ownTransferSuspects;

// ---------------------------------------------------------------------------
// Cash withdrawn in a window — the one figure the cash module needs from the ledger.
//
// EXPORTED RATHER THAN LET THE CASH MODULE QUERY finance_transactions ITSELF. That is the
// module contract: one owner per figure. If cash ran its own SQL the two would drift the
// first time the category name or the account set changed, and neither would error.
function cashWithdrawn({ from, to } = {}) {
  const end = to || db.prepare('SELECT MAX(date) AS d FROM finance_transactions').get().d;
  if (!end) return { ok: false, reason: 'empty_ledger', message: 'The ledger has no transactions.' };

  const where = from
    ? 'date > ? AND date <= ?'          // > from: the count day itself is already accounted for
    : 'date <= ?';
  const args = from ? [from, end] : [end];

  const r = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(-amount_pence),0) AS pence, MIN(date) AS first, MAX(date) AS last
       FROM finance_transactions
      WHERE category = 'Cash withdrawn' AND amount_pence < 0 AND ${where}`
  ).get(...args);

  return {
    ok: true,
    from: from || null,
    to: end,
    withdrawals: r.n,
    pence: r.pence,
    firstOn: r.first,
    lastOn: r.last,
    ledgerEndsOn: end,
    // The ledger is an IMPORT. Everything here is silent about cash taken out after the last
    // imported row, and a reconciliation run against a stale ledger will read that gap as
    // spending. The caller has to say so.
    ledgerIsStaleBy: null,
  };
}
module.exports.cashWithdrawn = cashWithdrawn;

// ---------------------------------------------------------------------------------------
// PROFIT & LOSS — added 18 Aug 2026, after the owner asked for one and a mail sweep
// surfaced payment confirmations that mostly already lived in THIS ledger, under different
// dates and categorised as personal spend. That is the whole reason this reads the ledger
// rather than the mail: a receipt states when a card was CHARGED, the bank states when the
// money SETTLED, and only one of those two can be this figure's owner without a second one
// appearing for it. See the module contract at the top of this file.
//
// A STATEMENT OVER A PERIOD, not a single month against the one before — "Where it went"
// above already does that comparison, and duplicating it here would be a second owner for
// the same fact. This sums a trailing run of months for ONE account kind: money in minus
// money out, split the same way /spending already splits it (by the SIGN of amount_pence,
// not by category name), so a reader who has learned that view does not have to learn a
// second one.
//
// CASH WITHDRAWN IS EXCLUDED FROM THE NET, exactly as /spending excludes it and for the
// same reason: once it leaves the account this ledger cannot say what it bought, and
// folding it into "expenses" would imply it does. Reported alongside instead.
//
// UNCATEGORISED ROWS ARE EXCLUDED TOO, matching accountKindSummary/monthlySpend/
// monthlyIncome — not /spending, which leaves them in under a blank label. Chosen so this
// figure reconciles with the accessor other modules already call, rather than being a third
// opinion about the same money. The residue is reported rather than silently dropped: see
// `uncategorisedPence` below. The ledger holds zero uncategorised rows today, so this
// choice is currently invisible — it matters the day a fresh import lands some.
const PNL_DEFAULT_MONTHS = 12;

function accountKindSpan(kind) {
  return db.prepare(
    `SELECT MIN(t.date) AS first, MAX(t.date) AS last, COUNT(*) AS n
       FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
      WHERE a.kind = ?`
  ).get(kind);
}

// Every month between the two given, inclusive, whether or not the ledger has a surviving
// row in it. GROUP BY only returns months a WHERE clause left something in, so a month
// whose only transaction was an excluded 'Own transfer' would otherwise vanish from the
// statement entirely — indistinguishable from a month never imported at all.
function monthSequence(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function profitAndLoss({ accountKind = 'business', months = PNL_DEFAULT_MONTHS } = {}) {
  const span = accountKindSpan(accountKind);
  if (!span.n) {
    return { state: 'empty', accountKind, message: `No ${accountKind} account has any transactions.` };
  }

  const lastMonth = span.last.slice(0, 7);
  const [ly, lm] = lastMonth.split('-').map(Number);
  let startY = ly;
  let startM = lm - (months - 1);
  while (startM < 1) { startM += 12; startY -= 1; }
  const requestedFrom = `${startY}-${String(startM).padStart(2, '0')}`;
  const accountFirstMonth = span.first.slice(0, 7);
  // The window cannot reach further back than the account itself started.
  const windowTruncated = requestedFrom < accountFirstMonth;
  const startMonth = windowTruncated ? accountFirstMonth : requestedFrom;

  const rows = db.prepare(`
    SELECT substr(t.date, 1, 7) AS month,
           SUM(CASE WHEN t.amount_pence > 0 THEN t.amount_pence ELSE 0 END) AS income_pence,
           SUM(CASE WHEN t.amount_pence < 0 AND t.category IS NOT 'Cash withdrawn'
                    THEN -t.amount_pence ELSE 0 END) AS expense_pence,
           SUM(CASE WHEN t.category = 'Cash withdrawn' THEN -t.amount_pence ELSE 0 END) AS cash_pence
      FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
     WHERE a.kind = ? AND t.category IS NOT NULL AND t.category IS NOT 'Own transfer'
       AND substr(t.date, 1, 7) >= ? AND substr(t.date, 1, 7) <= ?
     GROUP BY month
  `).all(accountKind, startMonth, lastMonth);
  const byMonth = new Map(rows.map((r) => [r.month, r]));

  // The final calendar day this account kind's OWN statements reach. If the ledger ends
  // mid-month, that month is marked partial rather than shown as if it were complete — the
  // same distinction /spending draws, for the same reason.
  const monthEndDate = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };

  const monthly = monthSequence(startMonth, lastMonth).map((month) => {
    const r = byMonth.get(month) || { income_pence: 0, expense_pence: 0, cash_pence: 0 };
    return {
      month,
      incomePence: r.income_pence,
      expensePence: r.expense_pence,
      cashPence: r.cash_pence,
      netPence: r.income_pence - r.expense_pence,
      partial: month === lastMonth && span.last < monthEndDate(month),
    };
  });

  const expenseByCategory = db.prepare(`
    SELECT t.category, SUM(-t.amount_pence) AS pence, COUNT(*) AS n
      FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
     WHERE a.kind = ? AND t.amount_pence < 0 AND t.category IS NOT NULL
       AND t.category NOT IN ('Own transfer', 'Cash withdrawn')
       AND substr(t.date, 1, 7) >= ? AND substr(t.date, 1, 7) <= ?
     GROUP BY t.category ORDER BY pence DESC
  `).all(accountKind, startMonth, lastMonth);

  const incomeByCategory = db.prepare(`
    SELECT t.category, SUM(t.amount_pence) AS pence, COUNT(*) AS n
      FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
     WHERE a.kind = ? AND t.amount_pence > 0 AND t.category IS NOT NULL
       AND t.category IS NOT 'Own transfer'
       AND substr(t.date, 1, 7) >= ? AND substr(t.date, 1, 7) <= ?
     GROUP BY t.category ORDER BY pence DESC
  `).all(accountKind, startMonth, lastMonth);

  // The residue this figure's exclusion of uncategorised rows leaves behind — reported
  // rather than silently dropped. A filter that hides what it left out looks cleaner than
  // it is.
  const uncategorised = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(ABS(t.amount_pence)), 0) AS pence
      FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id
     WHERE a.kind = ? AND t.category IS NULL
       AND substr(t.date, 1, 7) >= ? AND substr(t.date, 1, 7) <= ?
  `).get(accountKind, startMonth, lastMonth);

  const totals = monthly.reduce((s, r) => ({
    incomePence: s.incomePence + r.incomePence,
    expensePence: s.expensePence + r.expensePence,
    cashPence: s.cashPence + r.cashPence,
  }), { incomePence: 0, expensePence: 0, cashPence: 0 });

  return {
    state: 'ok',
    accountKind,
    months: monthly.length,
    from: startMonth,
    to: lastMonth,
    ledgerEndsOn: span.last,
    windowTruncated,
    monthly,
    totals: {
      incomePence: totals.incomePence,
      expensePence: totals.expensePence,
      cashPence: totals.cashPence,
      netPence: totals.incomePence - totals.expensePence,
      expenseByCategory: expenseByCategory.map((c) => ({ category: c.category, pence: c.pence, n: c.n })),
      incomeByCategory: incomeByCategory.map((c) => ({ category: c.category, pence: c.pence, n: c.n })),
    },
    uncategorisedPence: uncategorised.pence,
    uncategorisedCount: uncategorised.n,
    excludedNote: 'Transfers between your own accounts are excluded everywhere — each one '
      + 'appears twice, once per side. Cash withdrawn is reported separately, never as an '
      + 'expense: once it leaves the account this ledger cannot say what it bought.',
    caveat: accountKind === 'business'
      ? 'This is a book-keeping statement read straight off the bank feed, not a self-assessment '
        + 'return — it has not applied allowable-expense rules, and it has not excluded personal '
        + 'spending paid from this account or included business spending paid from the other one. '
        + 'Run tools/tax-year-report.cjs for that; own-transfer-suspects above is the check for '
        + 'money crossing between the two.'
      : 'A personal account has no statutory profit and loss. This is income minus spending, '
        + 'read the same way as the business statement, so the two can sit side by side.',
  };
}

router.get('/pnl', (req, res) => {
  const accountKind = req.query.accountKind === 'personal' ? 'personal' : 'business';
  const months = Math.min(36, Math.max(1, Number(req.query.months) || PNL_DEFAULT_MONTHS));
  res.json(profitAndLoss({ accountKind, months }));
});

module.exports.profitAndLoss = profitAndLoss;
