'use strict';
//
// lede.js — one-line plain-English summaries of what each panel shows right now.
//
// GET /api/lede/:panel — returns { panel, title, lede }
//
// For each panel this route fetches the same API data the panel itself uses (via a loopback
// fetch to the server's own API) and generates a dynamic lede: a single sentence under 120
// chars that tells you what is on the screen without looking.
//
// If a data fetch fails the route returns a static fallback lede describing what the panel
// IS, not what it currently shows — so a broken read never reads as "everything is fine".
//
// The route is standalone: it does not modify index.js or any other file. Each panel's data
// is fetched through a loopback HTTP call to the corresponding /api/* endpoint. This keeps
// the lede route decoupled from the other routes' internal function signatures — their
// handler functions are bound to Express req/res and are not all cleanly callable from
// outside. A loopback fetch is negligible cost (no network, just a function call in Node).
//
// ABSENCE AND FAILURE MUST NOT LOOK THE SAME. Every generator wraps in try/catch and falls
// back to a static sentence, so a thrown query and an empty table render differently —
// exactly as every other route in this codebase already does.
const express = require('express');
const { AsyncLocalStorage } = require('node:async_hooks');

const router = express.Router();

// Carries the REAL caller's own X-MC-By claim (from provenance.js's req.by) down into every
// getJson() loopback call below, without threading a parameter through all 20 generator
// functions. Scoped per-request via AsyncLocalStorage rather than a module-level variable,
// because a shared mutable value here would be the same concurrent-request race the activity/
// stale recursion guard was rewritten to avoid — two lede requests in flight at once would
// otherwise stomp each other's actor.
const byStorage = new AsyncLocalStorage();

// --- panel titles ---------------------------------------------------------------
const TITLES = {
  focus: 'Focus',
  board: 'Board',
  team: 'Team',
  finance: 'Finance',
  budget: 'Budget',
  income: 'Income',
  machine: 'Machine',
  analytics: 'Analytics',
  wellbeing: 'Wellbeing',
  safety: 'Safety',
  goals: 'Goals',
  schedule: 'Schedule',
  projects: 'Projects',
  work: 'Work',
  mail: 'Mail',
  lifestyle: 'Lifestyle',
  exercise: 'Exercise',
  brain: 'Brain',
  browsing: 'Browsing',
  atlas: 'Atlas',
  voice: 'Voice',
};

// --- static fallback ledes (what the panel IS, not what it shows right now) -----
const FALLBACKS = {
  focus: 'Focus timer, streaks, and the backlog.',
  board: 'Open bugs and requests across every project.',
  team: 'Who is working, their handovers, and what needs the owner.',
  finance: 'Bank transactions, categories, and spending breakdowns.',
  budget: 'Budget derived from your history, and a wishlist with affordability.',
  income: 'A ledger of what the small income streams actually paid.',
  machine: 'Live CPU, RAM, GPU, and disk readings from this computer.',
  analytics: 'Site uptime probes and imported traffic for published projects.',
  wellbeing: 'A private journal. No scores, no streaks, no judgements.',
  safety: 'Hard spending limits that gate every payment decision.',
  goals: 'Multi-step admin goals, each with a derived next action.',
  schedule: 'Dated commitments — appointments, deadlines, and overdue items.',
  projects: 'Every project, its git state, and its control centre.',
  work: 'A queue of prompts handed to a local model, walked away from.',
  mail: 'Gmail metadata: senders, dates, and counts. Subjects on this machine only.',
  lifestyle: 'Chore schedules and meal intake, derived from your own records.',
  exercise: 'Exercise counts by kind. No targets, no streaks, no scores.',
  brain: "Claude's memory store — lessons, references, and your notes.",
  browsing: 'Where your attention goes, by domain. Imported from Edge.',
  atlas: 'A grid of the world. Mark countries you have visited.',
  voice: 'Click-to-talk and talk-back via local TTS and STT.',
};

