#!/usr/bin/env node
'use strict';

// verify-checkers.cjs — prove the trust checkers reject one known bad input each.
//
// Every planted workspace defect has a byte-for-byte restoration guard in finally. Tool-run
// logging is redirected to TEMP_DB, never data/dashboard.db. Fixture-only checks use their
// documented environment roots so they do not depend on live reference or memory content.

const child = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-checkers-'));
const tempDb = path.join(tempDir, 'tool-runs.db');
const commonEnv = { ...process.env, MC_DB_PATH: tempDb, MC_DISABLE_ACCESS_LOG: '1' };
const created = new Set();
const replacements = new Map();
let failures = 0;

function say(ok, name, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function create(relative, content) {
  const file = path.join(ROOT, relative);
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite existing probe: ${relative}`);
  fs.writeFileSync(file, content);
  created.add(file);
  return file;
}

function appendExact(relative, suffix) {
  const file = path.join(ROOT, relative);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from(suffix)]));
  replacements.set(file, { original, expected: Buffer.concat([original, Buffer.from(suffix)]) });
}

function restoreOne(file) {
  if (created.has(file)) {
    if (fs.existsSync(file)) fs.rmSync(file);
    if (fs.existsSync(file)) throw new Error(`probe remained after removal: ${path.relative(ROOT, file)}`);
    created.delete(file);
    return;
  }
  const replacement = replacements.get(file);
  if (!replacement) return;
  const actual = fs.readFileSync(file);
  if (!actual.equals(replacement.expected)) {
    throw new Error(`refusing to overwrite concurrent change while restoring ${path.relative(ROOT, file)}`);
  }
  fs.writeFileSync(file, replacement.original);
  if (!fs.readFileSync(file).equals(replacement.original)) throw new Error(`restore mismatch: ${path.relative(ROOT, file)}`);
  replacements.delete(file);
}

function restoreAll() {
  const pending = [...created, ...replacements.keys()];
  const errors = [];
  for (const file of pending.reverse()) {
    try { restoreOne(file); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'one or more checker probes could not be restored');
}

function run(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const proc = child.spawn(process.execPath, [path.join(ROOT, 'tools', script), ...args], {
      cwd: ROOT,
      env: { ...commonEnv, ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.once('error', reject);
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function expect(name, script, args, expected, env) {
  const result = await run(script, args, env);
  say(result.code === expected && !result.signal, name,
    result.signal ? `ended by ${result.signal}` : `exit ${result.code}`);
}

function server(status) {
  const instance = http.createServer((_req, res) => { res.statusCode = status; res.end('checker fixture'); });
  return new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

async function main() {
  console.log(`TEMPORARY TOOL DATABASE (never the live ledger): ${tempDb}`);

  console.log('\n--- provenance-check ---');
  const provenanceProbe = create('tools/.checker-probe-provenance.cjs', "const probeDb = require('../server/db');\nvoid probeDb;\n");
  await expect('planted unattributed database user is rejected', 'provenance-check.cjs', [], 1);
  restoreOne(provenanceProbe);
  await expect('restored provenance check is clean', 'provenance-check.cjs', [], 0);

  console.log('\n--- routes-check ---');
  const routeProbe = create('server/routes/.checker-probe-route.js', "'use strict';\n");
  await expect('unrequired route file is rejected', 'routes-check.cjs', ['--no-http'], 1);
  restoreOne(routeProbe);
  await expect('restored route inventory is clean', 'routes-check.cjs', ['--no-http'], 0);

  console.log('\n--- verify-panel ---');
  const cssProbe = 'public/panels/atlas/atlas.css';
  appendExact(cssProbe, '\n/* verifier probe: this token must not exist */\n.checker-probe { color: var(--checker-token-does-not-exist); }\n');
  await expect('undefined panel token is rejected', 'verify-panel.cjs', ['atlas'], 1);
  restoreOne(path.join(ROOT, cssProbe));
  await expect('restored panel is clean', 'verify-panel.cjs', ['atlas'], 0);

  console.log('\n--- memory-index-check ---');
  const memoryDir = path.join(tempDir, 'memory');
  fs.mkdirSync(memoryDir);
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Fixture\n');
  const memoryProbe = path.join(memoryDir, 'missing-from-index.md');
  fs.writeFileSync(memoryProbe, '# Unindexed fixture\n');
  await expect('unindexed memory is rejected', 'memory-index-check.cjs', [], 1, { MEMORY_DIR: memoryDir });
  fs.rmSync(memoryProbe);
  await expect('restored memory index is clean', 'memory-index-check.cjs', [], 0, { MEMORY_DIR: memoryDir });

  console.log('\n--- link-check ---');
  const linkDir = path.join(tempDir, 'reference');
  fs.mkdirSync(linkDir);
  const linkServer = await server(404);
  const port = linkServer.address().port;
  const linkDoc = path.join(linkDir, 'probe.md');
  fs.writeFileSync(linkDoc, `[fixture](http://127.0.0.1:${port}/gone)\n`);
  try {
    await expect('known 404 link is rejected', 'link-check.cjs', ['probe'], 1, { LINK_DIR: linkDir });
    linkServer.close();
    await new Promise((resolve) => linkServer.once('close', resolve));
    const cleanServer = await server(200);
    const cleanPort = cleanServer.address().port;
    fs.writeFileSync(linkDoc, `[fixture](http://127.0.0.1:${cleanPort}/ok)\n`);
    try { await expect('restored link fixture is clean', 'link-check.cjs', ['probe'], 0, { LINK_DIR: linkDir }); }
    finally { cleanServer.close(); }
  } finally {
    if (linkServer.listening) linkServer.close();
  }

  console.log('\n--- secrets-scan ---');
  const key = fs.readFileSync(path.join(ROOT, 'data', 'gate-key.txt'), 'utf8').trim();
  if (key.length < 12) throw new Error('gate key was unavailable for the deliberate secret-scan probe');
  // Not dot-prefixed: this must exercise the normal untracked-file enumeration too, not a
  // shell/glob edge case around hidden filenames.
  const secretProbe = create('tools/checker-secret-probe.cjs', `${key}\n`);
  await expect('untracked live-secret copy is rejected', 'secrets-scan.cjs', ['--all'], 1);
  restoreOne(secretProbe);
  await expect('restored working tree has no secret copy', 'secrets-scan.cjs', ['--all'], 0);

  console.log(`\n${failures ? 'FAIL' : 'PASS'} checker proof: ${failures} unexpected result(s); all planted workspace defects were restored.`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(`FAIL checker proof: ${error.stack || error.message}`);
  failures += 1;
  process.exitCode = 1;
}).finally(() => {
  try { restoreAll(); }
  catch (error) { console.error(`FAIL verified cleanup: ${error.stack || error.message}`); process.exitCode = 1; }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); }
  catch (error) { console.error(`FAIL temporary cleanup: ${error.message}`); process.exitCode = 1; }
});
