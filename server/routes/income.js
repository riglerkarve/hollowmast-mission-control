const express = require('express');
const db = require('../db');

// INCOME — a ledger of what the small streams actually paid.
//
// SCOPE, and it is a hard boundary. This module RECORDS income that has ALREADY BEEN
// EARNED. It does not create accounts, does not hold credentials, does not log in to
// Honeygain, Packetstream, SerpClix, Coinbase or PayPal, does not call their APIs, and
// does not automate the earning activity itself. In particular it must never automate
// SerpClix clicking: that is against the service's terms, and the account it would burn is
// the one producing the numbers in this table. This is bookkeeping. You read the figure
// off the service's own dashboard; this remembers it and tells you what it means.
//
// Manual entry is therefore the primary path and not a fallback — which is also the only
// design that needs no API, no approval and no account beyond the ones you already have.
//
// What it DERIVES, because a panel that only shows back what you typed is rejected by the
// workspace gate:
//   - a rate per month, and a rate per hour — the hourly one computed ONLY from the months
//     where you also recorded the time, so a year of money is never divided by one logged
//     afternoon. Where it cannot be computed it says so instead of guessing.
//   - months since each stream last paid, so a dead stream reads as dead
//   - each stream's share of the total
//   - "worth it?": the two inputs and the division of them. No score, no weighting, no
//     threshold — nothing here decides for you what a good hourly rate is.
//
// CURRENCIES ARE NEVER CONVERTED. Honeygain and Coinbase commonly pay in USD. Adding those
// cents to GBP pence needs an FX rate this module does not have, and a made-up rate makes a
// made-up total. Totals are computed per currency and the summary says plainly when the
// ledger holds more than one.
//
// Money is INTEGER pence (or cents), always. The unit is in the column name.

const KINDS = ['bandwidth', 'clicks', 'exchange', 'platform', 'other'];

// Seeded once, in the first migration. Slugs are the id, so they are stable and the panel
// can address a stream without knowing its label.
const SEED = [
  ['honeygain', 'Honeygain', 'bandwidth',
    'Bandwidth sharing. Pays in USD — set the currency on the entry if you record the USD figure rather than what landed in the bank.'],
  ['packetstream', 'PacketStream', 'bandwidth',
    'Bandwidth sharing. Same currency caveat as Honeygain.'],
  ['serpclix', 'SerpClix', 'clicks',
    'Paid clicks, done by you. Recorded here only — nothing in this dashboard clicks anything.'],
  ['coinbase', 'Coinbase', 'exchange',
    'Record only earnings actually credited — rewards, interest, referrals. An unrealised price move is not income and would make every total below wrong.'],
  ['paypal', 'PayPal', 'platform',
    'Where several of the others settle. If you record a payout here AND at the stream it came from, it is counted twice.'],
];

db.migrate('income', [
  (d) => {
    d.exec(`
      CREATE TABLE income_streams (
        id         TEXT PRIMARY KEY,          -- slug: 'honeygain'
        label      TEXT NOT NULL,
        kind       TEXT NOT NULL,             -- bandwidth | clicks | exchange | platform | other
        active     INTEGER NOT NULL DEFAULT 1,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE income_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id      TEXT NOT NULL REFERENCES income_streams(id),
        period         TEXT NOT NULL,          -- YYYY-MM
        amount_pence   INTEGER NOT NULL,       -- INTEGER minor units, never a float
        currency       TEXT NOT NULL DEFAULT 'GBP',
        -- Optional, and nullable on purpose. Without it there is no honest hourly rate, and
        -- the summary says "no time recorded" rather than inventing one. NULL and 0 are
        -- different facts: NULL is "not logged", 0 would be "it took no time at all".
        effort_minutes INTEGER,
        recorded_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (stream_id, period)
      );

      CREATE INDEX idx_income_entries_period ON income_entries(period);
    `);

    const ins = d.prepare(
      'INSERT INTO income_streams (id, label, kind, active, note) VALUES (?, ?, ?, 1, ?)'
    );
    for (const [id, label, kind, note] of SEED) ins.run(id, label, kind, note);
  },
]);

// ---------------------------------------------------------------------------- helpers
const MONTH_RE = /^\d{4}-\d{2}$/;

