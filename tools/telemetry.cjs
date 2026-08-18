#!/usr/bin/env node
//
// telemetry.cjs — session metrics for THIS workspace. Backlog #6.
//
//   node tools/telemetry.cjs          parse and write the ledger
//   node tools/telemetry.cjs --dry    parse and print, write nothing
//
// ------------------------------------------------------------------------------------
// IT REUSES OXFORD'S STAGES RATHER THAN COPYING THEM. `scripts/telemetry/parse-session.cjs`
// over there contains ZERO references to Oxford or AutoWorks and takes --projects, --config
// and --out — it was already generic, so "generalise it" means pointing it at a second
// workspace, not forking it. A copy here would be a second owner of the same parser and the
// two would drift the first time either was touched.
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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGES = path.resolve(ROOT, '..', 'Oxford AutoWorks', 'scripts', 'telemetry');
const TRANSCRIPTS = path.join(os.homedir(), '.claude', 'projects', 'C--Users-jcwhi-Claude-Outputs');
const OUT = path.join(ROOT, 'data', 'telemetry');

const DRY = process.argv.includes('--dry');

function main() {
  // Absence and failure must differ: a missing pipeline is a different problem from a
  // pipeline that ran and found nothing.
  if (!fs.existsSync(STAGES)) {
    console.error(`The telemetry stages are not where this expects them:\n  ${STAGES}`);
    console.error('They live in Oxford AutoWorks and are reused, not copied. If that project');
    console.error('moved, update STAGES here rather than forking the parser.');
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
