#!/usr/bin/env node
'use strict';

// Exercises the Focus ledger's evidence paths against a fresh named database. It never
// opens data/dashboard.db: MC_DB_PATH is set before any project database import.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-focus-ledger-'));
const tempDb = path.join(root, 'dashboard.db');
process.env.MC_DB_PATH = tempDb;
process.env.MC_DISABLE_ACCESS_LOG = '1';

const db = require('../server/db');
const provenance = require('../server/provenance');
require('../server/routes/todo');
const sessions = require('../server/routes/sessions');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(`TEMPORARY FOCUS LEDGER DATABASE (never live): ${tempDb}`);
  db.prepare(`INSERT INTO todo_items (id, title, status, project)
              VALUES ('focus-test-item', 'Focus ledger verification item', 'open', 'Mission Control')`).run();

  const app = express();
  app.use(express.json());
  app.use(provenance.middleware);
  app.use('/api/sessions', sessions);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/sessions`;
  const call = async (url, options = {}) => {
    const response = await fetch(base + url, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-MC-By': 'codex', ...(options.headers || {}) },
    });
    const text = await response.text();
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    return { response, body: text && isJson ? JSON.parse(text) : null, text };
  };

  try {
    const created = await call('/', { method: 'POST', body: JSON.stringify({ kind: 'work', durationMinutes: 25 }) });
    assert(created.response.status === 201, `create expected 201, got ${created.response.status}`);
    const id = created.body.id;
    db.prepare('UPDATE focus_sessions SET cost_microusd = 1234000 WHERE id = ?').run(id);

    const linked = await call(`/${id}/link`, { method: 'PATCH', body: JSON.stringify({ todoId: 'focus-test-item' }) });
    assert(linked.response.status === 200 && linked.body.linkSource === 'manual', 'manual project link was not recorded');
    const duplicate = await call(`/${id}/link`, { method: 'PATCH', body: JSON.stringify({ todoId: 'focus-test-item' }) });
    assert(duplicate.response.status === 409, 'an existing direct project link was overwritten');

    const target = await call('/ledger/targets/Mission%20Control', { method: 'PUT', body: JSON.stringify({ weeklyTargetMinutes: 120 }) });
    assert(target.response.status === 200 && target.body.weeklyTargetMinutes === 120, 'weekly target was not stored');

    const presence = await call('/active', { method: 'PUT', body: JSON.stringify({ todoId: 'focus-test-item' }) });
    assert(presence.response.status === 200 && presence.body.actor === 'codex', 'active presence was not recorded');
    const active = await call('/active');
    assert(active.response.status === 200 && active.body.active[0].todoId === 'focus-test-item', 'active presence did not retain its direct task link');
    const cleared = await call('/active', { method: 'DELETE' });
    assert(cleared.response.status === 204, 'active presence did not clear');

    const ledger = await call('/ledger?days=7');
    assert(ledger.response.status === 200, 'ledger did not respond');
    assert(ledger.body.quality.sessions === 1 && ledger.body.quality.linkedSessions === 1, 'ledger evidence coverage is wrong');
    assert(ledger.body.quality.costKnownSessions === 1, 'ledger did not report source-recorded cost');
    assert(ledger.body.projects[0].project === 'Mission Control', 'project allocation did not use the linked backlog item');
    assert(ledger.body.targets[0].weeklyTargetMinutes === 120, 'ledger did not include its project target');

    const day = ledger.body.actorDays[0].day;
    const detail = await call(`/ledger/sessions?day=${day}&actor=codex`);
    assert(detail.response.status === 200 && detail.body.sessions[0].todoLinkSource === 'manual', 'timeline drill-down lost manual-link provenance');

    const csv = await call('/ledger/report.csv?days=7');
    assert(csv.response.status === 200 && csv.text.includes('1234000') && csv.text.includes('Mission Control'), 'CSV report omitted project or cost evidence');
    console.log('PASS focus ledger features: explicit link, immutable evidence, target, live presence, coverage, drill-down, and CSV all verified.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(`FAIL focus ledger features: ${err.message}`);
  process.exitCode = 1;
});
