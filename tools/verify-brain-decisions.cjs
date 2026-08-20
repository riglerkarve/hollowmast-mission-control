#!/usr/bin/env node
'use strict';

// Uses a named disposable DB and memory directory. It never opens data/dashboard.db or the
// real Claude memory store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv.includes('--worker')) {
  (async () => {
    const express = require('express');
    const brain = require('../server/routes/brain');
    const app = express();
    app.use('/', brain);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const create = (body) => fetch(`${base}/decisions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const first = await create({ venture: 'Fixture venture', decision: 'Keep the test local', because: 'the verifier must not touch live data', revisit_when: 'test day', recheck_at: '2000-01-01' });
      assert.equal(first.status, 201);
      const firstBody = await first.json();
      assert.equal(firstBody.written, 1);
      const invalid = await create({ venture: 'Fixture venture', decision: 'Bad date', because: 'validation', recheck_at: '2026-02-30' });
      assert.equal(invalid.status, 400);
      const due = await fetch(`${base}/decisions?due=1`).then((r) => r.json());
      assert.equal(due.state, 'due');
      assert.equal(due.items.length, 1);
      const byVenture = await fetch(`${base}/decisions?venture=Fixture%20venture`).then((r) => r.json());
      assert.equal(byVenture.state, 'ok');
      assert.equal(byVenture.decisions.length, 1);
      const generated = fs.readFileSync(path.join(process.env.MEMORY_DIR, '_decisions.md'), 'utf8');
      assert.match(generated, /Fixture venture/);
      assert.match(generated, /Keep the test local/);
      process.stdout.write('worker checks passed\n');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  return;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-brain-decisions-'));
const memoryDir = path.join(tempDir, 'memory');
const dbPath = path.join(tempDir, 'brain-decisions-test.db');
fs.mkdirSync(memoryDir);
const out = spawnSync(process.execPath, [__filename, '--worker'], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8',
  env: { ...process.env, MEMORY_DIR: memoryDir, MC_DB_PATH: dbPath, MC_DISABLE_ACCESS_LOG: '1', MC_ACTOR: 'verify-brain-decisions' },
});
try {
  if (out.status !== 0) throw new Error(`${out.stdout}\n${out.stderr}`.trim());
  process.stdout.write(`passed: ${out.stdout.trim()}\n`);
  process.stdout.write(`temporary memory and database used (and removed): ${tempDir}\n`);
} finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
