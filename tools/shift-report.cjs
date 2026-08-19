#!/usr/bin/env node
//
// shift-report.cjs — the shift, written up for review.
//
//   node tools/shift-report.cjs                     the current shift
//   node tools/shift-report.cjs --shift 2026-08-19-afternoon
//   node tools/shift-report.cjs --out reports/team/  write the markdown as well as printing
//
// Owner instruction, 19 Aug 2026: "ensure every plan and decision is being recorded and
// reports made for review... This is to ensure a smooth learning curve and production output
// as you will be learning from feedback."
//
// SO THE REPORT'S JOB IS TO BE REVIEWABLE, WHICH IS NOT THE SAME AS BEING COMPLETE. A dump of
// everything that happened is unreadable and gets skimmed; what makes feedback possible is
// that each claim is attributed and each gap is named. Two halves:
//
//   WHAT WAS DECIDED — every decision in the shift, joined from the four places they live,
//                      each with who decided it and why. Never re-recorded here: a verdict
//                      lives on team_plans, an answer on team_steering, and this reads them.
//   WHAT THE PROCESS MISSED — derived, and the half that earns the report. A list of what
//                      happened cannot tell you the chain stalled; a list of what did NOT
//                      happen can, and it needs no one to remember to file it.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
db.setProcessActor('claude');

const team = require('../server/routes/team');
require('../server/routes/board');
const todo = require('../server/routes/todo');

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const SHIFT = arg('shift') || team.shiftLabel();
const OUT = arg('out');

const all = (s, ...a) => db.prepare(s).all(...a);
const L = [];
const p = (s = '') => L.push(s);

const handovers = all('SELECT * FROM team_handovers WHERE shift = ? ORDER BY at', SHIFT);
const plans = all('SELECT * FROM team_plans WHERE shift = ? ORDER BY id', SHIFT);
const steering = all('SELECT * FROM team_steering WHERE shift = ? ORDER BY id', SHIFT);
const decisions = all('SELECT * FROM team_decisions WHERE shift = ? ORDER BY id', SHIFT);
const assignments = all('SELECT * FROM team_assignments WHERE shift = ? ORDER BY id', SHIFT);
const roster = all('SELECT * FROM team_sessions WHERE retired_at IS NULL');

p(`# Shift report — ${SHIFT}`);
p();
p(`_Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by \`tools/shift-report.cjs\`._`);
p(`_Nothing here is typed. Every line is read from the module that owns it._`);
p();

// ---------------------------------------------------------------- what the shift produced
p('## What the shift produced');
p();
p('| | |');
p('|---|---|');
p(`| Handovers filed | ${handovers.length} of ${roster.length} on the roster |`);
p(`| Plans drafted | ${plans.length} |`);
p(`| Plans confirmed | ${plans.filter((x) => x.confirmed_at).length} |`);
p(`| Work delegated | ${assignments.length} |`);
p(`| Decisions recorded | ${decisions.length + steering.filter((s) => s.answer).length + plans.filter((x) => x.verdict).length} |`);
p(`| Questions put to the owner | ${steering.length} |`);
p();

// ------------------------------------------------------------------------ what was decided
p('## What was decided, and by whom');
p();
const anyDecision = decisions.length || steering.length || plans.filter((x) => x.verdict).length;
if (!anyDecision) {
  p('**Nothing was decided this shift.** That is a real finding rather than a formatting');
  p('artefact — work happened, and no call was recorded about any of it.');
  p();
}

for (const d of decisions) {
  p(`### ${d.decision}`);
  p(`**${d.decided_by}**${d.role ? ` · ${d.role}` : ''} · ${String(d.at).slice(11, 16)}`);
  p();
  p(`**Because:** ${d.because}`);
  if (d.cost_if_wrong) p(`\n**If this is wrong:** ${d.cost_if_wrong}`);
  if (d.revisit_when) p(`\n**Revisit when:** ${d.revisit_when}${d.recheck_at ? ` (by ${d.recheck_at})` : ''}`);
  if (d.evidence) p(`\n**Evidence:** ${d.evidence}`);
  p();
}

