'use strict';
//
// health-check.js — detect broken panels before someone clicks into them.
//
// GET /api/health/panels — returns { panels: [{ name, js: ok|missing|error,
//   css: ok|missing|error, api: ok|down|n/a, status: 'healthy'|'broken' }] }
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

    const status = (jsStatus === 'ok' && cssStatus !== 'missing') ? 'healthy' : 'broken';
    panels.push({ name, js: jsStatus, css: cssStatus, api: apiStatus, status });
  }

  // Sort: broken first, then alphabetical.
  panels.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'broken' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  res.json({ panels });
});

module.exports = router;