'use strict';
//
// git-heatmap.js — cross-project git activity heatmap for the workspace root.
//
// GET /api/git-heatmap — returns { days: [{ date, total, projects: { Dir: count } }],
//   totalCommits, daysWithCommits }
//
// Reads `git log` in the workspace root for the last 30 days. One commit can
// carry files from multiple top-level directories, so the per-day project map
// is built from --name-only output, not from the commit message.
const express = require('express');
const { execSync } = require('node:child_process');
const path = require('node:path');

const router = express.Router();

const WORKSPACE = 'C:/Users/jcwhi/Claude Outputs';

function topDir(filePath) {
  if (!filePath) return null;
  const cleaned = String(filePath).replace(/\\/g, '/');
  const parts = cleaned.split('/').filter(Boolean);
  if (!parts.length) return null;
  return parts[0];
}

function dateKey(iso) {
  return String(iso || '').slice(0, 10);
}

router.get('/', (req, res) => {
  let logOut;
  let nameOut;
  try {
    // Use --pretty=tformat with tab separator to avoid Windows cmd interpreting | as a pipe.
    // %H and %ai are git format specs, not Windows env vars, but cmd still mangles %...% patterns.
    // The safest path on Windows is to write the format to a temp approach: use --pretty with
    // explicit field delimiters that don't involve pipe characters.
    logOut = execSync(
      'git log --since="30 days ago" --pretty=tformat:"%H%x09%ai%x09%s"',
      { cwd: WORKSPACE, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
  } catch (e) {
    return res.status(500).json({
      error: e.message ? String(e.message).split('\n')[0] : 'git log failed',
    });
  }
  try {
    nameOut = execSync(
      'git log --since="30 days ago" --pretty=tformat:"%ai" --name-only',
      { cwd: WORKSPACE, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (e) {
    return res.status(500).json({
      error: e.message ? String(e.message).split('\n')[0] : 'git log --name-only failed',
    });
  }

  // Build the set of all dates in the last 30 days so empty days appear too.
  const dayMap = new Map();
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayMap.set(key, { date: key, total: 0, projects: {} });
  }

  let totalCommits = 0;

  // Parse the SHA<TAB>date<TAB>message log (tab-separated to avoid Windows pipe issues).
  const commits = [];
  for (const line of String(logOut).split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const [sha, date, ...msgParts] = parts;
    if (!sha || !date) continue;
    commits.push({ sha, date, message: msgParts.join('\t') });
    const key = dateKey(date);
    if (dayMap.has(key)) {
      dayMap.get(key).total += 1;
    }
    totalCommits += 1;
  }

  // Parse the date + --name-only output. The format is:
  //   2026-08-20 10:30:00 +0100
  //   path/to/file1
  //   path/to/file2
  //   <blank>
  //   2026-08-19 ...
  let currentDate = null;
  for (const line of String(nameOut).split('\n')) {
    if (line.trim() === '') {
      currentDate = null;
      continue;
    }
    // A date line starts with a digit and contains a time (has a colon near the start).
    if (/^\d{4}-\d{2}-\d{2}/.test(line) && line.includes(':')) {
      currentDate = dateKey(line);
      continue;
    }
    if (!currentDate) continue;
    const dir = topDir(line);
    if (!dir) continue;
    const day = dayMap.get(currentDate);
    if (!day) continue;
    day.projects[dir] = (day.projects[dir] || 0) + 1;
  }

  const days = Array.from(dayMap.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  const daysWithCommits = days.filter((d) => d.total > 0).length;

  res.json({ days, totalCommits, daysWithCommits });
});

module.exports = router;