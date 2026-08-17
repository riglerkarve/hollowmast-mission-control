const express = require('express');
const db = require('../db');

// Health. Samsung Health export primary, Health Connect fallback — Google Fit is closed
// and irrelevant (workspace CLAUDE.md, settled 17 Aug).
//
// A long table rather than one wide row per day, because the two sources fill in
// different metrics at different times: a watch supplies steps and sleep, a manual entry
// supplies weight. A wide row would make one source overwrite the other's NULLs, and the
// day a manual weight vanished because an import ran would be very hard to notice.
//
// Precedence matches the ledger: manual beats import, always.

db.migrate('health', [
  (d) => {
    d.exec(`
      CREATE TABLE health_metrics (
        date       TEXT NOT NULL,          -- ISO date
        metric     TEXT NOT NULL,          -- steps | sleep_minutes | resting_hr | weight_grams
        value      INTEGER NOT NULL,       -- INTEGER, always: grams not kilos, minutes not hours
        source     TEXT NOT NULL,          -- 'samsung' | 'manual'
        recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (date, metric)
      );

      CREATE INDEX idx_health_metric ON health_metrics(metric, date);
    `);
  },
]);

// Units are in the metric name so a value can never be misread. weight_grams, never
// "weight"; sleep_minutes, never "sleep". Same discipline as amount_pence.
// These MUST match what tools/import-samsung-health.cjs actually writes. They drifted once
// — the route still advertised `resting_hr` after the importer dropped it, so a metric the
// panel offered returned "unknown metric" and the two only disagreed at runtime.
//
// There is no resting heart rate in the Samsung export. Naming one here would invite
// exactly the fabrication the importer was careful to avoid: hr_min is the lowest spot
// reading of the day, which is a different measure and is labelled as one.
const METRICS = {
  steps: { label: 'Steps', unit: '', dp: 0, source: 'samsung' },
  sleep_minutes: { label: 'Sleep recorded', unit: 'min', dp: 0, source: 'samsung',
    caveat: 'Naps and split nights are summed per day, so this is total sleep recorded, not one night.' },
  hr_min: { label: 'Lowest heart rate', unit: 'bpm', dp: 0, source: 'samsung',
    caveat: 'The lowest spot reading of the day. NOT a resting heart rate — the export does not contain one.' },
  hr_median: { label: 'Median heart rate', unit: 'bpm', dp: 0, source: 'samsung' },
  // No import source exists for these; they are manual-entry only, and saying so stops
  // an empty chart reading as "no activity".
  weight_grams: { label: 'Weight', unit: 'kg', dp: 2, divide: 1000, source: 'manual only' },
  meals: { label: 'Proper meals', unit: '', dp: 0, source: 'manual only' },
};

const router = express.Router();

router.get('/metrics', (req, res) => res.json(METRICS));

// The state of the module, said plainly. "No export imported yet" and "the import ran and
// found nothing" are different facts and must not render as the same empty panel.
router.get('/summary', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM health_metrics').get().c;

  if (!total) {
    return res.json({
      state: 'no-data',
      message: 'No health data has been imported or entered yet.',
      whatIsNeeded: 'Samsung Health > Settings > Download personal data. Then run '
        + 'tools/import-samsung-health.cjs --inspect <folder> to see what the export contains.',
      metrics: METRICS,
    });
  }

  const perMetric = db.prepare(
    `SELECT metric, COUNT(*) days, MIN(date) first, MAX(date) last,
            SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) manual
       FROM health_metrics GROUP BY metric`
  ).all();

  const last = db.prepare('SELECT MAX(date) d FROM health_metrics').get().d;
  const staleDays = Math.round((Date.now() - new Date(last).getTime()) / 86400000);

  res.json({
    state: 'ok',
    total,
    lastDate: last,
    staleDays,
    // An export is a snapshot, not a feed — the same trap the ledger has. Say how old it is.
    stale: staleDays > 7,
    perMetric: perMetric.map((m) => ({ ...m, ...METRICS[m.metric] })),
    metrics: METRICS,
  });
});

// WAS THE WATCH ON? A zero-step day and a day the watch sat on a desk are the same row,
// and only one of them means you did not walk. Heart rate is an independent witness: if
// the watch took readings, it was on the wrist.
//
// Measured on the real import: all 27 zero-step days had NO heart-rate readings at all.
// Every zero was a missing day. Counting them drags the median from 1,689 to 1,293 — a
// 31% understatement of a figure you would otherwise read as fact.
//
// The rows are NOT deleted: the export really did say zero, and that is worth keeping.
// They are marked, and excluded from summary statistics, which is a different thing.
function wornDates() {
  return new Set(
    db.prepare("SELECT DISTINCT date FROM health_metrics WHERE metric IN ('hr_median','hr_min')")
      .all().map((r) => r.date)
  );
}

router.get('/series', (req, res) => {
  const metric = String(req.query.metric || '');
  if (!METRICS[metric]) return res.status(400).json({ error: `unknown metric "${metric}"` });
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));

  const rows = db.prepare(
    `SELECT date, value, source FROM health_metrics
      WHERE metric = ? AND date >= date('now', 'localtime', ?)
      ORDER BY date`
  ).all(metric, `-${days} days`);

  const worn = wornDates();
  const points = rows.map((r) => ({
    ...r,
    // Only steps can be faked by a zero — a heart rate of 0 is not recorded at all.
    noData: metric === 'steps' && r.value === 0 && !worn.has(r.date),
  }));

  const real = points.filter((p) => !p.noData).map((p) => p.value).sort((a, b) => a - b);
  const withAll = points.map((p) => p.value).sort((a, b) => a - b);
  const mid = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);

  res.json({
    metric,
    ...METRICS[metric],
    days,
    points,
    stats: {
      daysWithData: real.length,
      daysNoData: points.length - real.length,
      median: mid(real),
      // Both figures, named, so the gap between them is visible rather than argued about.
      medianIfZerosCounted: mid(withAll),
      note: points.length === real.length
        ? 'Every day in this range has data.'
        : `${points.length - real.length} day(s) recorded zero steps with no heart-rate readings — `
          + 'the watch was not worn. Those are excluded from the median, because they are '
          + 'missing data rather than days without walking.',
    },
  });
});

// Manual entry — the path that works with no export, no account and no approval.
router.post('/metrics', (req, res) => {
  const { date, metric, value } = req.body || {};
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);

  if (!METRICS[metric]) return res.status(400).json({ error: `unknown metric "${metric}"` });
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'value must be a non-negative number' });

  db.prepare(
    `INSERT INTO health_metrics (date, metric, value, source) VALUES (?, ?, ?, 'manual')
     ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value, source = 'manual',
       recorded_at = datetime('now', 'localtime')`
  ).run(d, metric, v);

  res.status(201).json({ date: d, metric, value: v, source: 'manual' });
});

module.exports = router;
module.exports.METRICS = METRICS;
