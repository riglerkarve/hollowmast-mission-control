#!/usr/bin/env node
//
// onboard.cjs — the generated onboarding synthesis for a new session (M143).
//
//   node tools/onboard.cjs            markdown to stdout
//   node tools/onboard.cjs --json     the same data as JSON
//
// The owner's condition on M143 was that this be GENERATED, not hand-maintained
// (quiz round 3, 20 Aug). So this file contains no knowledge of its own:
// every figure is fetched from the API route that owns it, and every piece of
// standing doctrine is a POINTER to the file that owns it, never a restatement
// that could drift. If a source cannot be reached it prints COULD NOT LOOK for
// that section rather than a number — a fresh session must never mistake a
// down server for a quiet workspace (fourth law: absence and failure must look
// different).
//
// One-owner rule, applied: this composes /api/ventures (momentum), /api/decisions
// (what stands, what is due), /api/team/shift (who handed over, what is blocked,
// what needs the owner), /api/board (open work). It derives nothing those owners
// already derive, and it caches nothing.
//
const BASE = process.env.MC_BASE || 'http://localhost:3000';
const JSON_MODE = process.argv.includes('--json');

async function look(path) {
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { err: 'HTTP ' + r.status };
    return { data: await r.json() };
  } catch (e) { return { err: (e && e.message) || 'fetch failed' }; }
}

(async () => {
  const [ventures, decisions, shift, board] = await Promise.all([
    look('/api/ventures'), look('/api/decisions'), look('/api/team/shift'), look('/api/board'),
  ]);

  const out = { generatedAt: new Date().toISOString(), base: BASE, sections: {} };
  const md = [];
  md.push('# Session onboarding — generated ' + out.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC');
  md.push('');
  md.push('Everything below is fetched live from the route that owns it; nothing here is');
  md.push('hand-maintained. The standing doctrine lives in files, not in this synthesis:');
  md.push('read `TEAM.md` (roles: what may interrupt whom; the handover contract),');
  md.push('the workspace `CLAUDE.md` (the gate, the four laws, never-do list), and the');
  md.push('project `CLAUDE.md` beside whatever code you touch. The git INDEX is shared');
  md.push('across sessions: stage by explicit path, never `git add -A`.');

  // ------------------------------------------------------------- decisions
  md.push('', '## Decisions in force (owner: /api/decisions)');
  if (decisions.err) { md.push('COULD NOT LOOK: ' + decisions.err); out.sections.decisions = { err: decisions.err }; }
  else {
    const rows = decisions.data.decisions || [];
    const due = rows.filter(d => d.due || d.revisitDue);
    out.sections.decisions = { count: rows.length, due: due.length };
    md.push(rows.length + ' recorded; newest first, the three most recent:');
    for (const d of rows.slice(0, 3)) md.push('- #' + d.id + ' — ' + String(d.text || d.decision || '').slice(0, 160));
    if (due.length) { md.push('', '**DUE FOR REVISIT (M146 radar):**'); for (const d of due) md.push('- #' + d.id + ' — ' + String(d.text || d.decision || '').slice(0, 120)); }
  }

  // ------------------------------------------------------------- ventures
  md.push('', '## Ventures: momentum and staleness (owner: /api/ventures)');
  if (ventures.err) { md.push('COULD NOT LOOK: ' + ventures.err); out.sections.ventures = { err: ventures.err }; }
  else {
    const vs = ventures.data.ventures || [];
    out.sections.ventures = vs.map(v => ({ name: v.name, momentum: v.momentum, open: v.openItems, stale: v.staleItems }));
    for (const v of vs) md.push('- **' + v.name + '** — ' + v.momentum + ', ' + (v.daysSinceActivity == null ? 'no recorded activity' : v.daysSinceActivity + 'd since activity') + ', ' + v.openItems + ' open / ' + v.staleItems + ' stale');
  }

  // ------------------------------------------------------------- the shift
  md.push('', '## The current shift (owner: /api/team/shift)');
  if (shift.err) { md.push('COULD NOT LOOK: ' + shift.err); out.sections.shift = { err: shift.err }; }
  else {
    const s = shift.data || {};
    const hs = s.handovers || s.filed || [];
    const needsOwner = s.needs_owner || s.needsOwner || [];
    const blocked = s.blocked || [];
    out.sections.shift = { handovers: hs.length, needsOwner: needsOwner.length, blocked: blocked.length };
    md.push((hs.length || 'no') + ' handover(s) filed this shift; ' + blocked.length + ' blocked item(s); ' + needsOwner.length + ' waiting on the owner.');
    for (const b of blocked.slice(0, 5)) md.push('- blocked: ' + String(b.text || b.note || b).slice(0, 120));
  }

  // ------------------------------------------------------------- the board
  md.push('', '## Open work (owner: /api/board)');
  if (board.err) { md.push('COULD NOT LOOK: ' + board.err); out.sections.board = { err: board.err }; }
  else {
    const items = board.data.items || [];
    const open = items.filter(i => !/done|closed|wontfix/i.test(i.status || 'open'));
    const byProject = {};
    for (const i of open) byProject[i.project || '?'] = (byProject[i.project || '?'] || 0) + 1;
    out.sections.board = { open: open.length, byProject };
    md.push(open.length + ' open across: ' + Object.entries(byProject).map(([k, v]) => k + ' ' + v).join(' · '));
    md.push('The board mirrors each project tracker READ-ONLY — write bugs in `Survive/BUGS.md` etc., never here.');
  }

  md.push('', '---', 'File your handover at shift end: write the markdown, then from `mission-control`:',
    '`node tools/handover.cjs handover/<date>-<you>.md --title "<your title>"`.',
    '"Blocked on you" is the only route from a worker to the owner.');

  if (JSON_MODE) console.log(JSON.stringify(out, null, 1));
  else console.log(md.join('\n'));
})();
