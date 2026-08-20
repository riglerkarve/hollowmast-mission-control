#!/usr/bin/env node
'use strict';

// This verifier creates and removes its own named database. It never opens
// data/dashboard.db, because assertions must not write the live dashboard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv.includes('--worker')) {
  (async () => {
    const express = require('express');
    const db = require('../server/db');
    const team = require('../server/routes/team');
    const add = db.prepare(`INSERT INTO team_decisions
      (at, shift, decided_by, decision, because, revisit_when, recheck_at)
      VALUES (?, 'verify', 'verify', ?, 'because verification needs a record', 'fixture', ?)`);
    const at = '2026-08-20T00:00:00.000Z';
    const dueId = Number(add.run(at, 'A due decision', '2000-01-01').lastInsertRowid);
    add.run(at, 'A future decision', '2099-01-01');
    add.run(at, 'A malformed decision', 'when ready');
    add.run(at, 'An undated decision', null);
    const supersededId = Number(add.run(at, 'A superseded decision', '2000-01-01').lastInsertRowid);
    const replacementId = Number(add.run(at, 'Its replacement', '2099-01-01').lastInsertRowid);
    db.prepare('UPDATE team_decisions SET supersedes = ? WHERE id = ?').run(supersededId, replacementId);

    const result = team.dueDecisions();
    assert.equal(result.state, 'due');
    assert.deepEqual(result.items.map((item) => item.id), [dueId]);
    assert.equal(result.residue.future.length, 2);
    assert.equal(result.residue.malformed.length, 1);
    assert.equal(result.residue.undated.length, 1);
    assert.equal(result.residue.superseded.length, 1);
    const report = team.reportFor('verify');
    assert.equal(report.decisionsDue.state, 'due');
    assert.deepEqual(report.decisionsDue.items.map((item) => item.id), [dueId]);

    const app = express();
    app.use('/', team);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const due = await fetch(`${base}/decisions?due=1`).then((response) => response.json());
      assert.equal(due.state, 'due');
      assert.deepEqual(due.items.map((item) => item.id), [dueId]);
      const normal = await fetch(`${base}/decisions`).then((response) => response.json());
      assert.equal(normal.state, 'ok');
      assert.equal(normal.decisions.length, 6);
      const invalid = await fetch(`${base}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'Bad date', because: 'test validation', decided_by: 'verify', recheck_at: '2026-02-30' }),
      });
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).error, /real YYYY-MM-DD/);
      const rendered = spawnSync(process.execPath, ['tools/shift-report.cjs', '--shift', 'verify'], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', env: process.env,
      });
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.match(rendered.stdout, /## Decisions due for recheck/);
      assert.match(rendered.stdout, /Decision #\d+ — due 2000-01-01/);
      process.stdout.write('worker checks passed\n');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  return;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-team-due-decisions-'));
const dbPath = path.join(tempDir, 'team-due-decisions-test.db');
const out = spawnSync(process.execPath, [__filename, '--worker'], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8',
  env: { ...process.env, MC_DB_PATH: dbPath, MC_DISABLE_ACCESS_LOG: '1', MC_ACTOR: 'verify-team-due-decisions' },
});
try {
  if (out.status !== 0) throw new Error(`${out.stdout}\n${out.stderr}`.trim());
  process.stdout.write(`passed: ${out.stdout.trim()}\n`);
  process.stdout.write(`temporary database used (and removed): ${tempDir}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
