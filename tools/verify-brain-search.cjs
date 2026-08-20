#!/usr/bin/env node
'use strict';

// Searches a temporary memory directory against a named temporary DB. It never opens
// data/dashboard.db or the real Claude memory directory.
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
      const result = await fetch(`${base}/?q=needle-only-in-body`).then((r) => r.json());
      assert.equal(result.shown, 1);
      assert.equal(result.searchScope.includes('body'), true);
      assert.deepEqual(result.memories[0].matchedFields, ['body']);
      assert.equal(Object.hasOwn(result.memories[0], 'searchText'), false);
      assert.equal(Object.hasOwn(result.memories[0], 'markdown'), false);

      const byName = await fetch(`${base}/?q=memory-name`).then((r) => r.json());
      assert.deepEqual(byName.memories[0].matchedFields, ['name']);
      process.stdout.write('worker checks passed\n');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  return;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-brain-search-'));
const memoryDir = path.join(tempDir, 'memory');
const dbPath = path.join(tempDir, 'brain-search-test.db');
fs.mkdirSync(memoryDir);
fs.writeFileSync(path.join(memoryDir, 'fixture.md'), `---
name: memory-name
description: A fixture whose hidden body is searchable.
type: reference
modified: 2026-08-20
---
This sentence contains needle-only-in-body and must not be returned by the index.
`);
const out = spawnSync(process.execPath, [__filename, '--worker'], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8',
  env: { ...process.env, MEMORY_DIR: memoryDir, MC_DB_PATH: dbPath, MC_DISABLE_ACCESS_LOG: '1', MC_ACTOR: 'verify-brain-search' },
});
try {
  if (out.status !== 0) throw new Error(`${out.stdout}\n${out.stderr}`.trim());
  process.stdout.write(`passed: ${out.stdout.trim()}\n`);
  process.stdout.write(`temporary memory and database used (and removed): ${tempDir}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
