'use strict';
//
// digest.js — a plain-language version of the team report, for the owner.
//
// The full shift report (/api/team/report) is written for the supervisor: it
// carries every handover, plan, gap and decision with its own jargon.  An owner
// who just wants to know "what happened and what needs me?" should not have to
// parse it.  This route fetches the report internally and translates it into a
// short, plain-English summary: one sentence, the top few events, who is
// working right now, and anything that looks like a gap or risk — each said in
// words a non-participant can follow.
//
// NOTHING HERE DERIVES GAPS OF ITS OWN.  It reads /api/team/report and the active
// session list, and simplifies what those return.  A second derivation of "what
// the process missed" would agree with the report until one of them was edited,
// and then disagree without either erroring — the exact failure the team route
// was written to prevent.  So the report is the one owner of that truth, and this
// route only paraphrases it.
//
// GIT ACTIVITY HAS THE SAME RULE, ONE OWNER LOWER DOWN. `projects.js` already
// derives "what actually moved, per project" from git log for the briefing
// (progressSince) — a second git-log pass here, scanning the same repos with
// slightly different flags, is exactly the drift M258/M272 keep finding. This
// route calls progressSince() directly (same process, no HTTP hop needed) and
// reshapes its answer; it does not run git itself.
const express = require('express');
const { progressSince } = require('./projects');

const router = express.Router();

// Midnight local time, so "today's activity" means the calendar day the owner is
// in, not a rolling 24h window that reads differently depending on what time he
// opens the panel.
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Turn progressSince()'s per-project rows into the same shape as the rest of the
// digest: short plain-English lines, not a raw commit table. `unmeasurable` is
// kept as a count with names, not folded into "quiet" — a project with no repo
// and a project that had a quiet day are different facts (see projects.js).
function gitActivitySummary() {
  const progress = progressSince(startOfToday());
  const moved = progress.moved.map((p) => ({
    project: p.name,
    commits: p.commits,
    lastSubject: p.lastSubject || '',
    lastAt: p.lastAt || null,
  }));
  return {
    since: progress.since,
    totalCommits: progress.totalCommits,
    moved,
    quietCount: progress.quiet.length,
    unmeasurable: progress.unmeasurable.map((p) => ({ project: p.name, why: p.why })),
  };
}

// Fetch JSON from a local API path, returning { ok, data, error } so the caller
// can degrade gracefully without throwing across the internal hop.  A timeout
// keeps a stuck sub-request from hanging the digest — the whole point of this
// route is that it is quick to read.
async function localFetch(path, { timeoutMs = 4000 } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:3000${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, error: `${path} answered ${r.status}` };
    const data = await r.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `${path} unreachable: ${e.message}` };
  }
}

// Trim a string to <= len chars on a word boundary so the plain-language summary
// never arrives half-cut.  We cut at the last space inside the limit; if the
// first word is already longer than the limit we hard-cut, because a truncated
// token is still more useful than dropping the line entirely.
function clip(text, len) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length <= len) return s;
  const cut = s.slice(0, len);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > len * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

// Turn a gap from the report into a plain-English concern.  The report's `head`
// is already a short count-led sentence; we keep it and add a severity guess from
// the kind, so the panel can colour the row without re-deriving risk itself.
function gapToConcern(gap) {
  const SEVERE = ['untriaged', 'unanswered', 'unactioned', 'hanging'];
  const severity = SEVERE.includes(gap.kind) ? 'severe' : 'note';
  // `head` is a human-readable sentence; use it verbatim rather than rephrasing,
  // because rephrasing a count is where an off-by-one creeps in.
  return { text: clip(gap.head, 140), severity, kind: gap.kind };
}

