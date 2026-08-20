// The morning briefing. Every number is computed in SQL; the model, if it is running,
// only writes the sentence that introduces them.
//
//   node scripts/briefing.cjs           generate for today, write to reports/ and the DB
//   node scripts/briefing.cjs --dry     print a read-only preview from stored data; skips
//                                       Gmail sync, queued work, the CLAUDE.md stamp and access
//                                       logging, so the preview may be stale
//   node scripts/briefing.cjs --date 2026-08-12
//
// Descends from income-portfolio/scripts/daily-briefing.mjs and keeps its two best ideas:
// narrative inputs go stale and must expire, and zero is reported as zero rather than
// dressed up. It is a separate program because that one runs in GitHub Actions where this
// SQLite database does not exist — a known divergence with a reason, not an oversight.
'use strict';

// WHAT IS DELIBERATELY NOT HERE, and why. 18 Aug 2026.
//
// The briefing now asks 15 of the 28 modules. The other 13 were each looked at and left out
// on purpose; this list exists so the next session does not spend the evening rediscovering
// the same reasons. Wiring a module in is cheap — the judgement is whether it has anything to
// say at 07:00 that changes what you do.
//
//   mail      MEASURED AND REJECTED. 64,225 of 69,078 messages are unread — 93% — and 255 of
//             the last 266 received, 96%. Unread cannot separate "needs you" from "normal" at
//             any window, so a daily line would be permanently alarming and never actionable.
//             The helper written for it was deleted rather than left unused.
//   cash      Never counted, and it is manual capture. A line reading "never counted" every
//             morning is nagging, which is the one thing this file must not become.
//   drive     One file. There is nothing to say.
//   browsing  Descriptive rather than actionable: it tells you where the time went, which is a
//             thing to sit and read, not a thing to act on before breakfast.
//   stats     Describes the dashboard, not the day.
//   atlas     Countries visited. Not a daily fact.
//   exercise  Zero rows. Wiring an empty table produces an empty heading.
//   brain     Two notes. Same.
//   gate      Only matters when it refuses someone, and that already raises an alert.
//   uptime    The service's own uptime, already covered by the Mission Control section.
//   projects  A registry other modules ask; it holds no daily fact of its own.
//   reports   A rendering surface, not a source.
//   garage    A static console, not a data module.
//
// The rule that decided all of them: a section that renders every morning regardless of state
// teaches the reader to skip it, and once skipped it takes the useful sections with it. Every
// section here stays silent unless it has something to say.

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const dateIdx = args.indexOf('--date');
const TODAY = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().slice(0, 10);

// db.js normally records reads of sensitive tables. That is a persistent write, so turn it
// off before loading the database for a genuinely read-only preview.
if (DRY) process.env.MC_DISABLE_ACCESS_LOG = '1';

const db = require('../server/db');
// Provenance: this runs from Task Scheduler with no human and no request, so without
// this every read it makes is logged 'unknown'. See server/provenance.js.
db.setProcessActor('schedule');
require('../server/routes/finance');
require('../server/routes/briefing');

// Asked, not read. Each module publishes what the briefing needs; none of their tables are
// touched here, so a figure cannot end up with two owners that quietly disagree.
const tasks = require('../server/routes/tasks');
const todo = require('../server/routes/todo');
const sessions = require('../server/routes/sessions');
const lifestyle = require('../server/routes/lifestyle');
const wellbeing = require('../server/routes/wellbeing');
const schedule = require('../server/routes/schedule');
const health = require('../server/routes/health');
const income = require('../server/routes/income');
const budget = require('../server/routes/budget');
const safety = require('../server/routes/safety');
const machine = require('../server/routes/machine');
const finance = require('../server/routes/finance');
const stats = require('../server/routes/stats');
const projects = require('../server/routes/projects');
const goals = require('../server/routes/goals');
const alerts = require('../server/routes/alerts');
const analytics = require('../server/routes/analytics');

const ROOT = path.join(__dirname, '..');
const HOST = 'http://127.0.0.1:11434';
const MODEL = process.env.PROBE_MODEL || 'qwen3.5:9b';

const gbp = (p) => `£${(Math.abs(p) / 100).toFixed(2)}`;

