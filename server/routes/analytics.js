'use strict';
//
// analytics.js — how the two published sites are actually doing.
//
// Owner request 18 Aug 2026, the second half of "live analytics ... and other systems stats".
// The first half became the machine module; this half is different in kind, because the numbers
// people mean by "analytics" live behind credentials only the owner can create.
//
// SO IT IS BUILT IN TWO HALVES, AND THE FIRST NEEDS NOTHING.
//
//   DERIVED, zero input: is the site up, what does it serve, how big is it, does it declare a
//   sitemap and a robots.txt, and is it indexable. Probed on a timer and kept, so a fortnight
//   of it becomes a record of when something broke rather than a snapshot.
//
//   IMPORTED, manual: clicks and impressions from a Search Console or Cloudflare export. The
//   architecture rule is manual-first for anything with an external dependency — build the
//   version that works with no API, no account and no approval, and add the integration later
//   as an accelerator once real use has shown what the friction costs.
//
// THE SOURCE IS DECLARED, NEVER SNIFFED. An importer that guesses which export it has been
// handed is the same defect as a filename that cannot identify an account: two exports look
// alike, the wrong guess is unrecoverable, and nothing errors. Every imported row carries the
// source the caller stated.
//
// THREE SOURCES, NEVER MERGED. PrintProfit has Cloudflare Web Analytics and Search Console;
// HOLLOWMAST has its own report worker. They count different things over different populations,
// so this module reports each separately and computes no combined total. A single "visitors"
// figure across them would be the kind of number nobody can audit.
//
// IT DOES NOT OWN THE PROJECT LIST. `projects.js` does, and the public URL is a project
// attribute declared there. This module asks for it.
const express = require('express');
const db = require('../db');
const provenance = require('../provenance');
const { PROJECTS } = require('./projects');

const router = express.Router();

db.migrate('analytics', [
  (d) => {
    d.exec(`
      CREATE TABLE analytics_probes (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       TEXT NOT NULL,           -- ISO, when the probe ran
        project  TEXT NOT NULL,           -- projects.js id
        url      TEXT NOT NULL,
        status   INTEGER,                 -- HTTP status, null if it could not be reached
        ms       INTEGER,                 -- round trip
        bytes    INTEGER,                 -- of the document only
        indexable INTEGER,                -- 1/0/null: null means the check could not run
        why      TEXT                     -- why a field above is null. Never left empty on failure.
      );
      CREATE INDEX idx_probe_project_at ON analytics_probes (project, at DESC);
    `);
  },
  (d) => {
    d.exec(`
      CREATE TABLE analytics_traffic (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT NOT NULL,        -- DECLARED by the caller: 'search-console' | 'cloudflare' | 'report-worker'
        project     TEXT NOT NULL,
        day         TEXT NOT NULL,        -- YYYY-MM-DD
        clicks      INTEGER,
        impressions INTEGER,
        note        TEXT,
        at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_traffic_key ON analytics_traffic (source, project, day);
    `);
    provenance.addColumn(d, 'analytics_traffic');
  },
]);

// Declared vocabulary. An import naming anything else is refused rather than filed as 'other',
// because a row whose provenance is a guess is worse than a row that was never accepted.
const SOURCES = ['search-console', 'cloudflare', 'report-worker'];

const PROBE_EVERY_MS = 15 * 60 * 1000;    // network calls; a 15-minute cadence is plenty
const live = () => PROJECTS.filter((p) => p.live);

async function probeOne(p) {
  const started = Date.now();
  const row = { at: new Date().toISOString(), project: p.id, url: p.live, status: null, ms: null, bytes: null, indexable: null, why: null };
  try {
    const ctl = AbortSignal.timeout(12000);
    const res = await fetch(p.live, { redirect: 'follow', signal: ctl });
    const body = await res.text();
    row.status = res.status;
    row.ms = Date.now() - started;
    row.bytes = Buffer.byteLength(body, 'utf8');
    // Indexability is read out of the document that was actually served, not assumed from the
    // repository. A noindex shipped by accident is exactly the thing this should catch.
    const noindex = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(body);
    row.indexable = noindex ? 0 : 1;
    if (noindex) row.why = 'the served document carries a robots noindex';
  } catch (e) {
    row.ms = Date.now() - started;
    row.why = `could not reach it: ${String(e && e.message || e).slice(0, 120)}`;
  }
  return row;
}

