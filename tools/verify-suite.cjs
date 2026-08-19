#!/usr/bin/env node
//
// verify-suite.cjs — one truthful entry point for the verification suite.
//
//   node tools/verify-suite.cjs
//   node tools/verify-suite.cjs --json
//   node tools/verify-suite.cjs --write-baseline --confirm-write
//
// A suite may run only checks whose construction keeps test writes out of
// data/dashboard.db. Checks that need a live server, alter live state, use the network, or
// deliberately modify the shared working tree are named as MANUAL instead of being silently
// skipped or falsely counted as passing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const BASELINE = path.join(ROOT, 'baselines', 'verification-suite.json');
const json = process.argv.includes('--json');
const writeBaseline = process.argv.includes('--write-baseline');
const confirmWrite = process.argv.includes('--confirm-write');

const CHECK_NAME = /(?:check|audit|verify|integrity|scan)|^(?:migrate-from-zero|restore-backup|endpoint-shapes|figure-ownership|routes-check|vanished)\.cjs$/i;

// Keep the safety decision beside the exact command. A new checker is intentionally
// UNCLASSIFIED until somebody decides whether it belongs in unattended execution.
const checks = {
  'check-claim.cjs': { mode: 'manual', why: 'requires a specific claim and target path' },
  'concurrency-surface-audit.cjs': { mode: 'safe', args: [] },
  'endpoint-shapes.cjs': { mode: 'manual', why: 'probes the running server and records access-log reads' },
  'figure-ownership.cjs': { mode: 'manual', why: 'compares live API data and records access-log reads' },
  'gate-check.cjs': { mode: 'manual', why: 'deliberately creates, revokes, and expires live gate state' },
  'link-check.cjs': { mode: 'manual', why: 'makes external network requests and can be rate-limited' },
  'memory-index-check.cjs': { mode: 'manual', why: 'its run logger writes data/dashboard.db' },
  'migrate-from-zero.cjs': { mode: 'safe', args: [], temp: true },
  'provenance-check.cjs': { mode: 'manual', why: 'its run logger writes data/dashboard.db' },
  'restore-backup.cjs': { mode: 'safe', args: [], temp: true },
  'routes-check.cjs': { mode: 'safe', args: ['--no-http'] },
  'schema-integrity.cjs': { mode: 'safe', args: ['--self-test'], temp: true },
  'secrets-scan.cjs': { mode: 'manual', why: 'its run logger writes data/dashboard.db' },
  'tool-audit.cjs': { mode: 'safe', args: [] },
  'usage-contract-audit.cjs': { mode: 'safe', args: [] },
  'vanished.cjs': { mode: 'manual', why: 'the configured pre-commit hook is currently absent' },
  'verify-access-log-floor.cjs': { mode: 'safe', args: [] },
  'verify-checkers.cjs': { mode: 'manual', why: 'plants defects in the shared working tree while proving checkers' },
  'verify-concurrent-writes.cjs': { mode: 'safe', args: [], temp: true },
  'verify-m73-needs-owner.cjs': { mode: 'manual', why: 'checks a historical workflow with live team data' },
  'verify-ollama-shift.cjs': { mode: 'manual', why: 'depends on the in-progress Ollama shift artefacts' },
  'verify-panel.cjs': { mode: 'manual', why: 'probes the running server and its run logger writes data/dashboard.db' },
  'verify-restart-lock.cjs': { mode: 'safe', args: [], temp: true },
  'verify-route-failures.cjs': { mode: 'safe', args: [], temp: true },
  'verify-shift-report.cjs': { mode: 'manual', why: 'depends on the current shift report and in-progress artefacts' },
};

function candidates() {
  return fs.readdirSync(TOOLS)
    .filter((name) => name !== 'verify-suite.cjs' && name.endsWith('.cjs') && CHECK_NAME.test(name))
    .sort();
}

function contract(rows) {
  return rows.map((name) => {
    const spec = checks[name];
    return {
      tool: name,
      mode: spec ? spec.mode : 'unclassified',
      args: spec && spec.args ? spec.args : [],
      reason: spec && spec.why ? spec.why : null,
      temporaryDatabase: Boolean(spec && spec.temp),
    };
  });
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return { state: 'missing' };
  try {
    const body = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    return { state: 'read', body };
  } catch (error) {
    return { state: 'invalid', error: error.message };
  }
}

function sameContract(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function run(name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TOOLS, name), ...args], {
      cwd: ROOT,
      env: { ...process.env, MC_DISABLE_ACCESS_LOG: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => resolve({ name, status: 'could-not-run', detail: error.message }));
    child.once('close', (code, signal) => {
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      resolve({ name, status: code === 0 ? 'pass' : 'fail', code, signal, detail: lines.slice(-4) });
    });
  });
}

function outputLine(result) {
  if (result.status === 'manual') return `MANUAL  ${result.tool} — ${result.reason}`;
  if (result.status === 'unclassified') return `UNCLASSIFIED  ${result.tool} — no unattended-safety decision recorded`;
  const suffix = result.detail && result.detail.length ? ` — ${result.detail.join(' | ')}` : '';
  return `${result.status.toUpperCase().padEnd(8)} ${result.tool}${suffix}`;
}

(async () => {
  if (writeBaseline && !confirmWrite) {
    console.error('REFUSED: --write-baseline needs --confirm-write because it changes the committed suite contract.');
    process.exitCode = 2;
    return;
  }

  const names = candidates();
  const suite = contract(names);
  const results = [];
  for (const entry of suite) {
    if (entry.mode === 'safe') {
      const result = await run(entry.tool, entry.args);
      results.push({ ...entry, ...result });
    } else {
      results.push({ ...entry, status: entry.mode, reason: entry.reason });
    }
  }

  const prior = readBaseline();
  const baseline = prior.state === 'read' && sameContract(prior.body.contract, suite)
    ? 'matches' : prior.state === 'missing' ? 'missing' : prior.state === 'invalid' ? 'invalid' : 'drifted';
  const failed = results.filter((result) => result.status === 'fail' || result.status === 'could-not-run');
  const unknown = results.filter((result) => result.status === 'unclassified');

  if (writeBaseline && !failed.length && !unknown.length) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify({ version: 1, generatedBy: 'tools/verify-suite.cjs', contract: suite }, null, 2)}\n`);
  }

  const report = {
    suite: 'verification-suite',
    liveDatabase: 'never opened writable by this suite; each automatic database test names a temporary path itself',
    baseline: writeBaseline && !failed.length && !unknown.length ? 'written' : baseline,
    contract: suite,
    results,
    summary: {
      safePassed: results.filter((result) => result.status === 'pass').length,
      safeFailed: failed.length,
      manual: results.filter((result) => result.status === 'manual').length,
      unclassified: unknown.length,
    },
  };

  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Verification Suite — Batch I (M111–M113)');
    console.log('AUTOMATIC CHECKS: safe by construction; no test may write data/dashboard.db.');
    for (const result of results) console.log(outputLine(result));
    console.log(`SUMMARY: ${report.summary.safePassed} safe pass; ${report.summary.safeFailed} safe fail; ${report.summary.manual} manual; ${report.summary.unclassified} unclassified; baseline ${report.baseline}.`);
    if (report.summary.manual) console.log('MANUAL is residue, not a pass. See reference/verification-suite-unattended.md before arranging any unattended run.');
  }

  if (failed.length || unknown.length || baseline === 'invalid' || (baseline === 'drifted' && !writeBaseline)) process.exitCode = 1;
})().catch((error) => {
  console.error(`SUITE FAILURE: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