// --- helpers --------------------------------------------------------------------
const MAX = 120;

function clamp(s) {
  if (!s) return '';
  return s.length > MAX ? s.slice(0, MAX - 1) + '\u2026' : s;
}

// Fetch JSON from an internal API path. Uses a lightweight in-process HTTP call so the
// lede route never duplicates the other routes' SQL — it reads what they read.
//
// This is deliberately a fetch to localhost rather than a require-and-call: the other
// routes' handler functions are tightly bound to Express req/res objects and are not
// all cleanly callable from outside. A fetch keeps the lede route decoupled from their
// internals, and the cost is negligible (loopback, no network).
async function getJson(urlPath) {
  // Forwards the actual browser request's own claim (provenance.js's req.by, 'unknown' if it
  // sent none) rather than assuming 'you' -- this loopback fetch is lede.js reading data on
  // the caller's behalf, and the caller may not be a human at all (a scheduled task or agent
  // can request a lede too). Hardcoding 'you' here fabricated exactly the attribution
  // provenance.js exists to prevent, on every one of these internal calls.
  const by = byStorage.getStore() || 'unknown';
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}${urlPath}`, {
    headers: { 'x-mc-by': by },
  });
  if (!r.ok) throw new Error(`${urlPath} answered ${r.status}`);
  return r.json();
}

// --- per-panel generators -------------------------------------------------------
// Each returns a string (the lede) or throws (caught by the caller, which uses the fallback).
// All are async because they fetch from internal routes.

async function genFocus() {
  const s = await getJson('/api/stats/summary');
  const parts = [];
  if (typeof s.today === 'number') parts.push(`${s.today} session${s.today === 1 ? '' : 's'} today`);
  if (typeof s.streak === 'number') parts.push(`${s.streak}-day streak`);
  return parts.join('. ') + '.' || FALLBACKS.focus;
}

async function genBoard() {
  const s = await getJson('/api/board');
  const c = s.counts || {};
  const open = c.externalOpen || 0;
  const backlog = c.backlogOpen || 0;
  const total = open + backlog;
  if (!total) return 'No open items. Board is clear.';
  const projects = (s.projects || []).length;
  const parts = [`${total} open item${total === 1 ? '' : 's'}`];
  if (projects) parts.push(`across ${projects} project${projects === 1 ? '' : 's'}`);
  let lede = parts.join(' ') + '.';
  // Add P1 count if available
  const p1 = (s.items || []).filter((i) => i.severity === 'P1').length;
  if (p1) lede += ` ${p1} P1.`;
  return clamp(lede);
}

async function genTeam() {
  const s = await getJson('/api/team/shift');
  const handovers = (s.handovers || []).length;
  const silent = (s.silent || []).length;
  const needsOwner = (s.needsOwner || []).length;
  const blocked = (s.blocked || []).length;
  const parts = [];
  if (handovers) parts.push(`${handovers} handover${handovers === 1 ? '' : 's'}`);
  if (silent) parts.push(`${silent} silent`);
  if (needsOwner) parts.push(`${needsOwner} need owner`);
  if (blocked) parts.push(`${blocked} blocked`);
  if (!parts.length) return 'No handovers this shift.';
  return clamp(parts.join(', ') + '.');
}

async function genFinance() {
  const s = await getJson('/api/finance/summary');
  const imported = s.imported || 0;
  const uncategorised = s.uncategorised || 0;
  const review = s.awaiting_review || 0;
  const parts = [`${imported.toLocaleString()} transaction${imported === 1 ? '' : 's'}`];
  if (uncategorised) parts.push(`${uncategorised} uncategorised`);
  if (review) parts.push(`${review} awaiting review`);
  return clamp(parts.join(', ') + '.');
}

async function genBudget() {
  const s = await getJson('/api/budget');
  if (s.state === 'no-budget') return 'No budget lines yet. Derive one from your history.';
  const headroom = s.headroomPence;
  const spent = s.spentPence || 0;
  const lines = (s.lines || []).length;
  let lede = `${lines} budget line${lines === 1 ? '' : 's'}.`;
  if (typeof headroom === 'number' && typeof spent === 'number') {
    const remaining = headroom;
    lede += ` Headroom: \u00a3${(remaining / 100).toFixed(0)}.`;
  }
  return clamp(lede);
}

async function genIncome() {
  const s = await getJson('/api/income');
  const streams = s.streams || [];
  const active = streams.filter((x) => x.active);
  const total = s.currencyTotals || [];
  if (!streams.length) return 'No income streams recorded yet.';
  const parts = [`${streams.length} stream${streams.length === 1 ? '' : 's'}`, `${active.length} active`];
  if (total.length === 1) {
    const t = total[0];
    const gbp = t.currency === 'GBP';
    parts.push(`${gbp ? '\u00a3' : ''}${(t.pence / 100).toFixed(0)}${gbp ? '' : ' ' + t.currency} total`);
  } else if (total.length > 1) {
    parts.push(`${total.length} currencies`);
  }
  return clamp(parts.join(', ') + '.');
}

async function genMachine() {
  const s = await getJson('/api/machine');
  if (s.state === 'sampling') return 'Machine sampling. First CPU reading needs two samples.';
  const cpu = s.cpu || {};
  const mem = s.memory || {};
  const gpu = s.gpu || {};
  const machine = s.machine || {};
  const parts = [];
  if (typeof cpu.loadPct === 'number') parts.push(`CPU ${cpu.loadPct}%`);
  else if (cpu.loadWhy) parts.push('CPU not yet measured');
  if (typeof mem.usedPct === 'number') parts.push(`RAM ${mem.usedPct}%`);
  if (gpu.available) {
    parts.push(`GPU ${gpu.utilPct != null ? gpu.utilPct + '%' : 'idle'}`);
  } else {
    parts.push('GPU idle');
  }
  if (typeof machine.uptimeHours === 'number') parts.push(`up ${machine.uptimeHours}h`);
  return clamp(parts.join(', ') + '.');
}

async function genAnalytics() {
  const s = await getJson('/api/analytics');
  const sites = s.sites || [];
  if (!sites.length) return 'No published sites configured.';
  const ok = sites.filter((x) => x.state === 'ok').length;
  const attention = sites.filter((x) => x.state === 'attention').length;
  const never = sites.filter((x) => x.state === 'never probed').length;
  const parts = [`${sites.length} site${sites.length === 1 ? '' : 's'}`];
  if (ok) parts.push(`${ok} ok`);
  if (attention) parts.push(`${attention} need attention`);
  if (never) parts.push(`${never} unprobed`);
  const trafficState = s.trafficState || '';
  if (trafficState === 'none imported') parts.push('no traffic data');
  return clamp(parts.join(', ') + '.');
}

async function genWellbeing() {
  const s = await getJson('/api/wellbeing/entries?limit=1');
  const total = s.total || 0;
  if (!total) return 'No journal entries yet.';
  // Check quiet mode
  const q = await getJson('/api/wellbeing/quiet');
  let lede = `${total} entr${total === 1 ? 'y' : 'ies'}.`;
  if (q.active) lede += ' Quiet mode on.';
  return clamp(lede);
}

async function genSafety() {
  const s = await getJson('/api/safety');
  if (!s.configured) return 'Safety guard not configured. Set spending limits.';
  const authorised = s.authorisedThisMonthPence || 0;
  const count = s.authorisedThisMonthCount || 0;
  const decisions = (s.totals || []).reduce((a, t) => a + t.n, 0);
  const parts = [`\u00a3${(authorised / 100).toFixed(0)} authorised`, `${count} this month`];
  if (decisions) parts.push(`${decisions} decision${decisions === 1 ? '' : 's'}`);
  return clamp(parts.join(', ') + '.');
}

async function genGoals() {
  const s = await getJson('/api/goals');
  const goals = s.goals || [];
  if (!goals.length) return 'No goals yet. Add one and give it steps.';
  const actionable = s.actionableCount || 0;
  const blocked = s.blockedCount || 0;
  const parts = [`${goals.length} goal${goals.length === 1 ? '' : 's'}`];
  if (actionable) parts.push(`${actionable} actionable`);
  if (blocked) parts.push(`${blocked} blocked`);
  return clamp(parts.join(', ') + '.');
}

async function genSchedule() {
  const s = await getJson('/api/schedule');
  if (s.state === 'empty') return 'Nothing scheduled. Add the first dated item.';
  const c = s.counts || {};
  const parts = [];
  if (c.overdue) parts.push(`${c.overdue} overdue`);
  if (c.today) parts.push(`${c.today} today`);
  if (c.thisWeek) parts.push(`${c.thisWeek} this week`);
  if (c.later) parts.push(`${c.later} later`);
  if (!parts.length) return `${c.total || 0} item${(c.total || 0) === 1 ? '' : 's'}, none due soon.`;
  return clamp(parts.join(', ') + '.');
}

async function genProjects() {
  const s = await getJson('/api/projects');
  const projects = s.projects || [];
  if (!projects.length) return 'No projects declared.';
  const hasDash = projects.filter((p) => p.state === 'has a control centre').length;
  const missing = projects.filter((p) => p.state === 'missing from disk').length;
  const parts = [`${projects.length} project${projects.length === 1 ? '' : 's'}`];
  if (hasDash) parts.push(`${hasDash} with dashboards`);
  if (missing) parts.push(`${missing} missing`);
  return clamp(parts.join(', ') + '.');
}

async function genWork() {
  const s = await getJson('/api/work/items');
  const counts = s.counts || {};
  const queued = counts.queued || 0;
  const running = counts.running || 0;
  const done = counts.done || 0;
  const failed = counts.failed || 0;
  const parts = [];
  if (queued) parts.push(`${queued} queued`);
  if (running) parts.push(`${running} running`);
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  if (!parts.length) return 'Work queue empty.';
  return clamp(parts.join(', ') + '.');
}

async function genMail() {
  const s = await getJson('/api/mail');
  const accounts = s.accounts || [];
  if (!accounts.length) return 'No mail imported yet.';
  const total = accounts.reduce((a, x) => a + (x.messages_held || 0), 0);
  const parts = [`${accounts.length} account${accounts.length === 1 ? '' : 's'}`];
  if (total) parts.push(`${total.toLocaleString()} message${total === 1 ? '' : 's'}`);
  const unimported = s.authorisedNotYetImported || [];
  if (unimported.length) parts.push(`${unimported.length} authorised but unimported`);
  return clamp(parts.join(', ') + '.');
}

async function genLifestyle() {
  const s = await getJson('/api/lifestyle');
  const c = s.counts || {};
  const parts = [];
  if (c.due) parts.push(`${c.due} chore${c.due === 1 ? '' : 's'} due`);
  if (c.active) parts.push(`${c.active} active`);
  if (c.paused) parts.push(`${c.paused} paused`);
  if (!parts.length) return 'No chores. Add one to start the schedule.';
  return clamp(parts.join(', ') + '.');
}

async function genExercise() {
  const s = await getJson('/api/exercise');
  if (s.state === 'empty') return 'No exercise recorded yet.';
  const kinds = s.kinds || [];
  const total = s.total || (s.recent || []).length;
  const parts = [`${total} session${total === 1 ? '' : 's'}`];
  if (kinds.length) parts.push(`${kinds.length} kind${kinds.length === 1 ? '' : 's'}`);
  // Last activity — the most recent lastDay across all kinds
  const lastDay = kinds.reduce((latest, k) => {
    if (k.lastDay && (!latest || k.lastDay > latest)) return k.lastDay;
    return latest;
  }, null);
  if (lastDay) parts.push(`last ${lastDay}`);
  return clamp(parts.join(', ') + '.');
}

async function genBrain() {
  const s = await getJson('/api/brain');
  const total = s.total || 0;
  if (!total) return 'Memory store is empty.';
  const flagged = s.flagged || 0;
  const parts = [`${total} memor${total === 1 ? 'y' : 'ies'}`];
  if (flagged) parts.push(`${flagged} flagged`);
  // Also fetch notes count if available
  try {
    const notes = await getJson('/api/brain/notes');
    const noteCount = (notes.notes || []).length;
    if (noteCount) parts.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`);
  } catch { /* notes endpoint failed — skip, not critical */ }
  return clamp(parts.join(', ') + '.');
}