// LOCAL, not UTC. toISOString() on the 1st of a month at 00:30 BST returns the previous
// month, which would file an entry against a month you did not mean and then silently
// collide with the real one on the unique key.
function thisMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Months from a to b, both YYYY-MM. String arithmetic, no Date parsing, no timezone.
const monthsBetween = (a, b) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

function shiftMonth(m, delta) {
  const total = Number(m.slice(0, 4)) * 12 + (Number(m.slice(5, 7)) - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// ---------------------------------------------------------------------------- derivation
// Everything the panel shows is computed here, once, from the two tables this module owns.
// No other module's tables are read, and no figure below is computed anywhere else.
function summarise() {
  const streams = db.prepare('SELECT * FROM income_streams ORDER BY active DESC, label').all();
  const entries = db.prepare('SELECT * FROM income_entries ORDER BY period').all();
  const now = thisMonth();

  // Per currency, because these are not addable. One currency is the normal case and reads
  // exactly like a single total; more than one is flagged rather than quietly summed.
  const byCurrency = new Map();
  for (const e of entries) {
    const c = byCurrency.get(e.currency) || { currency: e.currency, pence: 0, entries: 0, periods: new Set() };
    c.pence += e.amount_pence;
    c.entries += 1;
    c.periods.add(e.period);
    byCurrency.set(e.currency, c);
  }
  // Ordered by ENTRY COUNT, not by amount. Sorting mixed currencies by their minor units
  // would be comparing 1200 cents with 800 pence — a cross-currency comparison smuggled in
  // to decide which currency is the main one, which is the very thing this module refuses
  // to do. A count has no unit.
  const currencyTotals = [...byCurrency.values()]
    .map((c) => ({ currency: c.currency, pence: c.pence, entries: c.entries, months: c.periods.size }))
    .sort((a, b) => b.entries - a.entries || a.currency.localeCompare(b.currency));
  const mixedCurrency = currencyTotals.length > 1;

  const perStream = streams.map((s) => {
    const mine = entries.filter((e) => e.stream_id === s.id);

    const base = {
      id: s.id,
      label: s.label,
      kind: s.kind,
      active: !!s.active,
      note: s.note,
      entries: mine.length,
    };

    if (!mine.length) {
      // Never recorded is not the same fact as "recorded zero", and neither is the same as
      // "the query failed". All three have to be distinguishable from the panel.
      return {
        ...base,
        state: 'never-recorded',
        currency: null,
        totalPence: 0,
        monthsRecorded: 0,
        firstPeriod: null,
        lastPeriod: null,
        monthsSinceLast: null,
        staleness: s.active ? 'never recorded' : 'never recorded (marked inactive)',
        perRecordedMonthPence: null,
        perCalendarMonthPence: null,
        sharePct: null,
        worthIt: { state: 'no-entries', text: 'Nothing recorded yet.' },
      };
    }

    const currencies = [...new Set(mine.map((e) => e.currency))];
    const totalPence = mine.reduce((t, e) => t + e.amount_pence, 0);
    const periods = mine.map((e) => e.period);
    const first = periods[0];
    const last = periods[periods.length - 1];
    const span = monthsBetween(first, last) + 1;          // calendar months first..last inclusive
    const monthsSinceLast = monthsBetween(last, now);

    // Two averages, named separately, because they answer different questions and the gap
    // between them is the gaps in your logging. Reconciling them into one number would hide
    // exactly the thing worth seeing.
    const perRecordedMonthPence = Math.round(totalPence / mine.length);
    const perCalendarMonthPence = Math.round(totalPence / span);

    // HOURLY. Only the entries that carry time are used — money AND minutes from the same
    // months. Dividing the full total by the minutes you happened to log would answer a
    // narrower question ("what did the logged months pay?") while being presented as the
    // rate for the whole stream, and it would flatter every stream you log rarely.
    const timed = mine.filter((e) => e.effort_minutes != null && e.effort_minutes > 0);
    const timedMinutes = timed.reduce((t, e) => t + e.effort_minutes, 0);
    const timedPence = timed.reduce((t, e) => t + e.amount_pence, 0);
    const hourlyPence = timedMinutes > 0 ? Math.round((timedPence * 60) / timedMinutes) : null;

    const currencyTotal = currencies.length === 1
      ? (byCurrency.get(currencies[0]) || { pence: 0 }).pence
      : null;

    return {
      ...base,
      state: 'ok',
      currency: currencies.length === 1 ? currencies[0] : 'mixed',
      currencies,
      totalPence,
      monthsRecorded: mine.length,
      firstPeriod: first,
      lastPeriod: last,
      calendarMonthsSpanned: span,
      monthsMissing: span - mine.length,
      monthsSinceLast,
      // A statement of fact with the number attached, not a verdict. "Quiet" never appears
      // without the month count beside it in the panel.
      staleness: monthsSinceLast <= 0 ? 'recorded this month'
        : monthsSinceLast === 1 ? 'last recorded last month'
          : `nothing for ${monthsSinceLast} months`,
      perRecordedMonthPence,
      perCalendarMonthPence,
      // Share of the same-currency total only. A share of a mixed total would be a ratio of
      // two different units.
      sharePct: currencyTotal ? Math.round((totalPence / currencyTotal) * 1000) / 10 : null,
      shareOfCurrency: currencies.length === 1 ? currencies[0] : null,
      timedMonths: timed.length,
      timedMinutes,
      timedPence,
      hourlyPence,
      worthIt: hourlyPence === null
        ? {
          state: 'no-effort',
          text: 'No time logged against this stream, so there is no hourly rate. Add minutes to an entry and it appears.',
        }
        : {
          state: 'computed',
          hourlyPence,
          // The inputs travel with the answer, so the division can be checked by hand.
          text: `from ${timed.length} of ${mine.length} recorded months, ${timedMinutes} min logged`,
          coverage: `${timed.length}/${mine.length} months timed`,
        },
    };
  });

  // Ranking among the streams that actually have a rate, within one currency. This is
  // arithmetic on your own numbers — a sort, not a score — and it is the only comparison
  // this module makes.
  const timedGBP = perStream.filter((s) => s.hourlyPence != null && s.currency && s.currency !== 'mixed');
  const byCur = new Map();
  for (const s of timedGBP) {
    const list = byCur.get(s.currency) || [];
    list.push(s);
    byCur.set(s.currency, list);
  }
  for (const [, list] of byCur) {
    list.sort((a, b) => b.hourlyPence - a.hourlyPence);
    const best = list[0];
    list.forEach((s, i) => {
      s.hourlyRank = { position: i + 1, of: list.length };
      if (list.length > 1 && s !== best) {
        s.hourlyRank.bestIs = { id: best.id, label: best.label, hourlyPence: best.hourlyPence };
      }
    });
  }

  // What is missing for the month in progress — the one genuinely actionable output, since
  // it tells you which dashboards are still worth opening.
  const recordedThisMonth = new Set(entries.filter((e) => e.period === now).map((e) => e.stream_id));
  const awaitingThisMonth = streams
    .filter((s) => s.active && !recordedThisMonth.has(s.id))
    .map((s) => ({ id: s.id, label: s.label }));

  // PROJECTION. Withheld on thin data rather than shown with a caveat, because a number on
  // the page is read as a number on the page. Six recorded months is the floor.
  const portfolioByPeriod = new Map();
  for (const e of entries) {
    if (mixedCurrency && e.currency !== currencyTotals[0].currency) continue;
    portfolioByPeriod.set(e.period, (portfolioByPeriod.get(e.period) || 0) + e.amount_pence);
  }
  const monthTotals = [...portfolioByPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let projection;
  if (monthTotals.length < 6) {
    projection = {
      state: 'too-thin',
      monthsRecorded: monthTotals.length,
      monthsNeeded: 6,
      message: `A run rate off ${monthTotals.length} month${monthTotals.length === 1 ? '' : 's'} is a guess wearing a number. `
        + `Nothing is projected until 6 months are recorded (${6 - monthTotals.length} to go).`,
    };
  } else {
    const lastSix = monthTotals.slice(-6).map(([, p]) => p);
    const med = median(lastSix);
    projection = {
      state: 'ok',
      medianMonthlyPence: med,
      annualisedPence: med * 12,
      currency: currencyTotals[0] ? currencyTotals[0].currency : null,
      // Stated, not implied. A projection must carry its basis or it reads as a fact.
      basis: `Median of your last 6 recorded months (${monthTotals.slice(-6)[0][0]}..${monthTotals[monthTotals.length - 1][0]}) x 12. `
        + 'A median, because one good month should not set the expectation. This is a projection, not a total — '
        + 'and months where you recorded only some streams drag it down.'
        + (mixedCurrency ? ` Only ${currencyTotals[0].currency} entries are included; the others are a different unit.` : ''),
    };
  }

  const grand = mixedCurrency ? null : (currencyTotals[0] ? currencyTotals[0].pence : 0);

  return {
    state: !streams.length ? 'no-streams' : (!entries.length ? 'no-entries' : 'ok'),
    month: now,
    streams: perStream,
    kinds: KINDS,
    totals: currencyTotals,
    mixedCurrency,
    grandTotalPence: grand,
    grandTotalCurrency: mixedCurrency ? null : (currencyTotals[0] ? currencyTotals[0].currency : 'GBP'),
    grandTotalNote: mixedCurrency
      ? `Entries are recorded in ${currencyTotals.map((c) => c.currency).join(' and ')}. `
        + 'They are not added together: this module has no exchange rate, and a made-up rate makes a made-up total.'
      : null,
    monthsRecorded: new Set(entries.map((e) => e.period)).size,
    firstPeriod: entries.length ? entries[0].period : null,
    lastPeriod: entries.length ? entries[entries.length - 1].period : null,
    entriesRecorded: entries.length,
    awaitingThisMonth,
    projection,
    // Said in the payload as well as the panel, because the panel is not the only reader.
    method: 'Every figure here is a sum, a count or a division of two numbers you entered. '
      + 'Nothing is weighted and nothing is scored — there is no judgement about what a good rate is.',
    scope: 'Bookkeeping only. Nothing here logs in to a service, and nothing automates the earning.',
  };
}

const router = express.Router();

// A route that throws must not answer like a route with nothing to say. Every handler that
// touches the derivation goes through this, so a broken query is a 500 with a message the
// panel prints — never an empty table that reads as good news.
const guard = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message, where: 'income module' });
  }
};