function save(row) {
  db.prepare(`INSERT INTO analytics_probes (at, project, url, status, ms, bytes, indexable, why)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.at, row.project, row.url, row.status, row.ms, row.bytes, row.indexable, row.why);
}

async function probeAll() {
  const rows = await Promise.all(live().map(probeOne));
  for (const r of rows) save(r);
  return rows;
}

const timer = setInterval(() => { probeAll().catch(() => {}); }, PROBE_EVERY_MS);
if (timer.unref) timer.unref();

// GET /api/analytics — the state of each published site, plus whatever traffic has been imported.
router.get('/', (req, res) => {
  const sites = live().map((p) => {
    const latest = db.prepare('SELECT * FROM analytics_probes WHERE project = ? ORDER BY at DESC LIMIT 1').get(p.id) || null;
    const recent = db.prepare('SELECT at, status, ms, bytes FROM analytics_probes WHERE project = ? ORDER BY at DESC LIMIT 96').all(p.id).reverse();
    const n = db.prepare('SELECT COUNT(*) AS c FROM analytics_probes WHERE project = ?').get(p.id).c;
    return {
      project: p.id, name: p.name, url: p.live, latest, recent,
      probeCount: n,
      // Distinguishes "never probed" from "probed and fine". A site with no history is not a
      // healthy site, it is an unmeasured one.
      state: n === 0 ? 'never probed' : (latest && latest.status === 200 ? 'ok' : 'attention'),
    };
  });

  const traffic = db.prepare(`SELECT source, project, COUNT(*) AS days, MIN(day) AS from_day, MAX(day) AS to_day,
                                     SUM(clicks) AS clicks, SUM(impressions) AS impressions
                              FROM analytics_traffic GROUP BY source, project ORDER BY source, project`).all();

  res.json({
    sites,
    probeEveryMs: PROBE_EVERY_MS,
    traffic,
    sources: SOURCES,
    // Absence, stated rather than drawn as a zero.
    trafficState: traffic.length ? 'imported' : 'none imported',
    trafficNote: traffic.length ? null
      : 'No traffic figures have been imported. Nothing is broken: Cloudflare Web Analytics '
        + 'needs an API token and Search Console needs OAuth consent, and neither can be created '
        + 'by a session. Export a CSV from either and POST it to /api/analytics/traffic with the '
        + 'source declared, or leave this empty — the site checks above need none of it.',
    caveat: 'The probes measure what the public URL serves right now. They say nothing about how '
      + 'many people visited, and a green row is not an audience.',
  });
});

// POST /api/analytics/probe — probe now rather than waiting for the timer.
router.post('/probe', async (req, res) => {
  try {
    const rows = await probeAll();
    res.json({ probed: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: `probe failed: ${e.message}` });
  }
});

// POST /api/analytics/traffic — import rows. The source is required and validated.
router.post('/traffic', (req, res) => {
  const b = req.body || {};
  const source = String(b.source || '').trim();
  const project = String(b.project || '').trim();
  const rows = Array.isArray(b.rows) ? b.rows : null;

  if (!SOURCES.includes(source)) return res.status(400).json({ error: `source must be one of ${SOURCES.join(', ')} — it is declared, never inferred` });
  if (!PROJECTS.some((p) => p.id === project)) return res.status(400).json({ error: `unknown project '${project}'` });
  if (!rows || !rows.length) return res.status(400).json({ error: 'send rows: [{ day, clicks, impressions, note? }]' });

  const stmt = db.prepare(`INSERT INTO analytics_traffic (source, project, day, clicks, impressions, note, at, by_whom)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, project, day) DO UPDATE SET
      clicks = excluded.clicks, impressions = excluded.impressions, note = excluded.note,
      at = excluded.at, by_whom = excluded.by_whom`);

  const at = new Date().toISOString();
  let accepted = 0;
  const rejected = [];
  db.withTransaction(() => {
    rows.forEach((r, i) => {
      const day = String(r && r.day || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { rejected.push({ i, why: `day '${day}' is not YYYY-MM-DD` }); return; }
      const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined));
      const c = num(r.clicks); const im = num(r.impressions);
      if (c === undefined || im === undefined) { rejected.push({ i, why: 'clicks/impressions must be numbers or blank' }); return; }
      stmt.run(source, project, day, c, im, r.note == null ? null : String(r.note).slice(0, 200), at, req.by || 'unknown');
      accepted += 1;
    });
  });

  // A filter must report its residue: what was dropped, and why, in the same answer.
  res.json({
    accepted,
    rejected,
    source,
    project,
    note: rejected.length
      ? `${rejected.length} row(s) were not stored and are listed above.`
      : 'Every row was stored.',
  });
});

// GET /api/analytics/traffic — the imported rows, per source, never combined across sources.
router.get('/traffic', (req, res) => {
  const source = req.query.source ? String(req.query.source) : null;
  if (source && !SOURCES.includes(source)) return res.status(400).json({ error: `unknown source '${source}'` });
  const rows = source
    ? db.prepare('SELECT * FROM analytics_traffic WHERE source = ? ORDER BY day DESC LIMIT 400').all(source)
    : db.prepare('SELECT * FROM analytics_traffic ORDER BY day DESC LIMIT 400').all();
  res.json({
    rows,
    count: rows.length,
    sources: SOURCES,
    note: 'Grouped by source on purpose. Cloudflare counts visits, Search Console counts '
      + 'impressions of a result, and the report worker counts game sessions. Summing them '
      + 'would produce a number with no meaning.',
  });
});

// DELETE /api/analytics/traffic — undo an import.
//
// Added because building this module without it was a mistake I had to reach past the API to
// fix: a test import put numbers I had invented into the real table, and there was no route to
// take them out again. A manual-import surface with no undo guarantees the first typo becomes
// permanent, and a wrong number in an analytics table is worse than a missing one.
//
// Every field is required and there is deliberately no delete-all. A range delete would be
// convenient about twice and catastrophic once.
router.delete('/traffic', (req, res) => {
  const source = String(req.query.source || '').trim();
  const project = String(req.query.project || '').trim();
  const day = String(req.query.day || '').trim();
  if (!SOURCES.includes(source)) {
    return res.status(400).json({ error: `source must be one of ${SOURCES.join(', ')}` });
  }
  if (!PROJECTS.some((p) => p.id === project)) {
    return res.status(400).json({ error: `unknown project '${project}'` });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
  }
  const r = db.prepare('DELETE FROM analytics_traffic WHERE source = ? AND project = ? AND day = ?')
    .run(source, project, day);
  // .changes is rows MATCHED. Reporting it plainly means a delete that hit nothing says so,
  // rather than returning the same cheerful answer as one that removed a row.
  res.json({
    deleted: r.changes,
    matched: r.changes > 0,
    source,
    project,
    day,
    note: r.changes ? null : 'Nothing matched, so nothing was deleted.',
  });
});

// Published sites whose most recent probe was not a clean 200, for the briefing.
//
// It reports the LAST PROBE rather than testing the site now, and that is deliberate on two
// counts. The briefing runs at a fixed hour and must not depend on the network being up at that
// second; and a site that recovered an hour ago is not news, while one that has been down since
// the last probe is.
//
// A project that has never been probed is reported as such rather than counted as healthy. An
// unmeasured site is not a working one, and that distinction is the reason this returns a
// reason string instead of a boolean.
function notOk() {
  const out = [];
  for (const p of PROJECTS.filter((x) => x.live)) {
    const row = db.prepare(
      'SELECT at, status, ms, why FROM analytics_probes WHERE project = ? ORDER BY at DESC LIMIT 1'
    ).get(p.id);

    if (!row) {
      out.push({ name: p.name, at: 'never', detail: 'never probed, so its state is unknown rather than good' });
      continue;
    }
    if (row.status !== 200) {
      const detail = row.status == null
        ? (row.why || 'could not be reached')
        : `returned ${row.status}`;
      out.push({ name: p.name, at: String(row.at).slice(0, 16).replace('T', ' '), detail });
    }
  }
  return { down: out, checked: PROJECTS.filter((x) => x.live).length };
}

module.exports = router;
module.exports.notOk = notOk;
