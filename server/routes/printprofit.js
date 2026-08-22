'use strict';
//
// printprofit.js — integration with the PrintProfit project (income-portfolio/).
//
// GET /api/printprofit — returns the project's file listing, last git commit,
// and whether the dev preview server is running on port 4321.
//
// This route READS the income-portfolio directory; it does not own it and writes
// nothing there. Absence and failure must look different: a missing directory is
// { exists: false }, a read error is { exists: true, error: '...' }, and a clean
// read with no JSON files is { exists: true, files: [], jsonFiles: [] } — each a
// different state the panel renders differently.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const router = express.Router();

const PRINTPROFIT_DIR = path.join(__dirname, '..', '..', '..', 'income-portfolio');
const DEV_SERVER_PORT = 4321;

// Promisified execFile with a timeout, so a hung git or curl never blocks the
// panel load. The whole route degrades gracefully if any sub-call fails.
function run(cmd, args, opts, timeout) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { ...opts, timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
    // execFile's own timeout kills the child; no second guard needed.
    child.on('error', () => resolve({ err: new Error('spawn failed'), stdout: '', stderr: '' }));
  });
}

// Check whether the dev preview server is responding on the expected port.
async function checkDevServer() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${DEV_SERVER_PORT}/`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { port: DEV_SERVER_PORT, running: r.ok, status: r.status };
  } catch {
    // A refused connection or a timeout both mean "not running", and the panel
    // must NOT render a refused connection as a failure — it is a state.
    return { port: DEV_SERVER_PORT, running: false, status: null };
  }
}

// Get the last git commit for the income-portfolio directory.
async function lastCommit(workdir) {
  // %H = full hash, %ai = ISO date, %s = subject. Tab-separated.
  const { err, stdout } = await run(
    'git', ['log', '-1', '--pretty=tformat:%H%x09%ai%x09%s'],
    { cwd: workdir }, 5000,
  );
  if (err || !stdout.trim()) return null;
  const [sha, date, ...rest] = stdout.trim().split('\t');
  return { sha: sha || null, date: date || null, message: rest.join('\t') || null };
}

// Read any top-level .json files so the panel can surface package metadata
// without the user having to open the project. Each file is capped at 16 KB
// so a huge data dump does not blow the response.
async function readJsonFiles(dir, entries) {
  const jsonFiles = entries.filter((e) => e.endsWith('.json'));
  const out = [];
  for (const name of jsonFiles.slice(0, 20)) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.size > 16384) {
        out.push({ name, sizeBytes: stat.size, content: null, note: 'file exceeds 16 KB, not inlined' });
        continue;
      }
      const raw = fs.readFileSync(full, 'utf8');
      try {
        out.push({ name, sizeBytes: stat.size, content: JSON.parse(raw) });
      } catch {
        out.push({ name, sizeBytes: stat.size, content: null, note: 'not valid JSON' });
      }
    } catch (e) {
      out.push({ name, sizeBytes: null, content: null, note: 'could not read: ' + e.message });
    }
  }
  return out;
}

router.get('/', async (req, res) => {
  // 1. Does the directory exist at all?
  let exists = false;
  try {
    exists = fs.existsSync(PRINTPROFIT_DIR) && fs.statSync(PRINTPROFIT_DIR).isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    // Absence, not failure. The panel renders this as "project not found".
    return res.json({
      exists: false,
      path: PRINTPROFIT_DIR,
      files: [],
      jsonFiles: [],
      lastCommit: null,
      devServer: { port: DEV_SERVER_PORT, running: false, status: null },
      summary: 'PrintProfit directory not found.',
    });
  }

  // 2. List top-level files (not recursive — the panel shows what is at the root).
  let entries = [];
  let fileError = null;
  try {
    entries = fs.readdirSync(PRINTPROFIT_DIR).filter((e) => !e.startsWith('.'));
  } catch (e) {
    fileError = e.message;
  }

  const files = [];
  for (const name of entries) {
    try {
      const stat = fs.statSync(path.join(PRINTPROFIT_DIR, name));
      files.push({
        name,
        sizeBytes: stat.size,
        isDirectory: stat.isDirectory(),
        modified: stat.mtime.toISOString(),
      });
    } catch {
      files.push({ name, sizeBytes: null, isDirectory: null, modified: null });
    }
  }

  // Sort directories first, then alphabetically — stable, readable.
  files.sort((a, b) => {
    if ((a.isDirectory ? 1 : 0) !== (b.isDirectory ? 1 : 0))
      return (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
    return a.name.localeCompare(b.name);
  });

  // 3. Read any top-level .json files for inline metadata.
  let jsonFiles = [];
  if (!fileError) {
    try {
      jsonFiles = await readJsonFiles(PRINTPROFIT_DIR, entries);
    } catch (e) {
      jsonFiles = [];
    }
  }

  // 4. Last git commit — runs in the income-portfolio working tree, not here.
  let commit = null;
  try {
    commit = await lastCommit(PRINTPROFIT_DIR);
  } catch {
    commit = null;
  }

  // 5. Dev server check — non-blocking, non-fatal.
  const devServer = await checkDevServer();

  if (fileError) {
    // A read error is NOT the same as "no files". The panel renders this as a
    // failure, not as an empty project.
    return res.json({
      exists: true,
      path: PRINTPROFIT_DIR,
      files: [],
      jsonFiles,
      lastCommit: commit,
      devServer,
      error: fileError,
      summary: 'Could not read the PrintProfit directory: ' + fileError,
    });
  }

  const fileCount = files.length;
  const dirCount = files.filter((f) => f.isDirectory).length;
  const docCount = files.filter((f) => /\.(md|txt|html|css|js|json)$/.test(f.name)).length;

  res.json({
    exists: true,
    path: PRINTPROFIT_DIR,
    files,
    jsonFiles,
    lastCommit: commit,
    devServer,
    summary: `${fileCount} top-level item(s) (${dirCount} directories, ${docCount} documents). ` +
             `Dev server ${devServer.running ? 'running' : 'not running'} on port ${DEV_SERVER_PORT}.` +
             (commit ? ` Last commit: ${(commit.sha || '').slice(0, 7)}.` : ' No git history found.'),
  });
});

module.exports = router;