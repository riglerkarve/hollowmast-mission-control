'use strict';
//
// weekly-synthesis.js — one weekly view of what deserves attention, not four
// signals to check separately.
//
// GET /api/weekly-synthesis — returns { headline, momentum, time, failed, generatedAt }
//
// This is M136. Four features were built separately and each answers a real question
// on its own:
//   M131  briefing's stuck-longest fact       (/api/briefing/morning -> needsYou)
//   M132  cross-venture momentum + staleness  (/api/ventures)
//   M133  time-allocation, by agent/project   (/api/time-allocation)
//   M134  new-venture decision nudges         folded INTO M131's fact, not separate
//
// Each is a real, useful, standalone panel. The owner's ask was narrower: a single
// weekly screen that leads with the one thing that deserves attention, with the other
// three folded in as supporting context — not four places to visit to get the same
// answer.
//
// R1/R2 OF THE MODULE CONTRACT: this route derives NOTHING that another module already
// owns. It fetches the three routes above over loopback HTTP (the same pattern lede.js,
// digest.js and prioritize.js already use) and SELECTS from what they return. The
// stuck-longest fact is briefing.js's fromStalest() — already M131 folded with M134 —
// and is read here verbatim, never recomputed. A second computation of "what is stuck
// longest" would agree with briefing.js until one was edited, then disagree without
// either erroring, which is the exact failure this project keeps meeting.
//
// ABSENCE AND FAILURE MUST NOT LOOK THE SAME. Each of the three sources is fetched
// independently; a source that throws lands in `failed` with its own reason, and the
// other two still render. A quiet week (nothing stuck, nothing stalled) is a real
// state and is reported as one, not hidden behind a broken fetch that looks the same.
const express = require('express');

const router = express.Router();

async function localFetch(path, { timeoutMs = 4000 } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, error: `${path} answered ${r.status}` };
    const data = await r.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `${path} unreachable: ${e.message}` };
  }
}

function clip(text, len) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length <= len) return s;
  const cut = s.slice(0, len);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > len * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

// The headline: briefing.js's own stuck-longest fact, read verbatim, never recomputed.
// fromStalest() always writes urgency 'P1' and a text starting 'Stuck longest: ' when it
// has one — that stable prefix is the one thing this route relies on to find its own
// output among the other needsYou lines (unread handovers, P1 board items, schedule
// deadlines, brain decisions) without re-deriving which one it was.
function pickHeadline(briefing) {
  const needsYou = (briefing && briefing.needsYou) || [];
  const stuck = needsYou.find((n) => String(n.text || '').startsWith('Stuck longest:'));
  if (stuck) {
    return { text: clip(stuck.text, 160), source: stuck.source || 'briefing', kind: 'stuck-longest' };
  }
  // Nothing stuck long enough to report (briefing.js only pushes this when days >= 1
  // and something is actually open) — a real "quiet" state, not a failure to look.
  return null;
}

// Momentum context (M132): ventures that are not merely open but actively losing ground.
// 'parked' is excluded on purpose — a venture parked by design is not a venture that
// needs attention, and conflating the two would nag about work deliberately not in the
// rotation. Sorted worst-first by days since activity, same order the ventures panel uses.
function summariseMomentum(ventures) {
  const list = (ventures && ventures.ventures) || [];
  const stalled = list
    .filter((v) => v.momentum === 'stalled')
    .sort((a, b) => (b.daysSinceActivity || 0) - (a.daysSinceActivity || 0));
  const slowing = list.filter((v) => v.momentum === 'slowing').length;
  const active = list.filter((v) => v.momentum === 'active').length;
  return {
    total: list.length,
    active,
    slowing,
    stalledCount: stalled.length,
    stalled: stalled.slice(0, 5).map((v) => ({
      name: v.name,
      daysSinceActivity: v.daysSinceActivity,
      openItems: v.openItems,
      staleItems: v.staleItems,
    })),
  };
}

// Time context (M133): where the last 7 days actually went, top project and top agent.
// Not scored against anything — time-allocation.js deliberately makes no judgement about
// whether a split is "right"; this route inherits that restraint and only reports it.
function summariseTime(alloc) {
  if (!alloc || !alloc.total) return { total: 0, topProject: null, topAgent: null };
  const byProject = (alloc.byProject || [])[0] || null;
  const byAgent = (alloc.byAgent || [])[0] || null;
  return {
    total: alloc.total,
    days: alloc.days,
    topProject: byProject ? { project: byProject.project, minutes: byProject.minutes, percent: byProject.percent } : null,
    topAgent: byAgent ? { agent: byAgent.agent, minutes: byAgent.minutes, percent: byAgent.percent } : null,
  };
}

router.get('/', async (req, res) => {
  const generatedAt = new Date().toISOString();
  const failed = [];

  const [briefingRes, venturesRes, timeRes] = await Promise.all([
    localFetch('/api/briefing/morning'),
    // ventures.js shells out to `git log` per registered project, one at a time — slower
    // than the other two sources. Measured over 4s on this workspace's project count, so
    // this gets its own longer budget rather than sharing the 4s default and reading as
    // "unreachable" when it was simply still working.
    localFetch('/api/ventures', { timeoutMs: 10000 }),
    localFetch('/api/time-allocation?days=7'),
  ]);

  if (!briefingRes.ok) failed.push({ source: 'briefing', reason: briefingRes.error });
  if (!venturesRes.ok) failed.push({ source: 'ventures', reason: venturesRes.error });
  if (!timeRes.ok) failed.push({ source: 'time-allocation', reason: timeRes.error });

  const headline = briefingRes.ok ? pickHeadline(briefingRes.data) : null;
  const momentum = venturesRes.ok ? summariseMomentum(venturesRes.data) : null;
  const time = timeRes.ok ? summariseTime(timeRes.data) : null;

  res.json({ headline, momentum, time, failed: failed.length ? failed : undefined, generatedAt });
});

module.exports = router;