// --- facts ------------------------------------------------------------------------
// Everything below is SQL. A model is never asked to compute, compare or total anything:
// a plausible number is worse than no number, because you cannot tell it is wrong.
function gatherFacts() {
  // The manager's open steering questions. Wrapped because the team module is newer than this
  // script, and a briefing that throws is a briefing nobody gets — every other number here
  // would be lost to one missing table.
  let steering = [];
  let steeringError = null;
  try {
    steering = require('../server/routes/team').openSteering();
  } catch (e) {
    steeringError = String((e && e.message) || e).slice(0, 160);
  }

  const ledger = db.prepare(
    `SELECT MIN(date) a, MAX(date) b, COUNT(*) n FROM finance_transactions`
  ).get();

  // THE LEDGER IS AN IMPORT, NOT A FEED. It ends when the last statement ended. A
  // "yesterday's spending" section would render empty and read as "you spent nothing",
  // which is a lie of exactly the kind this file exists to avoid.
  const staleDays = Math.floor((new Date(TODAY) - new Date(ledger.b)) / 86400000);

  // Compare the last complete 28 days of the ledger with the 28 before them. A window,
  // not a forecast — and 28 days so weekday effects cancel.
  const win = (from, to) => db.prepare(
    `SELECT category, COUNT(*) n, SUM(-amount_pence) p
       FROM finance_transactions
      WHERE amount_pence < 0 AND category NOT IN ('Own transfer', 'Cash withdrawn')
        AND date > ? AND date <= ?
      GROUP BY category ORDER BY p DESC`
  ).all(from, to);

  const d = (n) => new Date(new Date(ledger.b) - n * 86400000).toISOString().slice(0, 10);
  const recent = win(d(28), d(0));
  const prior = win(d(56), d(28));
  const priorMap = new Map(prior.map((r) => [r.category, r.p]));

  const movers = recent
    .map((r) => ({ category: r.category, now: r.p, was: priorMap.get(r.category) || 0 }))
    .map((r) => ({ ...r, delta: r.now - r.was }))
    .filter((r) => Math.abs(r.delta) >= 2000)          // ignore noise under £20
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  const cash = db.prepare(
    `SELECT COUNT(*) n, SUM(-amount_pence) p FROM finance_transactions
      WHERE category = 'Cash withdrawn' AND amount_pence < 0 AND date > ? AND date <= ?`
  ).get(d(28), d(0));

  // NOT_AGENT, imported from the module that owns the column (server/routes/sessions.js,
  // re-exported through stats.js too). This file has its own focus_sessions query and
  // therefore did NOT inherit the filter added across stats.js on 18 Aug — a caller that
  // bypasses a shared fix keeps the bug. Left alone, the morning briefing would have reported
  // 62 hours of Claude's imported sessions as your focus time, in prose, once a day, with
  // nothing to contradict it.
  //
  // THIS WAS ALSO A SECOND, SEPARATE BUG: the property was referenced as `sessions.NOT_CLAUDE`,
  // which was never exported under that name -- the real export is `NOT_AGENT` (confirmed by
  // grepping every occurrence in server/). That mismatch made this line throw "no such column:
  // undefined" on every run, which is what actually broke the 20 Aug 07:00 scheduled briefing.
  const focus = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(duration_minutes), 0) mins
       FROM focus_sessions
      WHERE kind = 'work' AND ${sessions.NOT_AGENT} AND date(completed_at) >= date(?, '-6 days')`
  ).get(TODAY);

  const review = db.prepare(
    `SELECT COUNT(*) c FROM finance_transactions WHERE category_source = 'model' AND reviewed = 0`
  ).get().c;

  // THE BACKLOG, not the retired `tasks` table. It reported 'Open tasks: 1' -- the single
  // demo row 'Call supplier about Q3 order' -- while 40 real items sat open. Same defect as
  // the focus panel had (#M8): a figure sourced from the store nothing uses.
  const openTasks = db.prepare("SELECT COUNT(*) c FROM todo_items WHERE status = 'open'").get().c;

  // Uptime, from the watchdog's own log rather than from a claim.
  let uptime = 'no watchdog log for today';
  const wlog = path.join(ROOT, 'logs', `watchdog-${TODAY}.log`);
  if (fs.existsSync(wlog)) {
    const lines = fs.readFileSync(wlog, 'utf8').trim().split(/\r?\n/);
    const down = lines.filter((l) => l.includes('DOWN')).length;
    uptime = down === 0
      ? `${lines.length} checks, no outages`
      : `${down} outage(s) in ${lines.length} checks`;
  }

  // ---- WORK ACHIEVED -------------------------------------------------------------
  // The briefing was all money. This is the other half: what actually got done.
  //
  // Only dated things can be counted, and the gaps are reported rather than hidden.
  // `tasks.completed_at` was added on 17 Aug, and `todo.decided_at` only exists from the
  // moment an item is decided in this app — the 93 seeded rows carry NULL because the
  // spreadsheet never recorded when a call was made. Both are stated, because a count
  // that silently excludes undated rows understates the first weeks and nothing would
  // ever reveal it.
  const since = new Date(new Date(TODAY) - 7 * 86400000).toISOString().slice(0, 10);
  const sinceStamp = `${since} 00:00:00`;

  const shipped = db.prepare(
    'SELECT module, version, updated_at FROM schema_meta WHERE date(updated_at) >= ? ORDER BY updated_at'
  ).all(since);

  const work = {
    since,
    focusSessions: focus.n,
    focusMinutes: focus.mins,
    // tasksCompleted/tasksDoneButUndated are GONE from 18 Aug, not because they were wrong
    // but because their producer stopped. The Focus panel now lists backlog items instead
    // of the old `tasks` table (#M8), so nothing writes that table any more and both
    // figures would have reported 0 forever — sitting next to a non-zero backlogDecided
    // and reading as "you finished nothing" rather than "this metric is dead".
    //
    // A vocabulary has one owner too: an advertised metric whose producer has stopped is
    // worse than an absent one, because the zero looks like data.
    backlogDecided: todo.decidedSince(sinceStamp),
    chores: lifestyle.activitySince(since),
    daysWritten: wellbeing.daysWrittenSince(since),
    modulesShipped: shipped.map((s) => ({ module: s.module, version: s.version, on: s.updated_at.slice(0, 10) })),
  };

  // Deferrals live in todo_items.recheck_at. Due and not-yet-due are counted separately:
  // "deferred to next month" and "deferred to a date that has passed" are opposite
  // statements and must not be summed into one number.
  const today = new Date().toISOString().slice(0, 10);
  const defRows = db.prepare(
    "SELECT id, title, recheck_at FROM todo_items WHERE status = 'open' AND recheck_at IS NOT NULL ORDER BY recheck_at"
  ).all();
  let handover = null;
  try {
    // Newest handover by filename, which is dated. Absent is reported as absent, never
    // as an empty string that would render the same as "there is no handover".
    const rd = path.join(__dirname, '..', 'handover');
    // Newest by MODIFICATION TIME, not by filename. Sorting names looked right until two
    // handovers shared a date: "handover-2026-08-18-evening.md" sorts BEFORE
    // "handover-2026-08-18.md", because "-" (0x2D) precedes "." (0x2E) — so the newest file
    // sorted first and the briefing named the oldest. A dated filename orders files only for
    // as long as the format never varies, and this one varied the day it was used twice.
    const hs = fs.readdirSync(rd)
      .filter((f) => /^handover-.*\.md$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(rd, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .map((x) => x.f);
    handover = hs.length ? hs[hs.length - 1] : null;
  } catch { handover = null; }
  const deferralsDue = {
    due: defRows.filter((r) => r.recheck_at <= today),
    pending: defRows.filter((r) => r.recheck_at > today),
    handover,
  };

  // Two modules that were never asked. schedule.upcoming() already existed and nothing
  // consumed it; health owns its own reading so the briefing does not recompute one.
  let scheduleDue = null;
  try { scheduleDue = schedule.upcoming(7); } catch (e) { scheduleDue = { error: e.message }; }
  let healthDay = null;
  try { healthDay = health.lastDay(); } catch (e) { healthDay = { error: e.message }; }

  // Four more modules asked rather than reimplemented. Each is wrapped: a briefing that dies
  // because one module threw is worse than a briefing missing one section.
  const ask = (fn) => { try { return fn(); } catch (e) { return { error: e.message }; } };
  const earned = ask(() => income.earnedSince(sinceStamp));
  const moneyGuard = {
    budget: ask(() => budget.breaches()),
    limits: ask(() => safety.limits()),
    authorised: ask(() => safety.authorisedThisMonth()),
  };
  const pressure = ask(() => machine.pressureNow());
  const cashPos = ask(() => finance.netWorth());
  const activity = ask(() => stats.derivedActivity());
  const projectsProgress = ask(() => projects.progressSince(sinceStamp));
  const goalSteps = ask(() => goals.nextSteps());
  const alertsRaised = ask(() => alerts.raisedSince(sinceStamp));
  const sitesDown = ask(() => analytics.notOk());

  return {
    steering,
    steeringError,
    projects: projectsProgress,
    earned,
    moneyGuard,
    pressure,
    cashPos,
    activity,
    goalSteps,
    alertsRaised,
    sitesDown,
    scheduleDue,
    healthDay,
    deferralsDue,
    date: TODAY,
    work,
    // Asked of lifestyle, not derived here. The briefing carries the STANDING state —
    // everything currently owed, including what was missed while this laptop was asleep.
    // The chores_due trigger carries only the single day a chore tips, so the two do not
    // say the same thing twice and neither one nags.
    choresDue: lifestyle.dueSummary(),
    ledger: { first: ledger.a, last: ledger.b, rows: ledger.n, staleDays },
    windowRecent: recent, movers,
    cash28: cash,
    focus7: focus,
    reviewQueue: review,
    openTasks,
    uptime,
  };
}

// --- prose ------------------------------------------------------------------------
// The ONLY thing offloaded. It is handed the finished numbers and asked to introduce
// them; it is told not to add any of its own, and it degrades to nothing if Ollama is
// not running, because a briefing without a sentence is still a briefing.
async function writeProse(facts) {
  const summary = [
    `Ledger covers ${facts.ledger.rows} transactions to ${facts.ledger.last} (${facts.ledger.staleDays} days ago).`,
    `Biggest movers over 28 days: ${facts.movers.map((m) => `${m.category} ${m.delta > 0 ? 'up' : 'down'} ${gbp(m.delta)}`).join(', ') || 'none above £20'}.`,
    `${facts.reviewQueue} transactions awaiting review. ${facts.openTasks} open tasks. Uptime: ${facts.uptime}.`,
  ].join(' ');

  try {
    const res = await fetch(`${HOST}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model: MODEL,
        system: 'You write a two-sentence opening for a personal dashboard briefing. '
          + 'Describe only the SHAPE of the facts given: which things moved, up or down, '
          + 'and what needs attention. '
          + 'NEVER write a quantity, in digits or in words. No numbers, no amounts, no dates, '
          + 'no counts. Say "spending on shopping fell" and never how much. '
          + 'Plain, calm, no greeting, no exclamation marks, no advice.',
        prompt: summary,
        stream: false,
        think: false,
        options: { temperature: 0.2 },
      }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    const text = String(body.response).trim();

    // The guard, not the instruction, is what makes this safe. Asked to repeat "at most
    // two" numbers, it rendered 323 as "Thirty-two three transactions await review" —
    // a wrong figure in a confident sentence, which is the exact failure the
    // no-numbers-from-a-model rule exists to prevent. So: any digit, or any number word,
    // and the sentence is discarded rather than published.
    const NUMBER_WORD = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/i;
    if (/\d/.test(text) || NUMBER_WORD.test(text)) {
      return { text: null, by: null, why: 'the model put a figure in the prose, so it was discarded' };
    }
    return { text, by: 'model' };
  } catch (err) {
    // Absence and failure must look different: say WHICH happened.
    return { text: null, by: null, why: err.message };
  }
}

