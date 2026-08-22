'use strict';
//
// launch-readiness.js — HOLLOWMAST Phase 5 launch-readiness view.
//
// GET /api/launch-readiness — returns { checks, ready, totalChecks, passedChecks }
//
// A single GET that assembles a launch-readiness checklist by examining what
// exists on disk, in git, on the network, and in the board right now. Each
// check is pass / fail / pending with a detail string. Nothing is stored —
// it looks and reports.
//
// Absence is not an error here. A missing build file means a build has not
// been done, not that the route failed. A down dev server is a status, not a
// fault. Only a failure to LOOK (exception while reading) is reported as an
// error.
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const { execSync } = require('node:child_process');

const db = require('../db');

const router = express.Router();

// HOLLOWMAST lives in the Survive/ directory, one level above mission-control.
const SURVIVE_DIR = 'C:/Users/jcwhi/Claude Outputs/Survive';
const BUILD_FILE = SURVIVE_DIR + '/index.html';
const SRC_DIR = SURVIVE_DIR + '/src';
const REPO_ROOT = 'C:/Users/jcwhi/Claude Outputs';
const DEV_PORT = 5177;

// ---- individual checks -----------------------------------------------------

// Build file exists: fs.existsSync + statSync for size.
function checkBuildFile() {
  try {
    if (!fs.existsSync(BUILD_FILE)) {
      return { name: 'Build file exists', status: 'fail',
        detail: 'Survive/index.html not found — a build has not been done.' };
    }
    const stat = fs.statSync(BUILD_FILE);
    if (stat.size <= 0) {
      return { name: 'Build file exists', status: 'fail',
        detail: 'Survive/index.html exists but is 0 bytes.' };
    }
    const kb = (stat.size / 1024).toFixed(1);
    return { name: 'Build file exists', status: 'pass',
      detail: 'Survive/index.html — ' + kb + ' KB.' };
  } catch (e) {
    return { name: 'Build file exists', status: 'pending',
      detail: 'Could not stat the build file: ' + String(e.message || '').split('\n')[0] };
  }
}

// Source count: count files in Survive/src/.
function checkSourceCount() {
  try {
    if (!fs.existsSync(SRC_DIR)) {
      return { name: 'Source files present', status: 'fail',
        detail: 'Survive/src/ not found.' };
    }
    const entries = fs.readdirSync(SRC_DIR, { withFileTypes: true });
    const files = entries.filter(function (e) { return e.isFile(); }).length;
    if (files === 0) {
      return { name: 'Source files present', status: 'fail',
        detail: 'Survive/src/ exists but contains no files.' };
    }
    return { name: 'Source files present', status: 'pass',
      detail: files + ' file' + (files === 1 ? '' : 's') + ' in Survive/src/.' };
  } catch (e) {
    return { name: 'Source files present', status: 'pending',
      detail: 'Could not read Survive/src/: ' + String(e.message || '').split('\n')[0] };
  }
}

// Last git commit for Survive/. Tab separator (%x09), NOT pipe, to avoid
// Windows issues with pipe in command arguments.
function checkLastCommit() {
  try {
    const out = execSync(
      'git log -1 --pretty=tformat:"%H%x09%ai%x09%s" -- Survive/',
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
    ).trim();
    if (!out) {
      return { name: 'Last commit recorded', status: 'fail',
        detail: 'No commit history for Survive/.' };
    }
    const parts = out.split('\t');
    const sha = parts[0] || '';
    const date = parts[1] || '';
    const subject = parts[2] || '';
    const shortSha = sha.slice(0, 8);
    const dateStr = String(date).slice(0, 10);
    return { name: 'Last commit recorded', status: 'pass',
      detail: shortSha + ' — ' + dateStr + ' — ' + String(subject).slice(0, 80) };
  } catch (e) {
    return { name: 'Last commit recorded', status: 'pending',
      detail: 'Could not read git log: ' + String(e.message || '').split('\n')[0] };
  }
}

