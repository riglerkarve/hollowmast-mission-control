'use strict';
//
// hollowmast.js — build status for the HOLLOWMAST (Survive) project.
//
// GET /api/hollowmast — returns { buildFile, sources, lastCommit, devServer }
//
// Reads what exists on disk right now: the built index.html and its size, the
// source file count under src/, the last git commit that touched the Survive/
// tree, and whether the Vite dev server is listening on port 5177. Nothing is
// stored — it looks and reports.
//
// Absence is not an error here. A missing build file means a build has not been
// done, not that the route failed. A down dev server is a status, not a fault.
// Only a failure to LOOK (exception while reading) is reported as an error.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execSync } = require('node:child_process');

const router = express.Router();

// HOLLOWMAST lives in the Survive/ directory, one level above mission-control.
const SURVIVE_DIR = 'C:/Users/jcwhi/Claude Outputs/Survive';
// The build is dist/Hollowmast.html. This pointed at SURVIVE_DIR/index.html,
// which has never existed in that repository -- build.sh writes only to dist/.
// So the check reported 'a build has not been done' against a 1.4 MB artefact
// sitting on disk, and did so in the FAILING direction, which is why nobody
// chased it: a red lamp on a project you know is mid-flight reads as expected.
// Note this constant is defined in BOTH hollowmast.js and launch-readiness.js
// -- one figure, two owners, and both copies carried the same wrong path.
const BUILD_FILE = path.join(SURVIVE_DIR, 'dist', 'Hollowmast.html');
const SRC_DIR = path.join(SURVIVE_DIR, 'src');
const REPO_ROOT = 'C:/Users/jcwhi/Claude Outputs';
const DEV_PORT = 5177;

// Read the built index.html and its byte size. Absence is reported, not thrown.
function readBuildFile() {
  try {
    if (!fs.existsSync(BUILD_FILE)) {
      return { path: BUILD_FILE, sizeBytes: 0, exists: false };
    }
    const stat = fs.statSync(BUILD_FILE);
    return { path: BUILD_FILE, sizeBytes: stat.size, exists: true };
  } catch (e) {
    return { path: BUILD_FILE, sizeBytes: 0, exists: false, error: e.message };
  }
}

// Count files (not directories) directly under src/. Absence is reported as 0.
function countSources() {
  try {
    if (!fs.existsSync(SRC_DIR)) {
      return { count: 0, path: SRC_DIR, exists: false };
    }
    const entries = fs.readdirSync(SRC_DIR, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).length;
    return { count: files, path: SRC_DIR, exists: true };
  } catch (e) {
    return { count: 0, path: SRC_DIR, exists: false, error: e.message };
  }
}

// Last commit that touched the Survive/ tree. git is run from the repo root so
// the pathspec resolves. If git is absent or the tree is untracked, return null
// fields — that is a status, not a crash.
function lastCommit() {
  try {
    const out = execSync(
      'git log -1 --pretty=tformat:"%H%x09%ai" -- Survive/',
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
    ).trim();
    if (!out) return { sha: null, date: null };
    const [sha, date] = out.split('\t');
    return { sha: sha || null, date: date || null };
  } catch (e) {
    return { sha: null, date: null, error: String(e.message || '').split('\n')[0] };
  }
}

// Probe the Vite dev server on 127.0.0.1:5177. Resolves { running: true/false }.
// A 2-second timeout covers both 'nothing listening' (ECONNREFUSED, fast) and
// 'listening but not responding' (timeout, slow).
function checkDevServer() {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${DEV_PORT}/`,
      { timeout: 2000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ port: DEV_PORT, running: true }));
      }
    );
    req.on('error', () => resolve({ port: DEV_PORT, running: false }));
    req.on('timeout', () => { req.destroy(); resolve({ port: DEV_PORT, running: false }); });
  });
}

router.get('/', async (req, res) => {
  try {
    const dev = await checkDevServer();
    const status = {
      buildFile: readBuildFile(),
      sources: countSources(),
      lastCommit: lastCommit(),
      devServer: dev,
    };
    res.json(status);
  } catch (e) {
    // Only a failure to look is a 500. Individual field failures are carried in
    // their own sub-objects above; this catches something unexpected in the
    // orchestration itself.
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