for (const s of steering.filter((x) => x.answer)) {
  p(`### ${s.question.length > 90 ? `${s.question.slice(0, 90)}…` : s.question}`);
  p(`**The owner** · answered ${String(s.answered_at).slice(11, 16)}`);
  p();
  p(`**Decided:** ${s.answer}`);
  p(`\n**The manager had recommended:** ${s.recommend}`);
  // Attribution is printed even when it is missing, because `unknown` on the one table that
  // holds the owner's own judgement is exactly the gap worth seeing.
  if (s.by_whom && s.by_whom !== 'you') p(`\n> Recorded as \`${s.by_whom}\` rather than \`you\`. Attribution on this row is not certain.`);
  p();
}

for (const pl of plans.filter((x) => x.verdict)) {
  p(`### Plan #${pl.id} — ${pl.confirmed_at ? 'confirmed' : 'returned'}`);
  p(`**${pl.confirmed_by || 'the manager'}** · ${String(pl.confirmed_at || pl.returned_at).slice(11, 16)}`);
  p();
  p(`**Verdict:** ${pl.verdict}`);
  p();
}

// --------------------------------------------------------------- what the process missed
// THE DERIVED HALF. Everything above is a record of what happened; a record cannot tell you
// the chain stalled, because a stall leaves no row. These are absences, and each one is a
// question somebody should answer next shift.
p('## What the process missed');
p();
const gaps = [];

const unread = handovers.filter((h) => !h.read_at);
if (unread.length) {
  gaps.push(`**${unread.length} of ${handovers.length} handovers were never read** — ${unread.map((h) => h.title).join(', ')}. `
    + 'A handover nobody reads is a shift that reported into nothing, and the session that wrote it has no way to know.');
}

const drafts = plans.filter((x) => !x.confirmed_at && !x.returned_at);
if (drafts.length) {
  gaps.push(`**${drafts.length} plan(s) were drafted and never put to the manager** (#${drafts.map((d) => d.id).join(', #')}). `
    + 'Neither confirmed nor returned, so nothing can be delegated against them and nothing marks them as abandoned.');
}

const confirmedNoWork = plans.filter((x) => x.confirmed_at && !assignments.some((a) => a.plan_id === x.id));
if (confirmedNoWork.length) {
  gaps.push(`**${confirmedNoWork.length} confirmed plan(s) had no work delegated against them** (#${confirmedNoWork.map((d) => d.id).join(', #')}). `
    + 'The chain ran handover → plan → confirm and stopped. From every other view this looks identical to success.');
}

const untriaged = handovers.filter((h) => h.needs_owner && !h.owner_resolved_at);
if (untriaged.length) {
  gaps.push(`**${untriaged.length} owner-facing item(s) are sitting untriaged** — from ${untriaged.map((h) => h.title).join(', ')}. `
    + 'These are the only route a worker has to the owner. Until the manager triages them they reach nobody.');
}

const openQ = steering.filter((s) => !s.answer);
if (openQ.length) gaps.push(`**${openQ.length} steering question(s) are still waiting on the owner.**`);

const reported = new Set(handovers.map((h) => h.title));
const silent = roster.filter((r) => !reported.has(r.title));
if (silent.length) {
  gaps.push(`**${silent.length} session(s) on the roster filed nothing** — ${silent.map((s) => s.title).join(', ')}. `
    + 'Silence and having nothing to say look identical from here, and the second is rare.');
}

const badAttrib = steering.filter((s) => s.answer && (!s.by_whom || s.by_whom === 'unknown'));
if (badAttrib.length) {
  gaps.push(`**${badAttrib.length} answered steering question(s) are attributed to \`unknown\`.** `
    + 'This is the one table holding the owner\'s own judgement; an unattributed row there cannot be told from a session answering for him.');
}

if (!gaps.length) p('Nothing. Every handover was read, every plan resolved, every owner-facing item triaged.');
else for (const g of gaps) p(`- ${g}\n`);
p();

// ------------------------------------------------------------------------- for the owner
p('## For your review');
p();
p('The two questions worth answering, because they are what the next shift changes on:');
p();
p('1. **Are the decisions above the right ones?** Each carries its reasoning, so a "no" here');
p('   is actionable — it tells the team which reasoning to stop using, not just which call to reverse.');
p('2. **Which of the gaps matters?** They are listed because they are absences, not because');
p('   they are all worth fixing. A gap you do not care about should be removed from this report');
p('   rather than tolerated in it, or it becomes a line everyone learns to skip.');
p();
p('Feedback goes to the Team Manager, which is the only role that may reach you and the only');
p('one that can put it into the next plan.');