// Dev server on :5177 — HTTP GET with 2s timeout.
function checkDevServer() {
  return new Promise(function (resolve) {
    var req = http.get(
      'http://127.0.0.1:' + DEV_PORT + '/',
      { timeout: 2000 },
      function (res) {
        res.resume();
        res.on('end', function () {
          resolve({ name: 'Dev server running', status: 'pass',
            detail: 'Vite dev server responding on port ' + DEV_PORT + '.' });
        });
      }
    );
    req.on('error', function () {
      resolve({ name: 'Dev server running', status: 'fail',
        detail: 'Dev server not responding on port ' + DEV_PORT + ' — a status, not a failure.' });
    });
    req.on('timeout', function () {
      req.destroy();
      resolve({ name: 'Dev server running', status: 'fail',
        detail: 'Dev server timed out on port ' + DEV_PORT + '.' });
    });
  });
}

// itch.io page status — try HTTP GET https://hollowmast.com with 3s timeout.
// If the domain does not resolve or the request fails, that is pending (we
// cannot confirm the page is live), not a hard fail.
function checkItchPage() {
  return new Promise(function (resolve) {
    var req = http.get(
      'https://hollowmast.com/',
      { timeout: 3000 },
      function (res) {
        res.resume();
        res.on('end', function () {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve({ name: 'itch.io page live', status: 'pass',
              detail: 'hollowmast.com responded (' + res.statusCode + ').' });
          } else {
            resolve({ name: 'itch.io page live', status: 'pending',
              detail: 'hollowmast.com returned status ' + res.statusCode + '.' });
          }
        });
      }
    );
    req.on('error', function () {
      resolve({ name: 'itch.io page live', status: 'pending',
        detail: 'Could not reach hollowmast.com — domain may not exist yet.' });
    });
    req.on('timeout', function () {
      req.destroy();
      resolve({ name: 'itch.io page live', status: 'pending',
        detail: 'hollowmast.com timed out after 3s.' });
    });
  });
}

// Open bugs — query board_items for HOLLOWMAST bugs with status='open'.
function checkOpenBugs() {
  try {
    var rows = db.prepare(
      "SELECT ref, title, severity FROM board_items WHERE project = 'HOLLOWMAST' AND status = 'open' ORDER BY CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END, ref"
    ).all();
    if (rows.length === 0) {
      return { name: 'No open bugs', status: 'pass',
        detail: 'No open HOLLOWMAST bugs in the board.' };
    }
    // Any open bug is a fail for launch readiness.
    var p1s = rows.filter(function (r) { return r.severity === 'P1'; });
    var lead;
    if (p1s.length > 0) {
      lead = p1s.length + ' P1 bug' + (p1s.length === 1 ? '' : 's') + ' open — ';
    } else {
      lead = rows.length + ' open bug' + (rows.length === 1 ? '' : 's') + ' — ';
    }
    var refs = rows.slice(0, 5).map(function (r) { return r.ref; }).join(', ');
    return { name: 'No open bugs', status: 'fail',
      detail: lead + refs + (rows.length > 5 ? ', +' + (rows.length - 5) + ' more' : '') };
  } catch (e) {
    return { name: 'No open bugs', status: 'pending',
      detail: 'Could not query board_items: ' + String(e.message || '').split('\n')[0] };
  }
}

// ---- route -----------------------------------------------------------------

router.get('/', async function (req, res) {
  try {
    var checks = [];
    // Sync checks.
    checks.push(checkBuildFile());
    checks.push(checkSourceCount());
    checks.push(checkLastCommit());
    checks.push(checkOpenBugs());
    // Async checks.
    var dev = await checkDevServer();
    checks.push(dev);
    var itch = await checkItchPage();
    checks.push(itch);

    var totalChecks = checks.length;
    var passedChecks = checks.filter(function (c) { return c.status === 'pass'; }).length;
    var failedChecks = checks.filter(function (c) { return c.status === 'fail'; }).length;
    // Ready only when every check passes — a pending check is not a pass.
    var ready = failedChecks === 0 && passedChecks === totalChecks;

    res.json({
      checks: checks,
      ready: ready,
      totalChecks: totalChecks,
      passedChecks: passedChecks,
    });
  } catch (e) {
    // Only a failure to look is a 500. Individual check failures are carried
    // in their own objects above; this catches something unexpected in the
    // orchestration itself.
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;