// Build the plain-language summary sentence from the report's counts.  The
// sentence is assembled from the counts the report already computed — never
// from a second pass over the rows — so it cannot disagree with the report.
function summarise(report, git) {
  const c = report.counts || {};
  const parts = [];

  if (c.handovers) parts.push(`${c.handovers} handover${c.handovers === 1 ? '' : 's'} filed`);
  if (c.plans) parts.push(`${c.confirmed} of ${c.plans} plan${c.plans === 1 ? '' : 's'} confirmed`);
  if (c.assignments) parts.push(`${c.assignments} task${c.assignments === 1 ? '' : 's'} delegated`);
  if (c.decisions) parts.push(`${c.decisions} decision${c.decisions === 1 ? '' : 's'} recorded`);
  if (c.ownerAsks) parts.push(`${c.ownerAsks} ask${c.ownerAsks === 1 ? '' : 's'} for you`);
  if (git && git.totalCommits) {
    parts.push(`${git.totalCommits} commit${git.totalCommits === 1 ? '' : 's'} today across ${git.moved.length} project${git.moved.length === 1 ? '' : 's'}`);
  }

  const gaps = (report.gaps || []).length;
  if (gaps) parts.push(`${gaps} gap${gaps === 1 ? '' : 's'} to look at`);

  const sentence = parts.length ? parts.join(', ') + '.' : 'The shift is quiet — nothing has been filed yet.';
  return clip(sentence, 200);
}

// The top events of the shift, as short plain-English lines.  We draw from the
// handovers' `done` fields first (what shipped), then decisions, then confirmed
// plans — in that order of interest to an owner.  Each line carries who said it
// and when, capped to 100 chars so the panel list stays scannable.
function topHighlights(report) {
  const out = [];

  for (const h of (report.handovers || [])) {
    if (out.length >= 5) break;
    const done = String(h.done || '').trim();
    if (!done) continue;
    out.push({
      text: clip(done, 100),
      who: h.title || h.role || 'a session',
      when: h.at || '',
    });
  }

  for (const d of (report.decisions || [])) {
    if (out.length >= 5) break;
    out.push({
      text: clip(d.decision, 100),
      who: d.decided_by || 'the team',
      when: d.at || '',
    });
  }

  return out.slice(0, 5);
}

// Who is working right now.  The active-session list is the live truth; the
// roster is a fallback so an empty digest still names the team that is on.
function workingFrom(active, roster) {
  if (active && active.length) {
    return active.map((s) => ({
      agent: s.actor || 'a session',
      status: 'active',
      task: s.todoTitle || s.project || 'working',
    }));
  }
  // No live heartbeats: fall back to the roster so the owner still sees who is
  // supposed to be on, marked as 'not reporting' rather than 'active' — absence
  // and failure must never look the same.
  if (roster && roster.length) {
    return roster.slice(0, 8).map((s) => ({
      agent: s.title || s.id || 'a session',
      status: 'not reporting',
      task: s.project || s.role || '—',
    }));
  }
  return [];
}

// GET /api/digest — the plain-language shift summary.
router.get('/', async (req, res) => {
  const generatedAt = new Date().toISOString();

  const [reportRes, activeRes] = await Promise.all([
    localFetch('/api/team/report'),
    localFetch('/api/sessions/active'),
  ]);

  // If the team report failed we still return what we have, with a note, rather
  // than a 500 — the owner's digest should never be blank because one internal
  // hop stumbled.  The note is shown in the panel so the failure is visible.
  // git activity is derived in-process (progressSince), so it cannot itself fail
  // the way an HTTP hop can — but a project's own git log can, and progressSince
  // already reports those as `unmeasurable` rather than swallowing them.
  let git = null;
  let gitError = null;
  try {
    git = gitActivitySummary();
  } catch (e) {
    gitError = e.message || 'git activity could not be read';
  }

  if (!reportRes.ok) {
    const working = workingFrom(activeRes.ok ? activeRes.data.active : [], []);
    const concerns = [{ text: reportRes.error || 'team report unavailable', severity: 'severe' }];
    if (gitError) concerns.push({ text: `git activity unavailable: ${gitError}`, severity: 'note' });
    return res.json({
      summary: 'The team report could not be read, so this digest is incomplete.',
      highlights: [],
      working,
      git,
      concerns,
      generatedAt,
      note: reportRes.error || 'team report unavailable',
    });
  }

  const report = reportRes.data;
  const active = activeRes.ok ? (activeRes.data.active || []) : [];
  const roster = report.roster || [];

  const concerns = (report.gaps || []).map(gapToConcern);
  if (gitError) concerns.push({ text: `git activity unavailable: ${gitError}`, severity: 'note' });

  res.json({
    summary: summarise(report, git),
    highlights: topHighlights(report),
    working: workingFrom(active, roster),
    git,
    concerns,
    generatedAt,
  });
});

module.exports = router;