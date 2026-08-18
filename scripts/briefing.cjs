// The morning briefing. Every number is computed in SQL; the model, if it is running,
// only writes the sentence that introduces them.
//
//   node scripts/briefing.cjs           generate for today, write to reports/ and the DB
//   node scripts/briefing.cjs --dry     print it, write nothing
//   node scripts/briefing.cjs --date 2026-08-12
//
// Descends from income-portfolio/scripts/daily-briefing.mjs and keeps its two best ideas:
// narrative inputs go stale and must expire, and zero is reported as zero rather than
// dressed up. It is a separate program because that one runs in GitHub Actions where this
// SQLite database does not exist — a known divergence with a reason, not an oversight.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db');
require('../server/routes/finance');
require('../server/routes/briefing');

// Asked, not read. Each module publishes what the briefing needs; none of their tables are
// touched here, so a figure cannot end up with two owners that quietly disagree.
const tasks = require('../server/routes/tasks');
const todo = require('../server/routes/todo');
const sessions = require('../server/routes/sessions');
const lifestyle = require('../server/routes/lifestyle');
const wellbeing = require('../server/routes/wellbeing');

const ROOT = path.join(__dirname, '..');
const HOST = 'http://127.0.0.1:11434';
const MODEL = process.env.PROBE_MODEL || 'qwen3.5:9b';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const dateIdx = args.indexOf('--date');
const TODAY = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().slice(0, 10);

const gbp = (p) => `£${(Math.abs(p) / 100).toFixed(2)}`;

// --- facts ------------------------------------------------------------------------
// Everything below is SQL. A model is never asked to compute, compare or total anything:
// a plausible number is worse than no number, because you cannot tell it is wrong.
function gatherFacts() {
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

  // NOT_CLAUDE, imported from the module that owns the column. This file has its own
  // focus_sessions query and therefore did NOT inherit the filter added across stats.js on
  // 18 Aug — a caller that bypasses a shared fix keeps the bug. Left alone, the morning
  // briefing would have reported 62 hours of Claude's imported sessions as your focus time,
  // in prose, once a day, with nothing to contradict it.
  const focus = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(duration_minutes), 0) mins
       FROM focus_sessions
      WHERE kind = 'work' AND ${sessions.NOT_CLAUDE} AND date(completed_at) >= date(?, '-6 days')`
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

  return {
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

  if (prose.text) L.push(`${prose.text}\n`);
  else L.push(`_(No opening line: the local model was unavailable — ${prose.why}. Every number below is unaffected; they are computed in SQL.)_\n`);

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
  const c = facts.choresDue;
  if (c && c.total) {
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
  await syncGmail();
  await runWork();
  stampDocs();               // M57: regenerate the counted blocks in CLAUDE.md            // M43: the queue runs on the same one pass, not a task of its own          // before gatherFacts, so today's figures include today's mail
  const facts = gatherFacts();
  const prose = await writeProse(facts);
  const md = render(facts, prose);

  if (DRY) { console.log(md); return; }

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${facts.date}.md`), md);

  db.prepare(
    `INSERT INTO briefings (date, markdown, facts, prose_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET markdown = excluded.markdown, facts = excluded.facts,
       prose_by = excluded.prose_by, created_at = datetime('now', 'localtime')`
  ).run(facts.date, md, JSON.stringify(facts), prose.by);

  console.log(`wrote reports/${facts.date}.md  (${md.length} bytes, prose ${prose.by || 'omitted'})`);

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