// --- render -----------------------------------------------------------------------
function render(facts, prose) {
  const L = [];
  L.push(`# Briefing — ${facts.date}\n`);

  if (DRY) {
    L.push('> **Dry run — read-only preview.** Gmail sync, queued work, the CLAUDE.md count stamp, '
      + 'and database access logging were not run. This uses the current stored data, so it may be stale.\n');
  }

  if (prose.text) L.push(`${prose.text}\n`);
  else L.push(`_(No opening line: the local model was unavailable — ${prose.why}. Every number below is unaffected; they are computed in SQL.)_\n`);

  // STEERING LEADS, above everything the briefing merely reports. It is the only block here
  // that asks the owner for something rather than telling him something, and it is the ONLY
  // channel by which any session may interrupt him at all — the manager collects the
  // owner-facing items out of each shift's handovers and puts the ones worth asking here.
  //
  // In the briefing rather than as a notification, deliberately: a steering quiz happens every
  // day, so by definition it is not an event, and a daily alert is one you learn to dismiss.
  // He already reads this file.
  if (facts.steering && facts.steering.length) {
    L.push(`## Steering — ${facts.steering.length} question${facts.steering.length === 1 ? '' : 's'} for you\n`);
    for (const q of facts.steering) {
      L.push(`**${q.question}**\n`);
      if (q.options) {
        for (const o of q.options) {
          const label = typeof o === 'string' ? o : o.label;
          const cost = typeof o === 'string' ? null : o.cost;
          L.push(`- ${label}${cost ? ` — *if this is wrong:* ${cost}` : ''}`);
        }
        L.push('');
      }
      // The recommendation is never omitted. The API refuses a question without one, because a
      // question with no recommendation hands the thinking back, which is the opposite of what
      // the manager role exists to do.
      L.push(`_Recommended: ${q.recommend}_\n`);
    }
    // Points at what EXISTS. The first draft said "answer in the Team panel", and there is no
    // Team panel — a briefing that sends you to a screen nobody built is worse than one that
    // gives you a command, because you spend the time looking before you doubt the sentence.
    L.push('_Answer by telling the Team Manager session, or:_ `node tools/steering-answer.cjs <id> "<answer>"`\n');
  } else if (facts.steeringError) {
    // Could-not-look, not nothing-to-ask. An empty steering block on a broken read would say
    // "no decisions needed today" on a day several were waiting.
    L.push(`## Steering\n\n_Could not read the steering queue — ${facts.steeringError}. That is not "no questions"._\n`);
  }

  // Work first. The item this section exists for asked for reports that show what was
  // achieved, not just money — so it leads, rather than being appended under the spending.
  const w = facts.work;
  L.push(`## What got done, ${w.since} to ${facts.date}\n`);

  const did = [];
  if (w.focusSessions) did.push(`**${w.focusSessions}** focus session${w.focusSessions === 1 ? '' : 's'}, ${w.focusMinutes} minutes`);
  const decided = (w.backlogDecided.byStatus || []).reduce((s, r) => s + r.c, 0);
  if (decided) did.push(`**${decided}** backlog item${decided === 1 ? '' : 's'} decided (${w.backlogDecided.byStatus.map((r) => `${r.c} ${r.status}`).join(', ')})`);
  if (w.chores.choresRecorded) did.push(`**${w.chores.choresRecorded}** chore${w.chores.choresRecorded === 1 ? '' : 's'} recorded`);
  if (w.daysWritten) did.push(`wrote something on **${w.daysWritten}** day${w.daysWritten === 1 ? '' : 's'}`);
  if (w.modulesShipped.length) did.push(`**${w.modulesShipped.length}** module${w.modulesShipped.length === 1 ? '' : 's'} shipped: ${w.modulesShipped.map((m) => m.module).join(', ')}`);

  if (did.length) did.forEach((d) => L.push(`- ${d}`));
  else L.push('- Nothing recorded in the last 7 days. That is what the data says, not a judgement.');
  L.push('');

  // What this section CANNOT see. Without it the counts above read as complete.
  const blind = [];
  if (w.backlogDecided.undated) blind.push(`${w.backlogDecided.undated} backlog item(s) were already done or declined when imported, with no date recorded — they are real work that this count cannot show`);
  if (blind.length) L.push(`_Not counted above: ${blind.join('; ')}._\n`);

  // Due today. Forward-looking and actionable, so it sits above the money.
  // Deferrals that have come due, and the latest handover. Both answer "what did a
  // past session decide that I am supposed to look at again", which is invisible
  // otherwise: a decision recorded in a note resurfaces only if somebody reads it.
  const dd = facts.deferralsDue;
  if (dd && (dd.due.length || dd.handover)) {
    L.push('## Picked up from a past session\n');
    for (const it of dd.due) {
      L.push(`- **${it.id}** is due for re-check today (deferred ${it.recheck_at}) — ${it.title}`);
    }
    if (dd.pending.length) {
      L.push(`- ${dd.pending.length} other deferral(s) not yet due, next ${dd.pending[0].recheck_at}.`);
    }
    if (dd.handover) {
      L.push(`- Latest handover: \`handover/${dd.handover}\``);
    }
    L.push('');
  }

  const c = facts.choresDue;
  if (c && c.total) {
    // The diary, from the schedule module. Overdue is listed before upcoming because an
    // appointment that has already slipped is the only one you can still do something about
    // today. Rendered only when there is something in it -- an empty heading every morning
    // is how a reader learns to skip the section.
    const sd = facts.scheduleDue;
    if (sd && !sd.error && (sd.overdue.length || sd.upcoming.length)) {
    // PROJECTS. Owner request: the briefing should cover all of them, not just this one.
    //
    // Progress is commits, which is a deliberate narrowing: a commit is a fact with a
    // timestamp that nobody has to remember to record. A percent-complete or an "on track"
    // would be a weighting I chose, presented back as a measurement.
    const pr = facts.projects;
    if (pr && !pr.error) {
      L.push('## Projects\n');
      if (pr.moved.length) {
        for (const m of pr.moved) {
          L.push(`- **${m.name}** (${m.track}) — ${m.commits} commit${m.commits === 1 ? '' : 's'}`
            + (m.uncommitted ? `, ${m.uncommitted} uncommitted` : '')
            + (m.lastSubject ? `\n  _${m.lastSubject}_` : ''));
        }
      } else {
        L.push('- Nothing committed anywhere today.');
      }
      if (pr.quiet.length) {
        L.push(`- Quiet: ${pr.quiet.map((q) => `${q.name} (last ${q.lastAt || 'unknown'})`).join(', ')}`);
      }
      // Never folded into "no progress". A project with no repository and a project nobody
      // touched are indistinguishable by commit count, and calling both zero libels the first.
      if (pr.unmeasurable.length) {
        L.push(`- Not measurable here — no version control, so work on them is invisible rather`
          + ` than absent: ${pr.unmeasurable.map((u) => u.name).join(', ')}`);
      }
      L.push('');
    }

    // WHEN you were actually at it, not just what got done. stats.derivedActivity() clusters
    // the rows YOU wrote -- by_whom = 'you', across five tables -- into stretches separated by a
    // 45-minute gap. It needs no input and no timer: it is derived from work already recorded,
    // which is why it can report honestly on a day nobody remembered to start anything.
    //
    // Printed only when there are stretches. A "0 stretches" line every morning would be a
    // daily reminder that a measurement exists, which is not the same as information.
    const act = facts.activity;
    if (act && !act.error && act.stretches && act.stretches.length) {
      const total = act.stretches.reduce((a, s) => a + (s.spanMinutes || 0), 0);
      L.push('## When you were at it\n');
      L.push(`- ${act.stretches.length} stretch(es) over the last ${act.days} days, ${total} minute(s) in total`);
      for (const s of act.stretches.slice(-4)) {
        const from = String(s.start).slice(5, 16).replace('T', ' ');
        L.push(`  - ${from} — ${s.actions} action(s) over ${s.spanMinutes} min`);
      }
      // The basis matters more than the number: this counts writes, so thinking, reading and
      // anything done outside this dashboard is invisible to it.
      if (act.basis) L.push(`- ${act.basis}`);
      L.push('- It sees writes only, so reading, thinking and work done elsewhere leave no trace here.');
      L.push('');
    }
      L.push('## Diary\n');
      for (const e of sd.overdue) {
        L.push(`- **OVERDUE** ${e.title}${e.day ? ` — was ${e.day}` : ''}`);
      }
      for (const e of sd.upcoming) {
        const when = e.day === sd.today ? '**today**' : e.day;
        L.push(`- ${when} — ${e.title}${e.location ? ` (${e.location})` : ''}`);
      }
      L.push('');
    } else if (sd && sd.error) {
      // Could not look is not the same as nothing on. Say which.
      L.push('## Diary\n');
      L.push(`- The schedule could not be read: ${sd.error}`);
      L.push('');
    }

    // Yesterday's body, from the health module. Two things it must never do: present a stale
    // reading as current, and report an unworn watch as a sedentary day.
    const hd = facts.healthDay;
    if (hd && !hd.error && hd.date) {
      const bits = [];
      if (hd.steps != null) bits.push(`${hd.steps.toLocaleString('en-GB')} steps`);
      if (hd.sleepMinutes != null) {
        bits.push(`${Math.floor(hd.sleepMinutes / 60)}h ${hd.sleepMinutes % 60}m asleep`);
      }
      if (bits.length) {
        const stale = hd.ageDays > 1 ? ` — but that is ${hd.ageDays} days old` : '';
        L.push(`## Body\n`);
        L.push(`- ${hd.date}: ${bits.join(', ')}${stale}`);
        if (hd.note) L.push(`- ${hd.note}`);
        L.push('');
      }
    }

    // MONEY. The budget owns headroom and safety owns the limits; this only arranges them.
    // coverageComplete is printed whenever it is false, because headroom computed over an
    // incomplete budget is not "what is left to spend" and presenting it as such is how a
    // number nobody can audit gets believed.
    const mg = facts.moneyGuard;
    if (mg && mg.budget && !mg.budget.error) {
      const b = mg.budget;
      const over = (b.over || []).length;
      if (over || b.headroomPence != null) {
        L.push('## Money left\n');
        if (b.headroomPence != null) {
          L.push(`- ${gbp(b.headroomPence)} headroom for ${b.month}`
            + (b.coverageComplete === false
              ? ' — but the budget does not cover every category yet, so this is a ceiling rather than a balance'
              : ''));
        }
        for (const o of (b.over || []).slice(0, 4)) {
          L.push(`- over on **${o.category}**`);
        }
        const lim = mg.limits && !mg.limits.error ? mg.limits : null;
        if (lim && lim.per_transaction_pence) {
          const auth = mg.authorised && !mg.authorised.error ? mg.authorised : null;
          L.push(`- spending guard: ${gbp(lim.per_transaction_pence.pence)} per transaction`
            + (auth ? `, ${auth.n} authorised this month` : ''));
      // WHAT IS ACTUALLY IN THE ACCOUNT, printed beside the headroom rather than instead of it.
      //
      // These two numbers answer different questions and only one of them was ever on screen.
      // Headroom is budget minus spend; it says what the PLAN allows. Cash is the ledger's last
      // known balance; it says what is THERE. On 18 Aug the briefing read "£191.52 headroom"
      // every morning while the last recorded balance was three pence -- both correct, and
      // reading only the first would have been badly misleading two days after committing £40
      // to advertising.
      //
      // THE STALENESS IS PART OF THE FIGURE, never a footnote. The ledger is an import: a
      // balance eight days old is a fact about 11 August, not about today, and money may well
      // have arrived since. Printing it without the age would replace one misleading number
      // with another.
      const cashPos = facts.cashPos;
      if (cashPos && !cashPos.error && cashPos.cash && cashPos.cash.length) {
        const total = cashPos.cash.reduce((a, c) => a + c.pence, 0);
        const oldest = Math.max(...cashPos.cash.map((c) => c.staleDays || 0));
        L.push(`- last known balance **${gbp(total)}** across ${cashPos.cash.length} account(s)`
          + `, ${oldest} day(s) old — the ledger is an import, so today's real figure may differ`);
        for (const c of cashPos.cash) {
          L.push(`  - ${c.label}: ${gbp(c.pence)} as of ${c.asOf}`);
        }
        if (cashPos.caveat) L.push(`- ${cashPos.caveat}`);
      }
        }
        L.push('');
      }
    }

    // INCOME. Silent while it is zero, on purpose: a line reading £0 every morning for months
    // is one the reader stops seeing, and then the morning it finally says £4.20 they skip it
    // too. The FIRST entry ever is called out separately, because it is the single most
    // important thing this dashboard can report and otherwise looks like any other Tuesday.
    const inc = facts.earned;
    if (inc && !inc.error && inc.periodPence > 0) {
      L.push('## Income\n');
      if (inc.firstEver) {
        L.push(`- **THE FIRST INCOME THIS PORTFOLIO HAS EVER RECORDED: ${gbp(inc.periodPence)}.**`);
      } else {
        L.push(`- ${gbp(inc.periodPence)} since ${inc.since}, ${gbp(inc.everPence)} all time`);
      }
      for (const s of (inc.byStream || []).slice(0, 5)) {
        L.push(`- ${s.label}: ${gbp(s.p)}`);
      }
      L.push('');
    }

    // THE MACHINE, and only when it is actually tight. The thresholds are stated here rather
    // than hidden in the module: 90% of memory, or under 20 GB free. They are a choice, so
    // the raw figures are printed beside them and you can disagree with the line, not the data.
    const pr = facts.pressure;
    if (pr && !pr.error) {
      const memTight = pr.memory && pr.memory.usedPct != null && pr.memory.usedPct >= 90;
      const diskTight = pr.disk && pr.disk.available && pr.disk.freeGB < 20;
      if (memTight || diskTight) {
        L.push('## The machine is tight\n');
        if (memTight) L.push(`- memory ${pr.memory.usedPct}% used (${pr.memory.usedMB} of ${pr.memory.totalMB} MB), threshold 90%`);
        if (diskTight) L.push(`- disk ${pr.disk.freeGB} GB free of ${pr.disk.totalGB}, threshold 20 GB`);
        L.push('');
      }
    }

    // GOALS, as the next physical action rather than a percentage. A progress bar tells you
    // where you are; it does not tell you what to do, and a goal without its next step is a
    // wish. A step blocked by another is shown as blocked rather than offered, because an
    // impossible action is worse than none.
    const gs = facts.goalSteps;
    if (gs && !gs.error && gs.state === 'ok' && gs.goals.length) {
      L.push('## Goals — the next step\n');
      for (const g of gs.goals) {
        if (!g.next) { L.push(`- ${g.title}: every step done (${g.done}/${g.of})`); continue; }
        const cost = g.costPence ? ` — ${gbp(g.costPence)}` : '';
        const blocked = g.blocked ? ' **(blocked)**' : '';
        L.push(`- ${g.title} (${g.done}/${g.of}): ${g.next}${cost}${blocked}`);
      }
      L.push('');
    }

    // ALERTS. Reported as RAISED rather than "active", because this module has no notion of
    // an alert being resolved and inventing one here would be a second disagreeing definition.
    // The unjudged count leads, since the module mutes a kind that gets ignored enough times:
    // an unjudged alert is one still spending attention without having earned its place.
    const ar = facts.alertsRaised;
    if (ar && !ar.error && ar.state === 'ok' && ar.raised > 0) {
      L.push('## Alerts raised\n');
      for (const k of ar.kinds) {
        L.push(`- ${k.kind}: ${k.n}` + (Number(k.unjudged) ? `, ${k.unjudged} not yet judged` : ', all judged'));
      }
      L.push('');
    }

    // THE PUBLISHED SITES, and only when one is not answering. A green line every morning is
    // a line nobody reads, and the value here is entirely in the exception. It reports the
    // last PROBE rather than testing the site now: the briefing runs at a fixed hour and a
    // site that recovered an hour ago is not news, whereas one that has been down since the
    // last probe is.
    const sd2 = facts.sitesDown;
    if (sd2 && !sd2.error && sd2.down && sd2.down.length) {
      L.push('## A published site is not answering\n');
      for (const s of sd2.down) {
        L.push(`- **${s.name}** — ${s.detail} (last checked ${s.at})`);
      }
      L.push('');
    }

    L.push('## Due today\n');
    if (c.due.length) {
      for (const ch of c.due) {
        // Say how late, rather than lumping "due" and "three days late" into one word.
        const late = ch.dueInDays < 0 ? ` — ${-ch.dueInDays} day${ch.dueInDays === -1 ? '' : 's'} late` : '';
        L.push(`- **${ch.name}**${late}`);
      }
    } else {
      L.push('- Nothing due.');
    }
    // Absence, kept separate from "not due" — a chore with no history has no date to
    // count an interval from, so calling it either would be inventing one.
    if (c.neverDone.length) {
      const names = c.neverDone.map((x) => x.name).join(', ');
      const verb = c.neverDone.length === 1 ? 'has' : 'have';
      L.push('');
      L.push(`_${c.neverDone.length} chore${c.neverDone.length === 1 ? '' : 's'} ${verb} never been recorded `
        + `(${names}), so nothing here knows when they were last done. That is not the same `
        + 'as being up to date._');
    }
    L.push('');
  }

  L.push('## Ledger\n');
  if (facts.ledger.staleDays > 40) {
    L.push(`**The ledger has not been updated in ${facts.ledger.staleDays} days.** It ends at`);
    L.push(`${facts.ledger.last}. Everything below describes that period, not this week —`);
    L.push('there is no live bank feed, and an empty recent window would mean "not imported",');
    L.push('not "nothing spent".\n');
  } else {
    L.push(`${facts.ledger.rows} transactions, ${facts.ledger.first} to ${facts.ledger.last} (${facts.ledger.staleDays} days old).\n`);
  }

  L.push('## Spending, last 28 ledger days vs the 28 before\n');
  L.push('Own transfers and cash excluded — the first would double-count, the second is unattributable.\n');
  if (!facts.movers.length) {
    L.push('No category moved by more than £20.\n');
  } else {
    L.push('| Category | 28 days | Previous 28 | Change |');
    L.push('|---|---|---|---|');
    facts.movers.forEach((m) => L.push(
      `| ${m.category} | ${gbp(m.now)} | ${gbp(m.was)} | ${m.delta > 0 ? '+' : '−'}${gbp(m.delta)} |`));
    L.push('');
  }

  L.push(`Cash withdrawn in the same window: **${gbp(facts.cash28.p || 0)}** across ${facts.cash28.n} withdrawals.`);
  L.push('That money left the account and the ledger cannot say what it bought.\n');

  L.push('## Mission Control\n');
  L.push(`- Focus, last 7 days: **${facts.focus7.n} sessions**, ${facts.focus7.mins} minutes`);
  L.push(`- Open tasks: **${facts.openTasks}**`);
  L.push(`- Transactions awaiting review: **${facts.reviewQueue}**`);
  L.push(`- Uptime today: ${facts.uptime}\n`);

  L.push('---');
  L.push(`_Generated ${new Date().toISOString()}. Numbers from SQL; prose ${prose.by || 'omitted'}._`);
  return L.join('\n');
}


