#!/usr/bin/env node
//
// telemetry.cjs — session metrics for THIS workspace. Backlog #6.
//
//   node tools/telemetry.cjs          parse and write the ledger
//   node tools/telemetry.cjs --dry    parse and print, write nothing
//
// ------------------------------------------------------------------------------------
// IT USED TO REUSE OXFORD'S STAGES RATHER THAN COPY THEM, on the argument that
// parse-session.cjs contains ZERO references to Oxford or AutoWorks and so was already
// generic. That argument was about the TEXT and turned out to be wrong about the BEHAVIOUR:
// the parser records a projectRoot and resolves every file path against it, so where it
// lives changes what it attributes. Copied in and re-rooted on 18 Aug — see STAGES below.
// The drift risk that argument warned about is real and is now accepted deliberately: this
// workspace owns its copy, and Oxford's can diverge without breaking a scheduled task here.
//
// TWO DELIBERATE DIFFERENCES FROM OXFORD'S SETUP, both chosen by the owner on 18 Aug:
//
//   1. THE COMPOSITE SCORE IS DROPPED. Oxford's ledger carries insights.score — 51.6, built
//      from four weighted components. The components are kept and the composite is not,
//      because a number assembled from weights nobody chose is the one figure on a dashboard
//      that cannot be argued with. Keeping the parts means the ranking stays checkable.
//   2. THE LEDGER IS GITIGNORED HERE. Oxford commits its own. This workspace's sessions
//      include ones that read the bank ledger, and derived metrics about that work do not
//      belong in a repo that could later be made public.
// ------------------------------------------------------------------------------------
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// LOCAL, as of 18 Aug 2026. This used to resolve to
// '../Oxford AutoWorks/scripts/telemetry' and shell out to that project's parser. The
// reuse argument below was right at the time and is now wrong for one reason: Oxford is
// kept and documented but NOT in the rotation, and a live ops tool that reaches into a
// dormant 4.7 GB project breaks the day that directory is moved or archived — silently,
// inside a scheduled task, which is the worst place for it.
//
// parse-session.cjs, areas.cjs and config.json were copied here byte-identically, verified
// by sha256 rather than size.
//
// I SET "BYTE-IDENTICAL OUTPUT" AS THE ACCEPTANCE TEST AND IT WAS THE WRONG TEST. The
// outputs differ, and they SHOULD: parse-session records a `projectRoot` and resolves every
// file path against it, so where the parser lives changes what it attributes. Run from
// Oxford, it looked for this workspace's edited files under Oxford's root, found none, and
// wrote `files: []` — no error, no warning, just an empty array that reads as "nothing was
// edited".
//
// Measured on a FROZEN copy of the transcripts, because the live ones grow while you look
// at them and the first two comparisons were confounded by my own session writing to them:
//
//     Oxford rooting   0 files attributed across 0 sessions
//     local rooting    63 files across 2, including server/routes/brain.js at 6 edits
//
// So this is not a refactor that happens to be safe. It is a fix: the dependency was
// producing mis-rooted data, and every churn figure in the old ledger was empty for a
// reason nobody had asked about.
const STAGES = path.resolve(__dirname, 'telemetry');
const TRANSCRIPTS = path.join(os.homedir(), '.claude', 'projects', 'C--Users-jcwhi-Claude-Outputs');
const OUT = path.join(ROOT, 'data', 'telemetry');

const DRY = process.argv.includes('--dry');

function main() {
  // Absence and failure must differ: a missing pipeline is a different problem from a
  // pipeline that ran and found nothing.
  if (!fs.existsSync(STAGES)) {
    console.error(`The telemetry stages are not where this expects them:\n  ${STAGES}`);
    console.error('They are a LOCAL copy under tools/telemetry/ as of 18 Aug — parse-session.cjs,');
    console.error('areas.cjs and config.json. If they are missing, restore them; do not re-point this');
    console.error('at Oxford AutoWorks, which rooted every path at the wrong project.');
    process.exit(1);
  }
  if (!fs.existsSync(TRANSCRIPTS)) {
    console.error(`No transcripts for this workspace at:\n  ${TRANSCRIPTS}`);
    process.exit(1);
  }

  const sessions = fs.readdirSync(TRANSCRIPTS).filter((f) => f.endsWith('.jsonl'));
  console.log(`  ${sessions.length} session transcript(s) for this workspace`);

  fs.mkdirSync(OUT, { recursive: true });
  const sessionsJson = path.join(OUT, 'sessions.json');

  try {
    execFileSync('node', [
      path.join(STAGES, 'parse-session.cjs'),
      '--projects', TRANSCRIPTS,
      '--config', path.join(STAGES, 'config.json'),
      '--out', sessionsJson,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    console.error(`parse-session failed: ${err.message}`);
    process.exit(1);
  }

  if (!fs.existsSync(sessionsJson)) {
    console.error('parse-session reported success but wrote nothing — refusing to continue.');
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(sessionsJson, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : (parsed.sessions || []);

  // Strip the composite wherever it appears, keep everything it was built from.
  const stripped = list.map((s) => {
    const out = { ...s };
    if (out.insights && typeof out.insights === 'object') {
      const { score, ...rest } = out.insights;
      out.insights = { ...rest, scoreRemoved: 'A composite built from weights nobody chose is not auditable. Components kept.' };
    }
    return out;
  });

  const totals = stripped.reduce((a, s) => ({
    sessions: a.sessions + 1,
    msgs: a.msgs + (s.msgs || 0),
    toolCalls: a.toolCalls + (s.toolCalls || 0),
    toolErrors: a.toolErrors + (s.toolErrors || 0),
  }), { sessions: 0, msgs: 0, toolCalls: 0, toolErrors: 0 });

  console.log(`  parsed: ${totals.sessions} sessions, ${totals.msgs} messages, ${totals.toolCalls} tool calls, ${totals.toolErrors} tool errors`);
  // Accurate rather than flattering: parse-session does NOT compute insights.score -- that
  // is added downstream by ledger.cjs, which this does not run. So the strip below is a
  // GUARD for the day someone adds that stage, not work it is doing today. Reporting
  // 'removed 0' as if it had scrubbed something would be a claim with nothing behind it.
  const had = stripped.filter((s) => s.insights).length;
  console.log(had
    ? `  composite score removed from ${had} session(s); components retained`
    : '  no composite present at this stage — parse-session emits raw counts only, so the '
      + 'strip above stands as a guard if ledger.cjs is ever added here');

  if (DRY) { console.log('\n--dry: nothing written.'); return; }

  const ledger = path.join(OUT, 'ledger.jsonl');
  fs.writeFileSync(ledger, stripped.map((s) => JSON.stringify(s)).join('\n') + '\n');
  console.log(`\n  wrote ${ledger}`);
  console.log('  data/ is gitignored, so this stays off any repo — deliberately.');
}

main();
