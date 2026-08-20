#!/usr/bin/env node
//
// verify-todo-remote-control.cjs — exercise reassignment against an isolated Todo API.
//
// The Remote Control is only trustworthy if its visible assignment selector uses the same
// writer as every other backlog mutation, rejects an unknown agent, and leaves a readable
// history. This verifier starts the route against a new temporary database. It never opens
// data/dashboard.db for writing (or reading).
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-todo-remote-control-'));
const tempDb = path.join(tempDir, 'dashboard.db');
process.env.MC_DB_PATH = tempDb;
process.env.MC_DISABLE_ACCESS_LOG = '1';

const todo = require('../server/routes/todo');
const db = require('../server/db');
const app = express();
app.use(express.json());
// server/index.js sets this before every route. Reproduce that production contract here so a
// todo_notes audit write is attributed exactly as it would be in the dashboard.
app.use((req, _res, next) => { req.by = req.get('x-mc-by') || 'remote-control-verifier'; next(); });
app.use('/api/todo', todo);

const fail = (message) => { throw new Error(message); };
async function request(base, pathname, method, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-mc-by': 'remote-control-verifier' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { response, json };
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const created = await request(base, '/api/todo/items', 'POST', {
      title: 'Verifier task: remote assignment',
      cluster: 'Ops', priority: 'P2', owner: 'CODEX', rationale: 'isolated API proof',
    });
    if (created.response.status !== 201 || created.json?.item?.owner !== 'CODEX') {
      fail(`CODEX create was not accepted: HTTP ${created.response.status}`);
    }
    const id = created.json.item.id;

    const assigned = await request(base, `/api/todo/items/${encodeURIComponent(id)}`, 'PATCH', { owner: 'LOC' });
    if (assigned.response.status !== 200 || assigned.json?.item?.owner !== 'LOC'
      || !(assigned.json?.previousTextKeptAsNotes || []).includes('owner')) {
      fail(`LOC reassignment was not saved with its audit trail: HTTP ${assigned.response.status}`);
    }

    const rejected = await request(base, `/api/todo/items/${encodeURIComponent(id)}`, 'PATCH', { owner: 'TYPO' });
    if (rejected.response.status !== 400 || !String(rejected.json?.error || '').includes('owner must be one of')) {
      fail(`unknown owner was not rejected: HTTP ${rejected.response.status}`);
    }

    const detail = await request(base, `/api/todo/items/${encodeURIComponent(id)}/detail`, 'GET');
    const history = detail.json?.notes || [];
    if (detail.response.status !== 200 || !history.some((note) => String(note.note).startsWith('owner replaced.'))) {
      fail(`owner change did not remain visible in item history: HTTP ${detail.response.status}`);
    }

    console.log('REMOTE CONTROL: PASS');
    console.log(`TEMP_DB=${tempDb}`);
    console.log('LIVE_DB=data/dashboard.db was never opened by this verifier.');
    console.log('Checked: CODEX assignment, LOC reassignment, unknown-owner refusal, append-only owner history.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    // node:sqlite holds its database and WAL handles until explicitly closed. Closing before
    // cleanup makes a passing Windows run genuinely pass instead of leaving a locked temp dir.
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('REMOTE CONTROL: FAIL');
  console.error(`TEMP_DB=${tempDb}`);
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
