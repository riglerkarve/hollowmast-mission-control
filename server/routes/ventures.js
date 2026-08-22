'use strict';
//
// ventures.js — cross-venture view: momentum and staleness, not just a list.
//
// GET /api/ventures — returns { ventures: [{ name, track, status,
//   momentum, daysSinceActivity, openItems, staleItems, note }] }
//
// For each registered project, shows:
// - momentum: 'active' (activity in last 3 days), 'slowing' (3-7 days),
//   'stalled' (7+ days), 'parked' (not in rotation)
// - daysSinceActivity: from git log + handovers + sessions
// - openItems: count from the board
// - staleItems: count from the stale detector
// - note: the project's own note from the projects route
//
// This answers M132: "Cross-venture view: momentum and staleness, not just
// a list of projects."
const express = require('express');
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const router = express.Router();
const WORKSPACE = path.join(os.homedir(), 'Claude Outputs');

function gitLastActivity(projectDir) {
  return new Promise((resolve) => {
    execFile('git', ['log', '-1', '--format=%ai', '--', projectDir],
      { cwd: WORKSPACE, timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(null);
        resolve(stdout.trim());
      });
  });
}

router.get('/', async (req, res) => {
  // Fetch projects — the API returns an array
  let projects = [];
  try {
    const r = await fetch('http://127.0.0.1:3000/api/projects');
    if (r.ok) {
      const d = await r.json();
      projects = Array.isArray(d) ? d : (d.projects || d.items || []);
    }
  } catch {}

  // Fetch board for open item counts
  let boardItems = [];
  let backlogItems = [];
  try {
    const r = await fetch('http://127.0.0.1:3000/api/board');
    if (r.ok) {
      const d = await r.json();
      boardItems = d.items || [];
      backlogItems = d.backlog || [];
    }
  } catch {}

  // Fetch stale items
  let staleRefs = new Set();
  try {
    const r = await fetch('http://127.0.0.1:3000/api/stale?days=7');
    if (r.ok) {
      const d = await r.json();
      staleRefs = new Set((d.items || []).map((i) => String(i.ref)));
    }
  } catch {}

  // Fetch activity stream for momentum
  let activityItems = [];
  try {
    const r = await fetch('http://127.0.0.1:3000/api/activity/stream?hours=168');
    if (r.ok) {
      const d = await r.json();
      activityItems = d.items || [];
    }
  } catch {}

  const ventures = [];
  for (const p of projects) {
    const name = p.name || p.id;
    const track = p.track || 'Unknown';
    const note = p.note || '';
    const exists = p.exists !== false;
    const dir = p.dir || '';

    // Count open items for this project
    const allBoard = [...boardItems, ...backlogItems];
    const projectItems = allBoard.filter((i) => {
      const proj = i.project || '';
      return proj.toLowerCase() === name.toLowerCase() ||
             proj.toLowerCase() === (p.id || '').toLowerCase();
    });
    const openItems = projectItems.filter((i) =>
      !i.status || i.status === 'open').length;
    const staleItems = projectItems.filter((i) =>
      staleRefs.has(String(i.ref || i.id || ''))).length;

    // Check git activity for this project's directory
    let lastActivity = null;
    if (dir) {
      lastActivity = await gitLastActivity(dir);
    }

    // Also check handover activity
    const handoverActivity = activityItems.find((a) => {
      const where = String(a.where || '').toLowerCase();
      const link = String(a.link || '').toLowerCase();
      return where.includes(name.toLowerCase()) ||
             link.includes(name.toLowerCase()) ||
             link.includes((p.id || '').toLowerCase());
    });

    // Determine the most recent activity
    const gitDate = lastActivity ? new Date(lastActivity) : null;
    const handoverDate = handoverActivity ? new Date(handoverActivity.when) : null;
    const mostRecent = (gitDate && handoverDate)
      ? (gitDate > handoverDate ? gitDate : handoverDate)
      : (gitDate || handoverDate);

    const daysSinceActivity = mostRecent
      ? Math.floor((Date.now() - mostRecent.getTime()) / 86400000)
      : null;

    // Momentum
    let momentum = 'unknown';
    if (daysSinceActivity !== null) {
      if (daysSinceActivity <= 3) momentum = 'active';
      else if (daysSinceActivity <= 7) momentum = 'slowing';
      else momentum = 'stalled';
    }
    if (track === 'Game' && name !== 'HOLLOWMAST') momentum = 'parked';
    if (note.includes('not in the rotation') || note.includes('not a PrintProfit')) momentum = 'parked';

    ventures.push({
      name,
      track,
      status: p.state || (exists ? 'exists' : 'empty'),
      momentum,
      daysSinceActivity,
      openItems,
      staleItems,
      note: note.slice(0, 100),
      lastActivity: mostRecent ? mostRecent.toISOString() : null,
    });
  }

  // Sort: active first, then slowing, then stalled, then parked
  const momentumOrder = { active: 0, slowing: 1, stalled: 2, parked: 3, unknown: 4 };
  ventures.sort((a, b) => (momentumOrder[a.momentum] - momentumOrder[b.momentum]));

  res.json({ ventures });
});

module.exports = router;