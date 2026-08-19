#!/usr/bin/env node
//
// read-hollowmast-telemetry.cjs — the report worker's summary, without the password
// passing through a command line.
//
//   node tools/read-hollowmast-telemetry.cjs
//
// The password is read from data/dash-password.txt, which is gitignored and was ignored
// BEFORE it could exist. It is never printed, never logged, and never appears in shell
// history or in a tool transcript -- which is the whole reason this file exists rather
// than a one-line curl. A secret typed into a command is a secret in three places.
'use strict';
require('./_run-log.cjs').record();
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'dash-password.txt');
const PROXY = 'https://dash.hollowmast.com';

(async () => {
  if (!fs.existsSync(FILE)) {
    console.log('\n  COULD NOT LOOK: no password at data/dash-password.txt');
    console.log('  That is not "no telemetry". Create the file and run again.');
    process.exit(2);
  }
  const pw = fs.readFileSync(FILE, 'utf8').trim();
  if (!pw) { console.log('\n  COULD NOT LOOK: the password file is empty.'); process.exit(2); }

  const auth = 'Basic ' + Buffer.from(':' + pw).toString('base64');
  const res = await fetch(`${PROXY}/summary`, {
    headers: { Authorization: auth, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();

  if (res.status === 401) {
    console.log('\n  401 — the proxy rejected that password. Nothing else is wrong.');
    process.exit(2);
  }
  if (res.status !== 200) {
    console.log(`\n  ${res.status} from the proxy: ${text.slice(0, 120)}`);
    process.exit(2);
  }
  let j = null;
  try { j = JSON.parse(text); } catch {
    console.log(`\n  200 but not JSON. First bytes: ${text.slice(0, 120)}`);
    process.exit(2);
  }
  console.log('\n' + JSON.stringify(j, null, 2).slice(0, 2600));
})().catch((e) => {
  console.log(`\n  COULD NOT LOOK: ${String(e && e.message || e).slice(0, 120)}`);
  process.exit(2);
});
