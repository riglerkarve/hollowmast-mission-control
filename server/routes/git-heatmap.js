'use strict';
//
// git-heatmap.js — M250. Cross-project git activity: which projects are moving.
//
// GET /api/git-heatmap — { days: [{ date, total, projects: { Name: count } }],
//   totalCommits, daysWithCommits, projectsCounted, skipped: [{ project, why }] }
//
// WHAT WAS WRONG, because the failure mode is the interesting part.
//
// This route ran ONE `git log` in the workspace root. The workspace root is not a
// repository containing the projects — each project is its own repo, and the root
// is a separate, nearly-empty one. So the route answered 200 with a well-formed
// 30-day array holding **4 commits in total** and `projects: {}` on every single
// day, while /api/workspace — same server, same disk — reported 346 commits in
// seven days for HOLLOWMAST alone and 281 for Mission Control.
//
// That is the worst shape a defect can take: a valid response, a plausible
// structure, and a panel rendering a near-empty grid that reads as "not much
// happened lately" rather than "this is measuring the wrong thing". The root
// repo's 30-day count is exactly 4, which is what identified it.
//
// THE PROJECT LIST HAS ONE OWNER. projects.js declares it and its own comment
// says so: a second list of projects is a second place the truth lives.
// workspace.js was fixed to read from it (M258); this file now does the same
// rather than scanning directories or keeping its own array. M272 is that rule
// already broken six times over — this must not become the seventh.
//
// Attribution is by REPOSITORY, not by top-level file path. The old code derived
// the project from the first path segment of --name-only output, which cannot
// work when the log comes from a repo whose paths are relative to its own root.
// Each commit belongs to the project whose repo produced it.
const express = require('express');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const router = express.Router();

const ROOT = path.join(__dirname, '..', '..', '..');
const DAYS = 30;
const { PROJECTS } = require('./projects');

// execFileSync with an argv array rather than execSync with a string: the old
// code carried a comment about Windows cmd mangling %-patterns in --pretty
// formats, which is a problem that only exists when the command goes through a
// shell. Not going through one removes it rather than working around it.
function gitDates(cwd) {
  return execFileSync(
    'git',
    ['log', '--since=' + DAYS + '.days.ago', '--pretty=tformat:%ad', '--date=short'],
    { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

router.get('/', (req, res) => {
  // Every day in the window exists up front, so a quiet day is a zero rather
  // than a gap — a missing key and a zero count must not look the same.
  const dayMap = new Map();
  const today = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayMap.set(key, { date: key, total: 0, projects: {} });
  }

  // A filter that drops candidates must report what it dropped, or the surviving
  // evidence looks cleaner than it is. `skipped` says why a project is absent:
  // "not on disk", "not a repo" and "git refused" are different facts, and an
  // empty heatmap with an empty skipped list means something different from an
  // empty heatmap with thirteen entries in it.
  const skipped = [];
  let totalCommits = 0;

  for (const proj of PROJECTS) {
    const dir = path.join(ROOT, proj.dir);
    if (!fs.existsSync(dir)) { skipped.push({ project: proj.name, why: 'directory not found' }); continue; }
    if (!fs.existsSync(path.join(dir, '.git'))) { skipped.push({ project: proj.name, why: 'not a git repository' }); continue; }

    let out;
    try {
      out = gitDates(dir);
    } catch (e) {
      // A repo with no commits yet exits non-zero on `git log`. That is a real
      // and empty repo, not a broken one, and it is recorded rather than
      // swallowed into a zero.
      skipped.push({ project: proj.name, why: String(e.message || 'git log failed').split('\n')[0].slice(0, 120) });
      continue;
    }

    for (const line of String(out).split('\n')) {
      const day = line.trim();
      if (!day) continue;
      const slot = dayMap.get(day);
      if (!slot) continue;          // outside the window: --since is inclusive at the edge
      slot.total += 1;
      slot.projects[proj.name] = (slot.projects[proj.name] || 0) + 1;
      totalCommits += 1;
    }
  }

  const days = [...dayMap.values()];
  res.json({
    days,
    totalCommits,
    daysWithCommits: days.filter(d => d.total > 0).length,
    projectsCounted: PROJECTS.length - skipped.length,
    skipped,
  });
});

module.exports = router;
