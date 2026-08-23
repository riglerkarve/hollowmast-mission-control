#!/usr/bin/env node
'use strict';
//
// table-census.cjs — for every table: how many rows, who reads it, who writes it,
// and which of the five reasons an empty one is empty.
//
// WHY THIS EXISTS
//
// On 23 Aug 2026 two sessions argued for a day about which of Mission Control's
// 19 empty tables were dead. Both of us held the rule that a row count cannot
// justify deleting anything. Both of us then agreed on exactly one deletion --
// `browsing_news_*` -- on exactly a row count, and neither checked whether
// anything read them. They had a panel, a route, an importer and a test. The
// deletion was filed and withdrawn one message before it happened.
//
// The lesson is not "check readers". It is that AGREEMENT IS WHERE THE CHECK
// GETS SKIPPED: we had just finished arguing, so the one thing we concurred on
// was the one thing neither of us examined. A tool does not get tired of
// agreeing with itself, which is the only reason to write this down rather than
// remember it.
//
// AN EMPTY TABLE HAS AT LEAST FIVE CAUSES AND THEY NEED OPPOSITE RESPONSES.
// A row count distinguishes none of them:
//
//   NEVER NEEDED         gate_attempts 0 -- nobody was ever locked out. GOOD NEWS.
//   NO WRITE PATH        team_arbitrations -- schema exists, no INSERT anywhere.
//   WRONG SHAPE          lifestyle_intake 0 beside foods 25 / chores 16 in the
//                        SAME module: the recurring half of a live feature.
//   BUILT, TESTED, NEVER RUN   browsing_news_* -- complete CRUD, a test asserts
//                        on it, no row has ever arrived.
//   GENUINELY UNWANTED   no confirmed member. That is the finding.
//
// USAGE
//   node tools/table-census.cjs                 every table
//   node tools/table-census.cjs --empty         only tables with 0 rows
//   node tools/table-census.cjs browsing_news   tables matching a substring
//   node tools/table-census.cjs --self-test     controls only, then exit
//
// IT REFUSES TO REPORT IF ITS OWN CONTROLS FAIL. A census whose pattern matches
// nothing returns "no readers" for everything, which reads as a spectacular
// finding and is a broken grep. That exact failure happened twice on 23 Aug --
// once a heredoc ate a backslash, once a regex required a leading slash on a
// path that is sometimes relative. Both printed a clean, confident, wrong sweep.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'reports', 'backups']);
const EXT = /\.(js|cjs|mjs|ts|ps1|py|html|sql)$/i;

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    // EXCLUDE THIS FILE. The comments above name half a dozen tables as
    // examples, so without this the census counts itself as a reader of every
    // table it discusses -- and it did: the first run reported
    // `team_arbitrations` as having a reader, which was this file's own header.
    // An instrument that appears in its own measurement is the shape it exists
    // to catch, one level up.
    else if (EXT.test(e.name) && p !== __filename) out.push(p);
  }
  return out;
}

// A reference is SCHEMA if it only creates or alters the table. Those do not
// keep a table alive -- they are what makes an unused table look used.
const SCHEMA_RE = /CREATE\s+(TABLE|INDEX|UNIQUE)|ALTER\s+TABLE|DROP\s+TABLE|addColumn/i;
const WRITE_RE = /\bINSERT\s+(OR\s+\w+\s+)?INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b/i;

// ONLY AN INSERT CAN PRODUCE A ROW, and conflating it with UPDATE produced the
// second false diagnosis this column caused before it shipped.
//
// work_items: 0 rows, and a scheduled writer — briefing.cjs:755 calls
// work.runQueued() daily, which is NOT in a request handler, so it survived the
// scope test correctly. The taxonomy then announced "a scheduled writer runs and
// produces nothing — this one is broken."
//
// It is not broken. runQueued only UPDATEs (`SET status='running'`) and returns
// early when the queue is empty; the sole INSERT is at work.js:97 inside
// router.post('/items'). So work_items is a SCHEDULED CONSUMER with a
// REQUEST-DRIVEN PRODUCER, and 0 rows means nobody has queued anything through
// the API — entirely correct.
//
// A scheduled UPDATE against an empty table is a no-op by construction and is
// evidence of nothing. Control 5 pins this.
const INSERT_RE = /\bINSERT\s+(OR\s+\w+\s+)?INTO\b/i;