// Pull new mail as part of the ONE daily pass, rather than adding a sixth scheduled task.
// Five already exist and every one added is another thing that can silently stop.
//
// Run as a CHILD PROCESS, not require()d: tools/import-gmail.cjs is both a CLI and a
// library, so requiring it executes the CLI. And it is wrapped so that no mail failure can
// take the briefing down -- an expired token must cost you the mail figures, never the
// morning report. A failure is LOGGED rather than swallowed, because a sync that silently
// stopped and a mailbox with no new mail produce the same row count.

// M43: drain the local-tier work queue as part of the daily pass. Wrapped so a model
// failure costs the queue and never the briefing, and bounded so a big queue cannot make
// the morning report take all night. Items write their own results, so a kill leaves every
// finished item finished.

// M57: the counted claims in CLAUDE.md regenerate on the daily pass rather than rotting.
// Measured 18 Aug, every figure in both files was wrong within a day of being written, and
// the schema list had regressed to a failure it documents in its own text. Synchronous and
// wrapped: a documentation stamp must never be able to fail a morning report.
function stampDocs() {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'stamp-claude-md.cjs')],
      { encoding: 'utf8', timeout: 20000 });
    const nl = String.fromCharCode(10);   // a regex literal here does not survive patching
    const moved = out.split(nl).filter((l) => l.indexOf('rewritten') >= 0);
    if (moved.length) console.log(`docs: ${moved.length} CLAUDE.md count block(s) regenerated`);
  } catch (err) { console.log(`docs: stamp FAILED -- ${String(err.message).slice(0, 100)}`); }
}
async function runWork() {
  try {
    const work = require('../server/routes/work');
    const r = await work.runQueued({ limit: 5 });
    if (r.attempted) {
      console.log(r.unreachable
        ? `work: Ollama unreachable, ${r.attempted} item(s) left QUEUED rather than failed`
        : `work: ${r.done} done, ${r.failed} failed of ${r.attempted}`);
    }
  } catch (err) { console.log(`work: FAILED -- ${String(err.message).slice(0, 120)}`); }
}
async function syncGmail() {
  const { execFile } = require('node:child_process');
  const script = path.join(ROOT, 'tools', 'import-gmail.cjs');
  if (!fs.existsSync(script)) { console.log('gmail: importer absent, skipped'); return; }
  await new Promise((resolve) => {
    execFile(process.execPath, [script, '--max', '1500'], { timeout: 240000, cwd: ROOT },
      (err, stdout, stderr) => {
        const nl = String.fromCharCode(10);
        const tail = String(stdout || '').trim().split(nl).filter((l) => l.indexOf('new,') >= 0);
        if (err) console.log(`gmail: FAILED -- ${String(err.message).slice(0, 120)}`);
        else if (tail.length) tail.forEach((l) => console.log(`gmail: ${l.trim()}`));
        else console.log(`gmail: ran but reported nothing -- ${String(stderr || '').slice(0, 100)}`);
        resolve();
      });
  });
}
async function main() {
  const writesAtStart = DRY ? db.prepare('SELECT total_changes() AS n').get().n : null;
  if (DRY) {
    console.log('dry-run: Gmail sync, queued work, CLAUDE.md stamp and database access logging skipped; preview uses stored data and may be stale');
  } else {
    await syncGmail();
    await runWork();
    stampDocs(); // Run before gatherFacts so the normal daily pass includes its fresh data.
  }
  const facts = gatherFacts();
  const prose = await writeProse(facts);
  const md = render(facts, prose);

  if (DRY) {
    const writes = db.prepare('SELECT total_changes() AS n').get().n - writesAtStart;
    if (writes !== 0) {
      console.error(`dry-run: REFUSED to claim read-only; this process made ${writes} SQLite write(s)`);
      process.exitCode = 1;
      return;
    }
    console.log(md);
    return;
  }

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${facts.date}.md`), md);

  db.prepare(
    `INSERT INTO briefings (date, markdown, facts, prose_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET markdown = excluded.markdown, facts = excluded.facts,
       prose_by = excluded.prose_by, created_at = datetime('now', 'localtime')`
  ).run(facts.date, md, JSON.stringify(facts), prose.by);


  // Honeygain, once a day, on the pass that already runs. No sixth scheduled task: five live
  // services already depend on Task Scheduler and each one added is another thing that can
  // stop silently.
  //
  // WRAPPED, and the wrapping matters more than the fetch. An expired token, a changed API or
  // no network must leave the briefing successful and only this line absent. fetch-honeygain
  // exits 2 on every "could not look" path and records NOTHING in those cases, so a bad day
  // cannot write a run of zero earnings into the balance series.
  try {
    const out = require('node:child_process').execFileSync(
      process.execPath,
      [require('node:path').join(__dirname, '..', 'tools', 'fetch-honeygain.cjs'), '--record'],
      { encoding: 'utf8', timeout: 60000 },
    );
    const snap = (out.match(/balance snapshot recorded for [\d-]+: \$[\d.]+/) || [])[0];
    const rate = (out.match(/earning rate: [^\n]+/) || [])[0];
    console.log(`honeygain: ${snap || 'no balance read'}${rate ? ` | ${rate}` : ''}`);
  } catch (e) {
    // Exit 2 is "could not look" and is expected whenever the token lapses.
    console.log('honeygain: could not read today (token expired, or the API moved) - nothing recorded');
  }

  console.log(`wrote reports/${facts.date}.md  (${md.length} bytes, prose ${prose.by || 'omitted'})`);

  // A document to accompany the markdown. Owner request, 18 Aug 2026: the briefing should
  // produce something you can open, print and file, not only something a terminal renders.
  //
  // WRAPPED, because a formatting step must never be able to fail the morning report. The
  // markdown and the database row are already written by this point; if LibreOffice is busy
  // or missing, the briefing still succeeded and says so, and only the PDF is absent.
  try {
    require('node:child_process').execFileSync(
      process.execPath,
      [require('node:path').join(__dirname, '..', 'tools', 'briefing-doc.cjs'), facts.date],
      { stdio: 'pipe', timeout: 180000 },
    );
    console.log(`wrote reports/briefing-${facts.date}.pdf`);
  } catch (e) {
    console.log(`PDF not produced: ${String(e.message).split('\n')[0].slice(0, 90)}`);
  }


  // One notification a day, and it is the delivery mechanism for the whole feature — a
  // briefing you have to remember to go and read is a chore with a nice font. If it gets
  // dismissed unread twice, delete it rather than tuning it.
  if (args.includes('--notify')) {
    const raise = require('./notify.cjs');
    const headline = facts.movers.length
      ? `${facts.movers[0].category} ${facts.movers[0].delta > 0 ? 'up' : 'down'} ${gbp(facts.movers[0].delta)} over 28 days`
      : 'no category moved by more than £20';
    const r = raise('briefing', 'Briefing ready', `${headline}. ${facts.reviewQueue} awaiting review.`);
    if (r.suppressed) console.log('briefing notification suppressed — you muted this kind');
    else if (!r.delivered) console.error(`notification failed: ${r.error || 'unknown'}`);

    // The daily triggers ride along here rather than on their own scheduled task: one
    // notification pass a day, and nothing else for Task Scheduler to lose. Each has its
    // own alert kind, so muting "briefing" does not mute an overdue appointment and vice
    // versa — the two-ignores rule is per kind, which is the whole point of having kinds.
    const triggers = require('./triggers.cjs').run({ notify: true });
    for (const t of triggers) {
      if (t.state === 'error') console.error(`trigger ${t.kind} could not run: ${t.error}`);
      else if (t.state === 'fires') console.log(`trigger ${t.kind}: ${t.suppressed ? 'suppressed (muted)' : t.delivered ? 'sent' : `failed: ${t.error || 'unknown'}`}`);
    }
    const fired = triggers.filter((t) => t.state === 'fires').length;
    console.log(`triggers: ${triggers.length} checked, ${fired} fired`);
  }

  // TELEMETRY RIDES ALONG TOO, for the same reason the triggers do: no sixth scheduled
  // task. Five already exist and each one is another thing that can silently stop.
  //
  // Measured before wiring rather than assumed: a full parse of 288 MB of transcripts is
  // ~2.0s against this briefing's ~18.7s, so it costs about 11% of a job that already runs
  // unattended once a day.
  //
  // Until 18 Aug this data came from GarageTelemetryHourly, which runs Oxford AutoWorks'
  // telemetry.ps1 with Oxford as its working directory. That task is Oxford's business and
  // is left alone; it simply no longer feeds anything here.
  //
  // WRAPPED SO IT CANNOT TAKE THE BRIEFING DOWN. The briefing is the thing you read at 07:00;
  // a metrics refresh failing must never cost you that. It reports the failure and continues.
  if (!DRY) {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('node', [path.join(ROOT, 'tools', 'telemetry.cjs')], { stdio: ['ignore', 'ignore', 'pipe'] });
      console.log('telemetry: refreshed');
    } catch (err) {
      console.error(`telemetry refresh failed (briefing is unaffected): ${String(err.message).slice(0, 120)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