// ---------------------------------------------------------------------------- summary
router.get('/', guard((req, res) => res.json(summarise())));

// ---------------------------------------------------------------------------- streams
router.get('/streams', guard((req, res) => {
  const rows = db.prepare('SELECT * FROM income_streams ORDER BY active DESC, label').all();
  res.json({ state: rows.length ? 'ok' : 'empty', kinds: KINDS, streams: rows });
}));

router.post('/streams', guard((req, res) => {
  const { label, kind, note } = req.body || {};
  const name = String(label || '').trim();
  if (!name) return res.status(400).json({ error: 'label is required' });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });

  const id = slugify((req.body && req.body.id) || name);
  if (!id) return res.status(400).json({ error: 'label must contain at least one letter or digit' });

  const existing = db.prepare('SELECT id, label FROM income_streams WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: `"${id}" already exists (${existing.label})` });

  db.prepare('INSERT INTO income_streams (id, label, kind, active, note) VALUES (?, ?, ?, 1, ?)')
    .run(id, name, kind, note ? String(note) : null);
  res.status(201).json({ id, label: name, kind, active: true });
}));

// Not in the original endpoint list, but without it `active` is a column that can never
// change — and a stream you have stopped must be able to stop being counted as quiet.
router.post('/streams/:id/active', guard((req, res) => {
  const active = (req.body || {}).active ? 1 : 0;
  const r = db.prepare('UPDATE income_streams SET active = ? WHERE id = ?').run(active, req.params.id);
  if (!r.changes) return res.status(404).json({ error: `no such stream "${req.params.id}"` });
  res.json({ id: req.params.id, active: !!active, note: 'Entries are kept. Inactive only stops it being chased for the current month.' });
}));