// A READER IS NOT EVIDENCE OF DEMAND, AND THIS DISTINCTION COST A WRONG
// CONCLUSION THE HOUR THIS TOOL SHIPPED.
//
// The census reported `team_arbitrations` as having readers, and I wrote "so
// something already expects rows there -- build the route". The reader was
// `tools/verify-liveness-rule.cjs:291`:
//
//     add('8e', 'team_arbitrations (the only true orphan)', 0,
//         () => n('SELECT count(*) c FROM team_arbitrations'), false,
//         'the one table the report says is safe to delete');
//
// The `0` is the EXPECTED value. That reader asserts the table is EMPTY and its
// own note calls it safe to delete -- the exact opposite of expecting rows. The
// count was right; the meaning I attached to it was inverted.
//
// So a reader inside a checker may be asserting ABSENCE. This tool cannot parse
// intent and does not try: it flags such readers separately and prints the line,
// because the fix for "good at counting, unreliable at what the count means" is
// to make the reader look, not to guess better.
const ASSERT_FILE_RE = /(^|\/)(tools|scripts)\/[^/]*(verify|check|test|audit|census|probe)[^/]*\.(c?js|mjs|ps1)$/i;

function scan(files, table) {
  const refs = [];
  // Word-boundary either side so `browsing_news_topics` never matches
  // `browsing_news_topics_v2`, and a substring of a longer name never counts.
  const re = new RegExp('(?<![A-Za-z0-9_])' + table + '(?![A-Za-z0-9_])');
  for (const f of files) {
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!s.includes(table)) continue;
    s.split(/\r?\n/).forEach((line, i) => {
      if (!re.test(line)) return;
      refs.push({
        file: path.relative(ROOT, f).replace(/\\/g, '/'),
        line: i + 1,
        schema: SCHEMA_RE.test(line),
        write: WRITE_RE.test(line),
        insert: INSERT_RE.test(line),
        text: line.trim().slice(0, 120),
      });
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// THE SCHEDULED-WRITER COLUMN (M341)
//
// "Does anything other than a human write here on a schedule?" was the best
// predictor a day of arguing produced, and nothing could answer it, because the
// schedules live in Windows Task Scheduler -- outside this tree entirely.
//
// THE HONEYGAIN CHAIN IS FOUR HOPS AND EACH DEFEATS A DIFFERENT CENSUS:
//
//   1  MissionControl-Briefing         Task Scheduler, outside the repo
//   2  scripts/briefing.cjs:823        execFileSync(...) -- a child process, so a
//                                      require-graph walk stops here
//   3  tools/fetch-honeygain.cjs:145   require() INSIDE A FUNCTION BODY, so a
//                                      top-level import census stops here
//   4  server/routes/income.js:688     the INSERT is in a ROUTE MODULE
//
// Hop 4 is the one that beats a careful implementation. `grep "INTO
// income_balances"` returns exactly one hit and it is in a route, so a census
// keyed on "which routes write which tables" does not merely miss the scheduled
// writer -- it attributes income_balances to the HTTP layer and reports
// MissionControl-Briefing as writing nothing. A clean-looking wrong answer.
//
// THREE CLASSES, NOT TWO, AND CONFLATING THEM MARKS EVERY TABLE SCHEDULED.
// MissionControl-Server runs server/index.js, which requires every route, so
// treating it like a batch job puts all 86 tables in the closure -- a
// spectacular finding and completely wrong. But the server is not inert either:
// analytics.js:135 runs probeAll() on a setInterval and analytics_probes has 834
// rows. So:
//
//   task     a scheduled task runs a script whose closure writes the table
//   timer    the long-running server writes it from a module-level setInterval
//   (blank)  written only when something calls it -- a human, or a session
//
// Both task and timer answer the question with "yes". Only blank means "a person
// has to act". The Server task is deliberately NOT expanded as a task closure;
// it contributes timer attributions only.
//
// WHAT THIS DOES NOT DO, stated because the gap is load-bearing: timer
// attribution is FILE-level. If a file contains a module-level setInterval, the
// tables that file writes are marked timer -- it does not prove the timer's
// callback reaches that particular INSERT. The setInterval line is printed so
// the reader can judge, which is this tool's own rule about printing the line
// rather than a count. A tighter version needs call-graph reachability inside a
// module and would be inventing precision it cannot check.
// REACHABLE-BY-REQUIRE IS NOT WRITTEN-ON-A-SCHEDULE, and the first version of
// this column got that wrong in the flattering direction: it attributed 70 of 86
// tables to a task. scripts/briefing.cjs requires TWENTY route modules to compose
// the briefing, and every INSERT in any of them landed in the closure.
//
// The case that exposed it: brain_decisions, 0 rows, marked Briefing. Its only
// INSERT is inside an HTTP handler in brain.js that the briefing never calls --
// the briefing requires the module for dueOwnerDecisions() and nothing else. The
// taxonomy below would then have diagnosed it "a scheduled writer runs and
// produces nothing -- this one is broken", which is a confident false finding of
// exactly the kind this tool exists to prevent.
//
// So a write only counts as schedulable if it is NOT inside a request handler.
// The test is the nearest column-0 anchor above the write: a `router.<verb>(`
// means a human or a session had to call it; a plain function or module scope
// means a batch script can reach it. recordBalance at income.js:688 is a
// top-level function and survives; brain.js's INSERT is inside router.post and
// does not. Control 3 below pins this and fails if the distinction is lost.
const ROUTE_ANCHOR_RE = /^router\.(get|post|put|patch|delete|use)\s*\(/;
const SCOPE_ANCHOR_RE = /^(async\s+)?function\s|^const\s+\w+\s*=|^let\s+\w+\s*=|^var\s+\w+\s*=|^module\.exports|^router\./;

function isRequestScoped(file, line) {
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const lines = s.split(/\r?\n/);
  for (let i = Math.min(line - 1, lines.length - 1); i >= 0; i -= 1) {
    if (!SCOPE_ANCHOR_RE.test(lines[i])) continue;
    return ROUTE_ANCHOR_RE.test(lines[i]);
  }
  return false;
}

const SPAWN_RE = /child_process|execFileSync|execSync|spawnSync|\bfork\s*\(/;
const REQ_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const SCRIPT_LIT_RE = /['"]([A-Za-z0-9_.-]+\.(?:c?js|mjs))['"]/g;

function resolveFile(p) {
  for (const cand of [p, p + '.js', p + '.cjs', p + '.mjs', path.join(p, 'index.js')]) {
    try { if (fs.statSync(cand).isFile()) return cand; } catch { /* next candidate */ }
  }
  return null;
}

// Walk require() edges AND child-process edges from one entry script.
function closureFrom(entry, byBasename) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // Relative requires, at ANY nesting depth -- hop 3 is inside a function body.
    for (const m of s.matchAll(REQ_RE)) {
      const r = resolveFile(path.resolve(path.dirname(f), m[1]));
      if (r) stack.push(r);
    }
    // Child-process edges, only in files that actually spawn -- otherwise every
    // string that looks like a filename becomes an edge.
    if (SPAWN_RE.test(s)) {
      for (const m of s.matchAll(SCRIPT_LIT_RE)) {
        const hit = byBasename.get(m[1]);
        if (hit) stack.push(hit);
      }
    }
  }
  return seen;
}

// Ask Windows what is actually scheduled. THE ZERO CASE IS NOT A FINDING: no
// tasks means PowerShell failed, the host is wrong, or permission was refused,
// and "no table has a scheduled writer" would be a confident lie. The caller
// treats an empty list as a control failure, not as good news.
function scheduledTasks() {
  const ps = 'powershell.exe';
  const cmd = '@(Get-ScheduledTask -TaskName "MissionControl-*" -ErrorAction Stop | '
    + 'ForEach-Object { [PSCustomObject]@{ Task=$_.TaskName; Args=$_.Actions[0].Arguments; '
    + 'Exec=$_.Actions[0].Execute } }) | ConvertTo-Json -Compress';
  try {
    const out = require('node:child_process')
      .execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return { error: (e && e.message) || 'powershell failed' };
  }
}

// A task's Arguments names its entry script; a .ps1 wrapper needs one more hop
// to the node script it launches. MissionControl-Server is exactly that shape.
function entryOf(task, byBasename) {
  const args = String(task.Args || '');
  const lit = args.match(/([A-Za-z0-9_./\\-]+\.(?:c?js|mjs|ps1))/);
  if (!lit) return null;
  const base = path.basename(lit[1].replace(/\\/g, '/'));
  if (base.endsWith('.ps1')) {
    const ps1 = byBasename.get(base);
    if (!ps1) return null;
    let s;
    try { s = fs.readFileSync(ps1, 'utf8'); } catch { return null; }
    const inner = s.match(/([A-Za-z0-9_./\\-]+\.(?:c?js|mjs))/);
    return inner ? byBasename.get(path.basename(inner[1].replace(/\\/g, '/'))) || null : null;
  }
  return byBasename.get(base) || null;
}

function schedIndex(files) {
  const byBasename = new Map();
  for (const f of files) if (!byBasename.has(path.basename(f))) byBasename.set(path.basename(f), f);

  const tasks = scheduledTasks();
  if (!Array.isArray(tasks)) return { error: tasks.error };
  if (!tasks.length) return { error: 'Get-ScheduledTask returned no MissionControl-* tasks' };

  const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
  const taskFiles = new Map();   // repo-relative file -> Set(task name)
  const unresolved = [];
  for (const t of tasks) {
    // The service is not a batch job. Expanding it would require every route and
    // mark all 86 tables scheduled. Its autonomous writes are timers, below.
    if (/-Server$/i.test(t.Task)) continue;
    const entry = entryOf(t, byBasename);
    if (!entry) { unresolved.push(t.Task); continue; }
    for (const f of closureFrom(entry, byBasename)) {
      const k = rel(f);
      if (!taskFiles.has(k)) taskFiles.set(k, new Set());
      taskFiles.get(k).add(t.Task);
    }
  }

  // Module-level setInterval inside the served tree: the server writing on its
  // own clock. Indented matches are skipped -- one nested in a request handler
  // fires per request, which is a human acting, not a schedule.
  const timerFiles = new Map();
  for (const f of files) {
    if (!/[/\\]server[/\\]/.test(f)) continue;
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
    s.split(/\r?\n/).forEach((line, i) => {
      if (/^(const|let|var|\s{0,2})[^/]*setInterval\s*\(/.test(line) && !/^\s{3,}/.test(line)) {
        timerFiles.set(rel(f), { line: i + 1, text: line.trim().slice(0, 90) });
      }
    });
  }
  return { taskFiles, timerFiles, tasks, unresolved };
}

function main() {
  const argv = process.argv.slice(2);
  const selfTest = argv.includes('--self-test');
  const emptyOnly = argv.includes('--empty');
  const filter = argv.find(a => !a.startsWith('--'));

  const files = sourceFiles(ROOT);

  // ---- controls, both directions, before any finding is printed --------------
  // POSITIVE: a table known to be referenced must come back referenced.
  // NEGATIVE: a name that cannot exist must come back at zero. Without the
  // negative, a pattern that matches everything scores every table as live.
  const POS = 'team_decisions', NEG = 'zzz_no_such_table_' + Date.now();
  const pos = scan(files, POS).length;
  const neg = scan(files, NEG).length;
  const posOk = pos > 0, negOk = neg === 0;

  console.log('table-census — ' + files.length + ' source files under ' + path.basename(ROOT) + '/');
  console.log('  control +  ' + POS + ': ' + pos + ' refs   ' + (posOk ? 'ok' : 'FAIL — pattern matches nothing'));
  console.log('  control -  <nonexistent>: ' + neg + ' refs   ' + (negOk ? 'ok' : 'FAIL — pattern matches everything'));
  // ---- sched controls, same discipline, its own pair ------------------------
  // A Get-ScheduledTask that returns nothing -- wrong host, no permission, no
  // PowerShell -- would score every table as having no scheduled writer, which
  // reads as a finding and is an outage. So: tasks must be found, a table known
  // to be written on a schedule must come back scheduled, and a table written
  // only through HTTP must come back blank.
  const SCHED_POS = 'income_balances';   // Briefing -> honeygain -> income.js:688
  const SCHED_NEG = 'journal_entries';   // routes/journal.js only; no batch writer
  const sched = schedIndex(files);
  let schedOk = false, schedPosHit = null, schedNegHit = null;
  if (sched.error) {
    console.log('  control ~  scheduled tasks: COULD NOT LOOK — ' + sched.error);
  } else {
    const attrib = (t) => {
      const w = scan(files, t).filter((r) => !r.schema && r.write
        && !isRequestScoped(path.join(ROOT, r.file), r.line));
      const tasks = new Set();
      for (const r of w) for (const nm of (sched.taskFiles.get(r.file) || [])) tasks.add(nm);
      const timer = w.some((r) => sched.timerFiles.has(r.file));
      return { tasks: [...tasks], timer };
    };
    schedPosHit = attrib(SCHED_POS);
    schedNegHit = attrib(SCHED_NEG);
    // Control 3 is the over-reach guard. brain_decisions IS inside briefing.cjs's
    // require closure and must still come back unattributed, because its only
    // INSERT is in a request handler. Without this, the column silently reverts
    // to "reachable by require" and marks 70 of 86 tables scheduled.
    const OVER = 'brain_decisions';
    const overHit = attrib(OVER);
    // CONTROL 4 EXISTS BECAUSE CONTROL + PASSED FOR THE WRONG REASON.
    //
    // income_balances was chosen to prove the four-hop chain, and it does not.
    // Deleting the child-process machinery entirely left it still attributed to
    // Briefing -- because briefing.cjs ALSO requires server/routes/income
    // directly, so income.js reaches the closure in two hops and the spawn hop is
    // never exercised. The control agreed with the bug: mutation-tested by
    // disabling SPAWN_RE, and it still printed ok.
    //
    // So the spawn edge is asserted on the CLOSURE rather than on an attribution.
    // fetch-honeygain.cjs is reachable ONLY as a spawned child, so if this passes,
    // hop 2 is genuinely being followed.
    const SPAWN_PROBE = 'tools/fetch-honeygain.cjs';
    const spawnGood = (sched.taskFiles.get(SPAWN_PROBE) || new Set()).size > 0;
    console.log('  control +  ' + SPAWN_PROBE + ' in closure: ' + (spawnGood ? 'yes' : 'NO')
      + '   ' + (spawnGood ? 'ok' : 'FAIL — child-process hop not followed; require-only closure'));
    // CONTROL 5: work_items must not be called broken. It has a genuine scheduled
    // writer (briefing -> runQueued) that only UPDATEs, and a request-driven
    // INSERT. If schedInsert stops distinguishing them this reverts to a
    // confident false "runs daily and yields no row".
    const CONSUMER = 'work_items';
    const consumerInsert = scan(files, CONSUMER)
      .filter((r) => !r.schema && r.insert && !isRequestScoped(path.join(ROOT, r.file), r.line))
      .some((r) => (sched.taskFiles.get(r.file) || new Set()).size > 0);
    const consumerGood = consumerInsert === false;
    console.log('  control -  ' + CONSUMER + ' (scheduled UPDATE, request INSERT): '
      + (consumerInsert ? 'scheduled-insert' : 'none')
      + '   ' + (consumerGood ? 'ok' : 'FAIL — UPDATE is being read as able to create a row'));
    const posGood = schedPosHit.tasks.length > 0 && spawnGood;
    const negGood = schedNegHit.tasks.length === 0 && !schedNegHit.timer;
    const overGood = overHit.tasks.length === 0 && consumerGood;
    schedOk = posGood && negGood && overGood;
    console.log('  control +  ' + SCHED_POS + ': ' + (schedPosHit.tasks.join(',') || 'none')
      + '   ' + (posGood ? 'ok' : 'FAIL — the four-hop chain is not being followed'));
    console.log('  control -  ' + SCHED_NEG + ': ' + (schedNegHit.tasks.join(',') || 'none')
      + '   ' + (negGood ? 'ok' : 'FAIL — closure is over-reaching; every table will look scheduled'));
    console.log('  control -  ' + OVER + ' (in closure, request-only): ' + (overHit.tasks.join(',') || 'none')
      + '   ' + (overGood ? 'ok' : 'FAIL — require-reachability is being read as scheduled'));
    console.log('  tasks      ' + sched.tasks.map((t) => t.Task).join(', ')
      + (sched.unresolved.length ? '   (entry unresolved: ' + sched.unresolved.join(', ') + ')' : ''));
  }

  if (!posOk || !negOk) {
    console.error('\n  REFUSING TO REPORT. A census with a broken pattern returns a clean sweep,');
    console.error('  which is indistinguishable from good news. Fix the controls first.');
    process.exit(2);
  }
  if (!schedOk) {
    console.error('\n  REFUSING TO REPORT THE SCHED COLUMN. "No scheduled writer" and "could not');
    console.error('  read the scheduler" must never print the same thing. Everything else above');
    console.error('  is sound; re-run on the host that owns the tasks, or fix the closure.');
    process.exit(2);
  }
  if (selfTest) { console.log('\n  self-test passed; no census run.'); return; }

  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(ROOT, 'data', 'dashboard.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map(r => r.name).filter(n => n !== 'sqlite_sequence');
  if (filter) tables = tables.filter(t => t.includes(filter));

  const rowsOf = t => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return -1; } };

  console.log('');
  console.log('  rows  readers  writers  asserts  sched          table');
  console.log('  ----  -------  -------  -------  -------------  ' + '-'.repeat(28));

  const flagged = [];
  for (const t of tables) {
    const n = rowsOf(t);
    if (emptyOnly && n !== 0) continue;
    const refs = scan(files, t);
    const real = refs.filter(r => !r.schema);
    const writers = real.filter(r => r.write);
    const allReaders = real.filter(r => !r.write);
    // Split, because they mean opposite things. A consumer reader is evidence
    // the table is wanted; an assertion reader may be evidence it is not.
    const asserts = allReaders.filter(r => ASSERT_FILE_RE.test(r.file));
    const readers = allReaders.filter(r => !ASSERT_FILE_RE.test(r.file));
    // The sched join: a writer of this table sitting inside a scheduled task's
    // closure, or in a file the server runs on its own clock.
    const schedTasks = new Set();
    let schedTimer = null, schedInsert = false;
    for (const r of writers) {
      // A write inside a request handler is not on a schedule however many
      // scheduled scripts require the file it lives in. See isRequestScoped.
      if (isRequestScoped(path.join(ROOT, r.file), r.line)) continue;
      const onTask = (sched.taskFiles.get(r.file) || []);
      for (const nm of onTask) schedTasks.add(nm.replace(/^MissionControl-/, ''));
      const onTimer = sched.timerFiles.has(r.file);
      if (onTimer) schedTimer = { file: r.file, ...sched.timerFiles.get(r.file) };
      // Only an INSERT can create a row. A scheduled UPDATE against an empty
      // table is a no-op by construction -- see INSERT_RE.
      if (r.insert && ([...onTask].length || onTimer)) schedInsert = true;
    }
    const label = [...schedTasks].join(','), tag = label || (schedTimer ? 'timer' : '');
    console.log(
      String(n).padStart(6) + String(readers.length).padStart(9) + String(writers.length).padStart(9) +
      String(asserts.length ? asserts.length : '').padStart(8) + '  ' + tag.padEnd(13) + '  ' + t
    );
    if (n === 0) flagged.push({ t, readers: readers.length, writers: writers.length, asserts,
      refs: real, schedTasks: [...schedTasks], schedTimer, schedInsert });
  }

  if (!flagged.length) return;
  console.log('');
  console.log('  EMPTY TABLES — the cause, not the count');
  console.log('  ' + '-'.repeat(60));
  for (const f of flagged) {
    let cause;
    if (f.writers === 0 && f.readers === 0) cause = 'NO CODE AT ALL — schema only. Drop it or explain it.';
    else if (f.writers === 0) cause = 'NO WRITE PATH — readers exist, nothing can fill it. Build the writer or drop the table.';
    // THE SPLIT THE SCHED COLUMN EXISTS FOR. "Has a writer that never produced a
    // row" was one diagnosis covering two opposite situations. A writer that RUNS
    // on a schedule and still yields nothing is broken and nobody has noticed. A
    // writer that only fires on a request has simply never been asked, which may
    // be entirely correct -- gate_attempts at 0 means nobody was locked out.
    else if (f.schedInsert && f.schedTasks.length) cause = 'A SCHEDULED INSERT RUNS AND PRODUCES NOTHING — '
      + f.schedTasks.join(',') + ' reaches an INSERT for this table and the table is still empty. '
      + 'This one is broken, not merely unused: something runs daily and yields no row.';
    else if (f.schedInsert && f.schedTimer) cause = 'A TIMER IN THE SERVER INSERTS HERE AND IT IS STILL EMPTY — '
      + 'the server runs this file on its own clock. Same as above: it runs, and nothing arrives.';
    else if (f.schedTasks.length || f.schedTimer) cause = 'SCHEDULED CONSUMER, REQUEST-DRIVEN PRODUCER — '
      + (f.schedTasks.join(',') || 'a server timer') + ' touches this table on a schedule, but only ever '
      + 'UPDATEs or DELETEs; the INSERT is request-driven. A scheduled UPDATE against an empty table is a '
      + 'no-op by construction, so this is NOT evidence of a fault. Empty means nobody has produced one yet.';
    else cause = 'ONLY A REQUEST-DRIVEN WRITER — nothing writes here unless something calls it, '
      + 'so an empty table may be entirely correct. NOT the same as a scheduled writer failing.';
    console.log('  ' + f.t);
    console.log('    ' + cause);
    if (f.schedTimer) console.log('      timer   ' + f.schedTimer.file + ':' + f.schedTimer.line
      + '  ' + f.schedTimer.text);
    if (f.writers) f.refs.filter(r => r.write).slice(0, 3)
      .forEach(r => console.log('      writer  ' + r.file + ':' + r.line));
    if (f.readers) f.refs.filter(r => !r.write && !ASSERT_FILE_RE.test(r.file)).slice(0, 3)
      .forEach(r => console.log('      reader  ' + r.file + ':' + r.line));
    // Printed with the line, never as a bare count. An assertion reader may be
    // asserting the table stays EMPTY, in which case it is evidence against the
    // table rather than for it -- and it will FAIL the day the table is used.
    if (f.asserts.length) {
      console.log('      ASSERTION READER(S) — read the line before treating these as demand:');
      f.asserts.slice(0, 3).forEach(r => console.log('        ' + r.file + ':' + r.line + '  ' + r.text));
      console.log('        if one expects 0, the first row ever written will fail it. Update it in the same change.');
    }
    console.log('');
  }
  console.log('  A table with readers is NOT a deletion candidate however empty it is.');
  console.log('  Deleting browsing_domain_days would have broken the browsing-recall panel.');
}

main();