async function genBrowsing() {
  const s = await getJson('/api/browsing');
  if (s.state === 'empty') return 'No browsing data imported yet.';
  const w = s.window || {};
  const top = (s.top || [])[0];
  const parts = [];
  if (w.domains) parts.push(`${w.domains} domain${w.domains === 1 ? '' : 's'}`);
  if (w.visits) parts.push(`${w.visits} visit${w.visits === 1 ? '' : 's'}`);
  if (top) parts.push(`top: ${top.domain}`);
  if (!parts.length) return 'Browsing data available.';
  return clamp(parts.join(', ') + '.');
}

async function genAtlas() {
  const s = await getJson('/api/atlas');
  const visited = s.visited || 0;
  const total = s.total || 0;
  const pct = s.percent || 0;
  return clamp(`${visited} of ${total} countries visited (${pct}%).`);
}

async function genVoice() {
  const s = await getJson('/api/voice/status');
  const voice = (s.tts && s.tts.voice) || 'unknown';
  // Turn the voice code into a readable name: en-AU-NatashaNeural -> Natasha (Australian)
  const m = voice.match(/en-([A-Z]{2})-(\w+)Neural/);
  const friendly = m ? `${m[2]} (${{ AU: 'Australian', GB: 'British', US: 'American' }[m[1]] || m[1]})` : voice;
  const sttEnabled = s.stt && s.stt.enabled;
  return clamp(`Click to talk. Talk-back is off. Voice: ${friendly}.`);
}