// ---------------------------------------------------------------------------- entries
router.get('/entries', guard((req, res) => {
  const months = Math.min(120, Math.max(1, Number(req.query.months) || 12));
  const from = shiftMonth(thisMonth(), -(months - 1));

  const stream = req.query.stream ? String(req.query.stream) : null;
  if (stream) {
    // "No such stream" and "a stream with no entries" are different answers, and an empty
    // list for a typo'd slug would look like the second.
    const s = db.prepare('SELECT id FROM income_streams WHERE id = ?').get(stream);
    if (!s) return res.status(404).json({ error: `no such stream "${stream}"` });
  }

  const rows = stream
    ? db.prepare(
      `SELECT e.*, s.label FROM income_entries e JOIN income_streams s ON s.id = e.stream_id
        WHERE e.stream_id = ? AND e.period >= ? ORDER BY e.period DESC, s.label`
    ).all(stream, from)
    : db.prepare(
      `SELECT e.*, s.label FROM income_entries e JOIN income_streams s ON s.id = e.stream_id
        WHERE e.period >= ? ORDER BY e.period DESC, s.label`
    ).all(from);

  const totals = [...rows.reduce((m, r) => m.set(r.currency, (m.get(r.currency) || 0) + r.amount_pence), new Map())]
    .map(([currency, pence]) => ({ currency, pence }));

  res.json({
    state: rows.length ? 'ok' : 'empty',
    // Empty needs its window stated, or "nothing here" is mistaken for "nothing ever".
    message: rows.length ? null : `No entries in the ${months} months from ${from}.`,
    stream,
    months,
    from,
    totals,
    entries: rows,
  });
}));