const text = `${L.join('\n')}\n`;
console.log(`\n${text}`);

// ------------------------------------------------------------------------------ html
// The HTML is generated from the same arrays as the markdown, never hand-written, so the
// reviewable copy cannot drift from the recorded one. A report the owner reads that disagrees
// with the database is worse than no report, because the disagreement is invisible to him.
const HTML = arg('html');
if (HTML) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hm = (s) => String(s).slice(11, 16);

  // Each gap is labelled by the KIND of absence, not numbered. They are not a sequence, and
  // a number would imply an order the data does not have.
  const gapRows = [
    ['unread', unread.length, `${unread.length} of ${handovers.length} handovers never read`,
      unread.map((h) => h.title).join(', '),
      'A handover nobody reads is a shift that reported into nothing, and the session that wrote it has no way to know.'],
    ['hanging', drafts.length, `${drafts.length} plan(s) drafted, never put to the manager`,
      drafts.map((d) => `#${d.id}`).join(', '),
      'Neither confirmed nor returned, so nothing can be delegated against them and nothing marks them abandoned.'],
    ['undelegated', confirmedNoWork.length, `${confirmedNoWork.length} confirmed plan(s) with no work delegated`,
      confirmedNoWork.map((d) => `#${d.id}`).join(', '),
      'The chain ran handover to plan to confirm, and stopped. From every other view this looks identical to success.'],
    ['untriaged', untriaged.length, `${untriaged.length} owner-facing item(s) untriaged`,
      untriaged.map((h) => h.title).join(', '),
      'These are the only route a worker has to you. Until the manager triages them they reach nobody.'],
    ['unanswered', openQ.length, `${openQ.length} steering question(s) waiting on you`, '', ''],
    ['silent', silent.length, `${silent.length} session(s) on the roster filed nothing`,
      silent.map((s) => s.title).join(', '),
      'Silence and having nothing to say look identical from here, and the second is rare.'],
    ['unattributed', badAttrib.length, `${badAttrib.length} answered question(s) attributed to unknown`, '',
      'This is the one table holding your own judgement; an unattributed row cannot be told from a session answering for you.'],
  ].filter((g) => g[1] > 0);

  const decBlocks = decisions.map((d) => `
    <article class="rec">
      <h3>${esc(d.decision)}</h3>
      <p class="attr"><span class="who">${esc(d.decided_by)}</span>${d.role ? `<span class="role">${esc(d.role)}</span>` : ''}<span class="t">${esc(hm(d.at))}</span></p>
      <dl>
        <dt>Because</dt><dd>${esc(d.because)}</dd>
        ${d.cost_if_wrong ? `<dt>If wrong</dt><dd>${esc(d.cost_if_wrong)}</dd>` : ''}
        ${d.revisit_when ? `<dt>Revisit when</dt><dd>${esc(d.revisit_when)}${d.recheck_at ? ` <span class="mono">(by ${esc(d.recheck_at)})</span>` : ''}</dd>` : ''}
        ${d.evidence ? `<dt>Evidence</dt><dd class="mono">${esc(d.evidence)}</dd>` : ''}
      </dl>
    </article>`).join('');

  const steerBlocks = steering.filter((s) => s.answer).map((s) => `
    <article class="rec rec-owner">
      <h3>${esc(s.question)}</h3>
      <p class="attr"><span class="who">You</span><span class="role">owner</span><span class="t">${esc(hm(s.answered_at))}</span></p>
      <dl>
        <dt>Decided</dt><dd>${esc(s.answer)}</dd>
        <dt>Manager recommended</dt><dd>${esc(s.recommend)}</dd>
        ${s.by_whom && s.by_whom !== 'you' ? `<dt>Attribution</dt><dd class="warn">Recorded as <span class="mono">${esc(s.by_whom)}</span>, not <span class="mono">you</span>. Not certain.</dd>` : ''}
      </dl>
    </article>`).join('');

  const verdictBlocks = plans.filter((x) => x.verdict).map((pl) => `
    <article class="rec">
      <h3>Plan #${pl.id} — ${pl.confirmed_at ? 'confirmed' : 'returned'}</h3>
      <p class="attr"><span class="who">${esc(pl.confirmed_by || 'the manager')}</span><span class="role">manager</span><span class="t">${esc(hm(pl.confirmed_at || pl.returned_at))}</span></p>
      <dl><dt>Verdict</dt><dd>${esc(pl.verdict)}</dd></dl>
    </article>`).join('');

  const html = `<title>Shift ${esc(SHIFT)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:ital,wght@0,400;0,500;1,400&display=swap">
<style>
:root{
  --ground:#f4f6f8; --surface:#ffffff; --ink:#161b22; --muted:#5b6572;
  --accent:#2f5d8c; --warn:#9a5b1e; --rule:#dbe1e8; --sunk:#eef1f5;
  --sans:"IBM Plex Sans",system-ui,sans-serif;
  --serif:"IBM Plex Serif",Georgia,serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,monospace;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ground:#0f1418; --surface:#161c22; --ink:#dfe5ec; --muted:#8b96a5;
    --accent:#7aa8d8; --warn:#d79a55; --rule:#28313a; --sunk:#12181e;
  }
}
:root[data-theme="dark"]{
  --ground:#0f1418; --surface:#161c22; --ink:#dfe5ec; --muted:#8b96a5;
  --accent:#7aa8d8; --warn:#d79a55; --rule:#28313a; --sunk:#12181e;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--serif);
  line-height:1.6;margin:0;padding:clamp(20px,4vw,56px) clamp(16px,4vw,32px);}
.wrap{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:38px}
header{display:flex;flex-direction:column;gap:6px;border-bottom:2px solid var(--ink);padding-bottom:18px}
.eyebrow{font-family:var(--sans);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{font-family:var(--sans);font-weight:600;font-size:clamp(26px,4vw,34px);margin:0;text-wrap:balance;letter-spacing:-.01em}
.sub{font-family:var(--mono);font-size:12px;color:var(--muted);margin:0}
h2{font-family:var(--sans);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted);margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--rule)}
section{display:flex;flex-direction:column}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(116px,1fr));gap:1px;background:var(--rule);
  border:1px solid var(--rule)}
.fig{background:var(--surface);padding:13px 15px}
.fig b{display:block;font-family:var(--sans);font-size:25px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.fig span{display:block;font-family:var(--sans);font-size:11px;color:var(--muted);margin-top:3px}
.fig.zero b{color:var(--warn)}
.rec{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--accent);
  padding:16px 18px;margin-bottom:14px}
.rec-owner{border-left-color:var(--warn)}
.rec h3{font-family:var(--sans);font-size:16px;font-weight:600;margin:0 0 8px;line-height:1.4;text-wrap:balance}
.attr{font-family:var(--mono);font-size:11px;margin:0 0 12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.who{color:var(--ink);font-weight:500}
.role{color:var(--muted);border:1px solid var(--rule);padding:1px 6px;text-transform:uppercase;font-size:10px;letter-spacing:.06em}
.t{color:var(--muted)}
dl{margin:0;display:grid;grid-template-columns:auto;gap:9px}
dt{font-family:var(--sans);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
dd{margin:0 0 2px;font-size:14.5px}
.mono{font-family:var(--mono);font-size:12.5px}
.warn{color:var(--warn)}
.gap{background:var(--surface);border:1px solid var(--rule);padding:14px 16px;margin-bottom:10px;
  display:grid;grid-template-columns:88px 1fr;gap:14px;align-items:start}
.gap .kind{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--warn);border:1px solid var(--warn);padding:2px 0;text-align:center}
.gap h4{font-family:var(--sans);font-size:14.5px;font-weight:600;margin:0 0 4px}
.gap p{margin:0;font-size:13.5px;color:var(--muted)}
.gap .names{font-family:var(--mono);font-size:11.5px;color:var(--ink);margin-bottom:5px;word-break:break-word}
.clean{background:var(--surface);border:1px solid var(--rule);padding:16px 18px;font-size:14.5px}
.ask{background:var(--sunk);border:1px solid var(--rule);padding:18px 20px;display:flex;flex-direction:column;gap:12px}
.ask ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px}
.ask li{font-size:14.5px}
footer{font-family:var(--mono);font-size:11px;color:var(--muted);border-top:1px solid var(--rule);padding-top:14px;line-height:1.7}
@media (max-width:520px){ .gap{grid-template-columns:1fr;gap:8px} .gap .kind{justify-self:start;padding:2px 8px} }
</style>
<div class="wrap">
  <header>
    <p class="eyebrow">Mission Control &middot; session team</p>
    <h1>Shift ${esc(SHIFT)}</h1>
    <p class="sub">generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} &middot; every line read from the module that owns it &middot; nothing typed</p>
  </header>

  <section>
    <h2>What the shift produced</h2>
    <div class="figs">
      <div class="fig"><b>${handovers.length}<span style="font-size:14px;color:var(--muted)">/${roster.length}</span></b><span>handovers filed</span></div>
      <div class="fig"><b>${plans.length}</b><span>plans drafted</span></div>
      <div class="fig"><b>${plans.filter((x) => x.confirmed_at).length}</b><span>confirmed</span></div>
      <div class="fig${assignments.length ? '' : ' zero'}"><b>${assignments.length}</b><span>work delegated</span></div>
      <div class="fig"><b>${decisions.length + steering.filter((s) => s.answer).length + plans.filter((x) => x.verdict).length}</b><span>decisions recorded</span></div>
      <div class="fig"><b>${steering.length}</b><span>put to you</span></div>
    </div>
  </section>

  <section>
    <h2>What was decided, and by whom</h2>
    ${steerBlocks + decBlocks + verdictBlocks || '<div class="clean">Nothing was decided this shift. That is a finding rather than a formatting artefact: work happened, and no call was recorded about any of it.</div>'}
  </section>

  <section>
    <h2>What the process missed</h2>
    ${gapRows.length ? gapRows.map(([kind, , head, names, why]) => `
      <div class="gap">
        <span class="kind">${esc(kind)}</span>
        <div>
          <h4>${esc(head)}</h4>
          ${names ? `<p class="names">${esc(names)}</p>` : ''}
          ${why ? `<p>${esc(why)}</p>` : ''}
        </div>
      </div>`).join('')
    : '<div class="clean">Nothing. Every handover was read, every plan resolved, every owner-facing item triaged.</div>'}
  </section>

  <section>
    <h2>For your review</h2>
    <div class="ask">
      <ol>
        <li><b>Are the decisions above the right ones?</b> Each carries its reasoning, so a &ldquo;no&rdquo; here is actionable &mdash; it names which reasoning to stop using, not just which call to reverse.</li>
        <li><b>Which of the gaps matters?</b> They are listed because they are absences, not because they are all worth fixing. A gap you do not care about should be removed from this report rather than tolerated in it, or it becomes a line everyone learns to skip.</li>
      </ol>
      <p style="margin:0;font-size:14px">Feedback goes to the Team Manager &mdash; the only role that may reach you, and the only one that can put it into the next plan.</p>
    </div>
  </section>

  <footer>
    Sources joined, never re-recorded: team_handovers &middot; team_plans &middot; team_steering &middot; team_decisions &middot; team_assignments.<br>
    Regenerate with <span style="color:var(--ink)">node tools/shift-report.cjs --shift ${esc(SHIFT)} --html &lt;file&gt;</span>
  </footer>
</div>`;

  const hp = path.isAbsolute(HTML) ? HTML : path.join(__dirname, '..', HTML);
  fs.mkdirSync(path.dirname(hp), { recursive: true });
  fs.writeFileSync(hp, html);
  const backH = fs.readFileSync(hp, 'utf8');
  console.log(`  written ${hp} (${backH.length} bytes)`);
}

if (OUT) {
  const dir = path.isAbsolute(OUT) ? OUT : path.join(__dirname, '..', OUT);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shift-${SHIFT}.md`);
  fs.writeFileSync(file, text);
  // Read back rather than trusting the write: a report nobody can open is the same as none.
  const back = fs.readFileSync(file, 'utf8');
  console.log(`  written ${file} (${back.length} bytes, ${back.split('\n').length} lines)`);
}