// --- registry -------------------------------------------------------------------
const GENERATORS = {
  focus: genFocus,
  board: genBoard,
  team: genTeam,
  finance: genFinance,
  budget: genBudget,
  income: genIncome,
  machine: genMachine,
  analytics: genAnalytics,
  wellbeing: genWellbeing,
  safety: genSafety,
  goals: genGoals,
  schedule: genSchedule,
  projects: genProjects,
  work: genWork,
  mail: genMail,
  lifestyle: genLifestyle,
  exercise: genExercise,
  brain: genBrain,
  browsing: genBrowsing,
  atlas: genAtlas,
  voice: genVoice,
};

// --- route ----------------------------------------------------------------------
router.get('/:panel', async (req, res) => {
  const panel = req.params.panel;
  const title = TITLES[panel] || panel.charAt(0).toUpperCase() + panel.slice(1);
  const fallback = FALLBACKS[panel] || `Summary for ${panel}.`;
  const gen = GENERATORS[panel];

  if (!gen) {
    // Unknown panel: return the fallback so the lede still renders, with a 200.
    return res.json({ panel, title, lede: fallback });
  }

  try {
    const lede = await byStorage.run(req.by || 'unknown', () => gen());
    res.json({ panel, title, lede: clamp(lede || fallback) });
  } catch (err) {
    // A failed data fetch returns the static fallback, not an error — the lede is a
    // convenience, not a critical path, and a 500 here would break the panel that called it.
    // The fallback describes what the panel IS, so it degrades gracefully.
    res.json({ panel, title, lede: fallback });
  }
});

module.exports = router;