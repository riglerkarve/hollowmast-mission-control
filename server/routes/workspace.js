'use strict';
//
// workspace.js — M258: one screen showing all projects with status,
// last commit, open items, and activity momentum.
//
// GET /api/workspace — returns { projects: [{ name, path, lastCommit,
//   commitAge, openItems, commits7d, status }], totalProjects, activeProjects }
//
// Reads the filesystem and git directly — no new tracking to maintain.

const express = require('express');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

const router = express.Router();
const ROOT = path.join(__dirname, '..', '..');

const PROJECTS = [
  'mission-control', 'Survive', 'income-portfolio', 'print-shop',
  'dropshipping', 'SecondBrain', 'Oxford AutoWorks', 'thin-air',
  'Fallow', 'emberfall', 'high-society-420-tycoon', 'Mini Games',
];

router.get('/', (req, res) => {
  const projects = [];
  for (const name of PROJECTS) {
    const ppath = path.join(ROOT, name);
    if (!fs.existsSync(ppath)) continue;

    let lastCommit = null, commitAge = null, commits7d = 0;
    try {
      const log = execSync('git log -1 --format=%ai|%s', { cwd: ppath, encoding: 'utf8', timeout: 5000 }).trim();
      if (log) {
        const [date, ...subj] = log.split('|');
        lastCommit = { date: date.slice(0, 10), subject: subj.join('|').slice(0, 80) };
        const ageMs = Date.now() - new Date(date).getTime();
        commitAge = Math.floor(ageMs / 86400000);
      }
      const count = execSync('git log --since="7 days ago" --oneline', { cwd: ppath, encoding: 'utf8', timeout: 5000 }).trim();
      commits7d = count ? count.split('\n').length : 0;
    } catch (e) { /* not a git repo or git failed */ }

    // Open items from the board
    let openItems = 0;
    try {
      const r = db.prepare("SELECT COUNT(*) n FROM todo_items WHERE status = 'open' AND (project = ? OR project = ?)").get(name, name.toLowerCase().replace(' ', '-'));
      openItems = r ? r.n : 0;
    } catch (e) { }

    // Status: active (commits in 7d), dormant (commits in 30d), parked (none in 30d)
    let status = 'parked';
    if (commits7d > 0) status = 'active';
    else if (commitAge !== null && commitAge < 30) status = 'dormant';

    projects.push({ name, lastCommit, commitAge, commits7d, openItems, status });
  }

  const active = projects.filter(p => p.status === 'active').length;
  res.json({
    projects,
    totalProjects: projects.length,
    activeProjects: active,
    dormantProjects: projects.filter(p => p.status === 'dormant').length,
    parkedProjects: projects.filter(p => p.status === 'parked').length,
  });
});

module.exports = router;