router.post('/entries', guard((req, res) => {
  const { stream, period, amount, minutes, currency } = req.body || {};

  const s = db.prepare('SELECT id, label FROM income_streams WHERE id = ?').get(String(stream || ''));
  if (!s) return res.status(404).json({ error: `no such stream "${stream}" — add it first` });

  const p = MONTH_RE.test(period || '') ? period : thisMonth();
  if (period && !MONTH_RE.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
  // A future month is a typo, not a forecast. Accepting it would put money in a month that
  // has not happened and quietly move every "months since last paid" figure.
  if (monthsBetween(thisMonth(), p) > 0) return res.status(400).json({ error: `${p} is in the future` });

  const pence = Math.round(Number(amount) * 100);
  if (!Number.isFinite(pence) || pence < 0) {
    return res.status(400).json({ error: 'amount must be a non-negative number of pounds (or of the currency you name)' });
  }

  // Optional. Absent stays NULL — it must not become 0, which would claim the money took
  // no time and produce an infinite hourly rate.
  let mins = null;
  if (minutes !== undefined && minutes !== null && minutes !== '') {
    mins = Math.round(Number(minutes));
    if (!Number.isFinite(mins) || mins < 0) return res.status(400).json({ error: 'minutes must be a non-negative number' });
  }

  const cur = String(currency || 'GBP').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return res.status(400).json({ error: 'currency must be a three-letter code, e.g. GBP or USD' });

  // Upsert. The previous value is returned so an accidental overwrite is visible rather
  // than silent — this is the one endpoint that can destroy a figure you entered.
  const prev = db.prepare('SELECT amount_pence, currency, effort_minutes FROM income_entries WHERE stream_id = ? AND period = ?')
    .get(s.id, p);

  db.prepare(
    `INSERT INTO income_entries (stream_id, period, amount_pence, currency, effort_minutes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(stream_id, period) DO UPDATE SET
       amount_pence = excluded.amount_pence,
       currency = excluded.currency,
       -- Omitting minutes on an update keeps what was already logged; it is not a request
       -- to delete it. Send minutes: 0 explicitly to clear the rate.
       effort_minutes = COALESCE(excluded.effort_minutes, income_entries.effort_minutes),
       recorded_at = datetime('now', 'localtime')`
  ).run(s.id, p, pence, cur, mins);

  // Read back rather than echo the request. On an update that omitted minutes the COALESCE
  // keeps the time already logged, so echoing `mins` would report null for a row that has
  // 30 in it — the response would describe the request, not the database.
  const saved = db.prepare('SELECT id, amount_pence, currency, effort_minutes FROM income_entries WHERE stream_id = ? AND period = ?')
    .get(s.id, p);

  res.status(201).json({
    id: saved.id,
    stream: s.id,
    period: p,
    amountPence: saved.amount_pence,
    currency: saved.currency,
    effortMinutes: saved.effort_minutes,
    replaced: prev ? { amountPence: prev.amount_pence, currency: prev.currency, effortMinutes: prev.effort_minutes } : null,
  });
}));

router.delete('/entries/:id', guard((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
  const row = db.prepare('SELECT * FROM income_entries WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'no such entry' });
  db.prepare('DELETE FROM income_entries WHERE id = ?').run(id);
  res.json({ deleted: id, was: { stream: row.stream_id, period: row.period, amountPence: row.amount_pence, currency: row.currency } });
}));

// What has actually been earned, for the briefing.
//
// IT IS SILENT UNTIL THERE IS MONEY, and that is the design rather than a limitation. The
// portfolio has five streams and has earned nothing since it started; a line that says "£0"
// every morning for months is a line the reader stops seeing, and then the morning it finally
// says £4.20 they will skip that too. So this reports the facts and the briefing prints nothing
// when they are all zero.
//
// `everPence` exists so the FIRST pound can be told apart from the hundredth. The first sale a
// project ever makes is the single most important event this dashboard can report, and it is
// indistinguishable from any other Tuesday if you only look at the period total.
function earnedSince(sinceISO) {
  const since = String(sinceISO || '').slice(0, 10);

  const ever = db.prepare('SELECT COALESCE(SUM(amount_pence), 0) AS p, COUNT(*) AS n FROM income_entries').get();
  const period = since
    ? db.prepare('SELECT COALESCE(SUM(amount_pence), 0) AS p, COUNT(*) AS n FROM income_entries WHERE period >= ?').get(since)
    : { p: 0, n: 0 };

  const streams = db.prepare('SELECT COUNT(*) AS n FROM income_streams WHERE active = 1').get().n;

  // Per stream, only for the period, so a briefing can name where it came from rather than
  // reporting a total nobody can attribute.
  const byStream = since
    ? db.prepare(`SELECT s.label AS label, COALESCE(SUM(e.amount_pence), 0) AS p, COUNT(e.id) AS n
                  FROM income_entries e JOIN income_streams s ON s.id = e.stream_id
                  WHERE e.period >= ? GROUP BY s.id ORDER BY p DESC`).all(since)
    : [];

  return {
    since: since || null,
    periodPence: period.p,
    periodEntries: period.n,
    everPence: ever.p,
    everEntries: ever.n,
    activeStreams: streams,
    byStream,
    // The distinction the briefing needs to decide whether to shout.
    firstEver: period.n > 0 && ever.n === period.n,
  };
}

// ---- attribution: which payer belongs to which stream -------------------------------------
//
// SerpClix pays through PayPal, and until tonight the ledger could not say so: the bank line
// reads PAYPAL and nothing else. tools/import-paypal.cjs brings in the sender name, and this is
// the part that says "a credit from SerpClix is income on the serpclix stream".
//
// THIS MODULE STORES NO AMOUNTS. The money lives in finance_transactions and it lives there
// once. What income owns is the ATTRIBUTION -- the pattern that maps a payer to a stream -- and
// the totals below are computed on demand from finance's rows rather than copied into
// income_entries. A copy would be a second place the same figure lives, and the two would
// disagree the first time a transaction was recategorised.
//
// income_entries stays for manual entry: a cash job, or a platform that never touches a payment
// processor. Derived and entered figures are reported separately and never summed into one
// number, because they answer different questions and have different reliability.
db.migrate('income-attribution', [
  (d) => {
    d.exec(`
      CREATE TABLE income_stream_payers (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        pattern   TEXT NOT NULL,          -- matched against counterparty, case-insensitive
        note      TEXT,
        added_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_payer_stream_pattern ON income_stream_payers (stream_id, pattern);
    `);
    // Seeded from the streams that already exist. These are the names the platforms actually
    // use as PayPal senders; anything wrong here shows up as an unattributed payer in the
    // report below rather than as a silently missing figure.
    const seed = [
      ['serpclix', 'serpclix', 'pays out through PayPal, monthly on the 1st'],
      ['honeygain', 'honeygain', null],
      ['packetstream', 'packetstream', null],
      ['coinbase', 'coinbase', null],
      ['paypal', 'payhip', 'PrintProfit sales arrive from Payhip'],
    ];
    const ins = d.prepare('INSERT INTO income_stream_payers (stream_id, pattern, note) VALUES (?, ?, ?)');
    for (const s of seed) ins.run(s[0], s[1], s[2]);
  },
]);

// What the ledger says each stream has actually been paid.
//
// It reports UNATTRIBUTED payers too, and that is the point rather than a nicety: a platform
// whose sender name does not match any pattern would otherwise contribute nothing and look
// exactly like a platform that paid nothing. The residue is where a missing pattern becomes
// visible.
//
// Transfers are excluded. A withdrawal from PayPal to the bank is the owner's own money moving
// between his own accounts; counting it as income would double every payout, once when it
// arrives at PayPal and again when it reaches the bank.
function derivedFromLedger(sinceISO) {
  const since = String(sinceISO || '').slice(0, 10) || '1970-01-01';
  let rows;
  try {
    rows = db.prepare(`
      SELECT counterparty, date, amount_pence, category
      FROM finance_transactions
      WHERE amount_pence > 0 AND date >= ?
        AND (category IS NULL OR category != 'Own transfer')
      ORDER BY date DESC`).all(since);
  } catch (e) {
    return { state: 'could-not-read', why: e.message };
  }

  const pats = db.prepare('SELECT stream_id, pattern FROM income_stream_payers').all();
  const streams = new Map(db.prepare('SELECT id, label FROM income_streams').all().map((s) => [s.id, s.label]));

  const byStream = new Map();
  const unattributed = new Map();

  for (const r of rows) {
    const who = String(r.counterparty || '').toLowerCase();
    const hit = pats.find((p) => who.includes(String(p.pattern).toLowerCase()));
    if (hit) {
      const cur = byStream.get(hit.stream_id) || { pence: 0, n: 0, first: r.date, last: r.date };
      cur.pence += r.amount_pence;
      cur.n += 1;
      if (r.date < cur.first) cur.first = r.date;
      if (r.date > cur.last) cur.last = r.date;
      byStream.set(hit.stream_id, cur);
    } else {
      const cur = unattributed.get(who) || { pence: 0, n: 0 };
      cur.pence += r.amount_pence;
      cur.n += 1;
      unattributed.set(who, cur);
    }
  }

  const attributed = [...byStream.entries()].map(([id, v]) => ({
    stream: id, label: streams.get(id) || id, ...v,
  })).sort((a, b) => b.pence - a.pence);

  return {
    state: 'ok',
    since,
    attributed,
    attributedPence: attributed.reduce((a, s) => a + s.pence, 0),
    unattributed: [...unattributed.entries()]
      .map(([who, v]) => ({ who, ...v }))
      .sort((a, b) => b.pence - a.pence).slice(0, 15),
    unattributedPence: [...unattributed.values()].reduce((a, v) => a + v.pence, 0),

    // THE RESIDUE BY VALUE IS THE WRONG PLACE TO LOOK FOR A MISSING STREAM, and sorting it by
    // amount hides exactly what it was added to reveal. Measured over the real ledger, the
    // unattributed total is £160k of wages, DWP payments and security-firm invoices; a £12
    // SerpClix payout sits invisibly at the bottom of that list.
    //
    // So this is the second view, and the rule is stated rather than tuned: a payer seen three
    // or more times averaging under £50 looks like a micro-income platform rather than an
    // employer. Both numbers are printed beside every row so the rule can be argued with.
    likelyStreams: [...unattributed.entries()]
      .map(([who, v]) => ({ who, ...v, avgPence: Math.round(v.pence / v.n) }))
      .filter((v) => v.n >= 3 && v.avgPence < 5000)
      .sort((a, b) => b.n - a.n).slice(0, 15),

    note: 'Derived from finance_transactions, which owns these amounts. Nothing is copied here. '
      + 'Transfers are excluded so a payout is not counted twice. Two residues are reported: '
      + 'unattributed by value, which is dominated by wages and benefits, and likelyStreams, '
      + 'which is where a missing platform pattern actually shows up (3+ payments averaging '
      + 'under £50). A missing pattern and a platform that paid nothing look identical without them.',
  };
}


module.exports = router;
module.exports.derivedFromLedger = derivedFromLedger;
module.exports.KINDS = KINDS;
module.exports.earnedSince = earnedSince;
