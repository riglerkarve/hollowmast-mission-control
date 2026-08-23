'use strict';
//
// health-score.js — a composite workspace health score (0–100%) from 8 binary checks.
//
// GET /api/health-score — returns:
//   { score, max, percent, checks: [{ name, passed, detail }], asOf }
//
// Each check is scored 0 (failed) or 1 (passed). `passed` is one of three values:
//   true  — the check ran and passed
//   false — the check ran and failed
//   null  — the check could not run (absence, not failure)
//
// ABSENCE AND FAILURE LOOK DIFFERENT. A check that could not run is null, not
// false. A failed check is a real problem; a check that could not run is a
// limitation of the diagnostic, and conflating them trains the reader to
// ignore both.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('../db');

const router = express.Router();
const ROOT = path.join(__dirname, '..', '..');

const DB_FILE = path.join(ROOT, 'data', 'dashboard.db');
const ROUTES_CHECK = path.join(ROOT, 'tools', 'routes-check.cjs');

// ---- shift label (matches team.js shiftLabel) -------------------------------
function shiftLabel(d = new Date()) {
  const h = d.getHours();
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const day = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `${day}-${part}`;
}

// ---- check 1: routes mounted ------------------------------------------------
function checkRoutes() {
  try {
    const out = execFileSync('node', [ROUTES_CHECK, '--no-http'], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000,
    });
    // routes-check exits 0 when every file is required and mounted.
    // execFileSync throws on non-zero exit, so reaching here means passed.
    return { name: 'Routes mounted', passed: true, detail: 'routes-check --no-http exited 0 — every route file is required and mounted.' };
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').split('\n').filter(Boolean).join(' ').slice(0, 120);
    return { name: 'Routes mounted', passed: false, detail: `routes-check --no-http failed: ${msg}` };
  }
}

// ---- check 2: panels healthy ------------------------------------------------
async function checkPanels() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/health-check', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { name: 'Panels healthy', passed: false, detail: `health-check returned ${r.status}.` };
    const d = await r.json();
    const panels = d.panels || [];
    if (panels.length === 0) return { name: 'Panels healthy', passed: null, detail: 'No panels registered — the check ran but found nothing to check.' };
    // THREE OUTCOMES, NOT TWO. `!== 'healthy'` used to sweep both real breakage and panels
    // that were never checked into one bucket, and health-check's own verdict then ignored
    // its api field entirely — so this leg printed "All 69 panels healthy" on 23 Aug 2026
    // while exercise and work were both answering 404. A leg of a score that cannot say
    // "I did not look at 45 of these" is not reporting health, it is reporting file presence.
    const broken = panels.filter((p) => p.status === 'broken');
    const unchecked = panels.filter((p) => p.status === 'unchecked');
    // Stated on every outcome, pass included. A caveat that only appears on failure is a
    // caveat nobody reads, because nobody investigates good news.
    const blind = unchecked.length
      ? ` ${unchecked.length} of ${panels.length} have no API mapped and were NOT checked.`
      : '';
    if (broken.length === 0) {
      return {
        name: 'Panels healthy',
        passed: true,
        detail: `${panels.length - unchecked.length} of ${panels.length} panels checked and healthy.${blind}`,
      };
    }
    return {
      name: 'Panels healthy',
      passed: false,
      detail: `${broken.length} of ${panels.length} panels broken: `
        + `${broken.map((p) => p.name).slice(0, 5).join(', ')}${broken.length > 5 ? '…' : ''}.${blind}`,
    };
  } catch (e) {
    return { name: 'Panels healthy', passed: null, detail: `Could not reach /api/health-check — ${String(e.message || e).slice(0, 80)}. This is a failure to look, not a clean bill of health.` };
  }
}

// ---- check 3: server running ------------------------------------------------
async function checkServer() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/status', { signal: AbortSignal.timeout(5000) });
    if (r.ok) return { name: 'Server running', passed: true, detail: `GET /api/status returned ${r.status}.` };
    return { name: 'Server running', passed: false, detail: `GET /api/status returned ${r.status}.` };
  } catch (e) {
    return { name: 'Server running', passed: false, detail: `Could not reach /api/status — ${String(e.message || e).slice(0, 80)}.` };
  }
}

// ---- check 4: database OK ---------------------------------------------------
function checkDatabase() {
  try {
    db.prepare('SELECT 1').get();
    return { name: 'Database OK', passed: true, detail: 'SELECT 1 succeeded.' };
  } catch (e) {
    return { name: 'Database OK', passed: false, detail: `SELECT 1 failed — ${String(e.message || e).slice(0, 80)}.` };
  }
}

// ---- check 5: handovers filed today -----------------------------------------
function checkHandovers() {
  try {
    const today = shiftLabel();
    const r = db.prepare('SELECT COUNT(*) n FROM team_handovers WHERE shift = ?').get(today);
    const n = r ? r.n : 0;
    if (n > 0) return { name: 'Handovers filed today', passed: true, detail: `${n} handover(s) filed for shift ${today}.` };
    return { name: 'Handovers filed today', passed: false, detail: `No handovers filed for shift ${today}.` };
  } catch (e) {
    return { name: 'Handovers filed today', passed: null, detail: `Could not query team_handovers — ${String(e.message || e).slice(0, 80)}.` };
  }
}

// ---- check 6: no P0 bugs open ------------------------------------------------
function checkNoP0Bugs() {
  try {
    const r = db.prepare("SELECT COUNT(*) n FROM board_items WHERE status = 'open' AND kind = 'bug' AND severity = 'P0'").get();
    const n = r ? r.n : 0;
    if (n === 0) return { name: 'No P0 bugs open', passed: true, detail: 'Zero P0 bugs open.' };
    return { name: 'No P0 bugs open', passed: false, detail: `${n} P0 bug(s) open.` };
  } catch (e) {
    return { name: 'No P0 bugs open', passed: null, detail: `Could not query board_items — ${String(e.message || e).slice(0, 80)}.` };
  }
}

// ---- check 7: backup recent -------------------------------------------------
function checkBackup() {
  try {
    const stat = fs.statSync(DB_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageH = Math.round(ageMs / 3600000);
    if (ageMs <= 86400000) return { name: 'Backup recent', passed: true, detail: `dashboard.db modified ${ageH}h ago.` };
    return { name: 'Backup recent', passed: false, detail: `dashboard.db last modified ${ageH}h ago — more than 24h.` };
  } catch (e) {
    return { name: 'Backup recent', passed: null, detail: `Could not stat dashboard.db — ${String(e.message || e).slice(0, 80)}.` };
  }
}

// ---- check 8: Ollama reachable ----------------------------------------------
async function checkOllama() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (r.ok) return { name: 'Ollama reachable', passed: true, detail: 'GET /api/tags returned 200.' };
    return { name: 'Ollama reachable', passed: false, detail: `GET /api/tags returned ${r.status}.` };
  } catch (e) {
    return { name: 'Ollama reachable', passed: false, detail: `Could not reach Ollama at :11434 — ${String(e.message || e).slice(0, 80)}.` };
  }
}

router.get('/', async (req, res) => {
  const checks = [
    checkRoutes(),
    checkDatabase(),
    checkHandovers(),
    checkNoP0Bugs(),
    checkBackup(),
    await checkServer(),
    await checkPanels(),
    await checkOllama(),
  ];

  const score = checks.filter((c) => c.passed === true).length;
  const max = checks.length;

  res.json({
    score,
    max,
    percent: Math.round((score / max) * 100),
    checks,
    asOf: new Date().toISOString(),
  });
});

module.exports = router;