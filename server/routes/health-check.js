'use strict';
//
// health-check.js — detect broken panels before someone clicks into them.
//
// GET /api/health-check — returns { panels: [{ name, js: ok|missing|empty,
//   css: ok|missing, api: ok|down|n/a, status: 'healthy'|'broken'|'unchecked' }],
//   counts, unmappedPanels, checkedAgainst }
//
// This header said `/api/health/panels` until 23 Aug 2026. The router is mounted at
// /api/health-check (server/index.js:145) and always was, so the file was carrying a false
// claim about itself — the exact class of thing the H-batch items exist to catch.
//
// The dashboard has 22+ panels. A broken panel shows "failed to load" only
// after you click it. This route checks all panels upfront: does the JS file
// exist and parse? Does the CSS file exist? Does the panel's API route
// respond? Broken panels are flagged so they can be hidden or fixed before
// the owner encounters them.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const router = express.Router();

const PANELS_DIR = path.join(__dirname, '..', '..', 'public', 'panels');

// Map panel names to their API routes. Not every panel has a dedicated API.
const PANEL_API = {
  focus: '/api/stats/summary', board: '/api/board', team: '/api/team/report',
  finance: '/api/finance/summary', budget: '/api/budget', income: '/api/income',
  lifestyle: '/api/lifestyle', wellbeing: '/api/wellbeing/quiet', brain: '/api/brain',
  mail: '/api/mail', work: '/api/work', exercise: '/api/exercise/sessions',
  safety: '/api/safety', browsing: '/api/browsing', atlas: '/api/atlas',
  goals: '/api/goals', schedule: '/api/schedule', projects: '/api/projects',
  machine: '/api/machine', analytics: '/api/analytics', voice: '/api/voice/status',
  briefing: '/api/briefing/morning', activity: '/api/activity/stream',
  inbox: '/api/inbox/threads',
};

router.get('/', async (req, res) => {
  const panels = [];

  // Read the panels directory.
  let dirs = [];
  try { dirs = fs.readdirSync(PANELS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return res.json({ panels: [], error: 'Cannot read panels directory.' }); }

  for (const name of dirs) {
    const panelDir = path.join(PANELS_DIR, name);
    const jsPath = path.join(panelDir, `${name}.js`);
    const cssPath = path.join(panelDir, `${name}.css`);

    let jsStatus = 'ok', cssStatus = 'ok', apiStatus = 'n/a';

    // Check JS exists and is non-empty.
    try {
      const stat = fs.statSync(jsPath);
      if (stat.size === 0) jsStatus = 'empty';
    } catch { jsStatus = 'missing'; }

    // Check CSS exists.
    try {
      fs.statSync(cssPath);
    } catch { cssStatus = 'missing'; }

    // Check API responds.
    const apiRoute = PANEL_API[name];
    if (apiRoute) {
      try {
        const r = await fetch(`http://127.0.0.1:3000${apiRoute}`, { signal: AbortSignal.timeout(5000) });
        apiStatus = r.ok ? 'ok' : 'down';
      } catch { apiStatus = 'down'; }
    }

    // THE api FIELD WAS COLLECTED AND THEN LEFT OUT OF THIS EXPRESSION, which made the one
    // signal that catches a genuinely broken panel inert. Measured 23 Aug 2026: the api tally
    // was { ok: 22, 'n/a': 45, down: 2 } and BOTH panels with a dead API -- exercise and work
    // -- were reported healthy. Confirmed off a different route than the one making the claim:
    // GET /api/exercise/sessions and GET /api/work both answer 404, while seven other mapped
    // routes answer 200, so the probe discriminates and the two are real findings.
    //
    // `n/a` DOES NOT MEAN "this panel has no API". It means the panel is not in PANEL_API,
    // which is 23 hand-written names against 69 panels on disk -- so it means "nobody wrote
    // this one down". Scoring an unchecked panel as broken would be as wrong as scoring it
    // healthy, so it gets its own verdict instead of being folded into either. Three states,
    // three names: looked and it was fine, looked and it was down, did not look.
    const status = (jsStatus !== 'ok' || cssStatus === 'missing') ? 'broken'
      : apiStatus === 'down' ? 'broken'
        : apiStatus === 'ok' ? 'healthy'
          : 'unchecked';
    panels.push({ name, js: jsStatus, css: cssStatus, api: apiStatus, status });
  }

  // Sort: broken first, then unchecked, then healthy, then alphabetical. Broken leads because
  // it is the thing to act on; unchecked sits above healthy so the size of the blind spot is
  // the second thing seen rather than something you have to go looking for.
  const rank = { broken: 0, unchecked: 1, healthy: 2 };
  panels.sort((a, b) => {
    if (a.status !== b.status) return (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    return a.name.localeCompare(b.name);
  });

  // THE COUNTS ARE THE RESIDUE REPORT. A caller that renders only `panels` still works, but a
  // caller summarising this route can no longer say "all N healthy" without saying how many
  // were never checked -- which is what /api/health-score was doing while two panels were down.
  const counts = { total: panels.length, healthy: 0, broken: 0, unchecked: 0 };
  for (const p of panels) counts[p.status] += 1;

  res.json({
    panels,
    counts,
    // Named so the gap is a number rather than something to infer from the api field.
    unmappedPanels: panels.filter((p) => p.api === 'n/a').map((p) => p.name),
    checkedAgainst: 'PANEL_API, a hand-maintained map of panel name to one API path. '
      + `${Object.keys(PANEL_API).length} of ${panels.length} panels are in it; the rest are `
      + 'reported `unchecked`, not `healthy`. A panel absent from the map has NOT been shown '
      + 'to work.',
  });
});

module.exports = router;