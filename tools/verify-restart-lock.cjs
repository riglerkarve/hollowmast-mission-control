#!/usr/bin/env node
'use strict';

// A contention test for the restart lock. It deliberately never touches the scheduled task
// or port 3000: a child merely holds a temporary lock while this process attempts to enter.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { acquireRestartLock } = require('../scripts/restart-lock.cjs');

const file = process.argv[3] || path.join(os.tmpdir(), `mission-control-restart-lock-${process.pid}.lock`);

if (process.argv[2] === '--holder') {
  const lock = acquireRestartLock({ file });
  if (!lock.acquired) process.exit(2);
  process.stdout.write('LOCKED\n');
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, 1200);
  return;
}

async function main() {
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const child = spawn(process.execPath, [__filename, '--holder', file], {
    env: { ...process.env, TEMP: os.tmpdir(), TMP: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const locked = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => chunk.toString() === 'LOCKED\n' ? resolve() : reject(new Error(chunk)));
    child.once('error', reject);
  });
  void locked;

  const denied = acquireRestartLock({ file });
  if (denied.acquired) {
    denied.release();
    throw new Error('second restart acquired a lock that was already held');
  }
  await new Promise((resolve, reject) => child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`holder exited ${code}`))));

  const after = acquireRestartLock({ file });
  if (!after.acquired) throw new Error('lock was not released after the holder exited');
  after.release();

  // A machine can lose power while a restart holds the file. The next restart must safely
  // reclaim that dead holder instead of wedging every future recovery attempt.
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, token: 'dead-holder', acquiredAt: '2000-01-01T00:00:00.000Z' }));
  const stale = acquireRestartLock({ file });
  if (!stale.acquired) throw new Error('stale lock was not reclaimed');
  stale.release();
  console.log('PASS restart lock serializes concurrent restart attempts and releases cleanly');
}

main().catch((err) => {
  console.error(`FAIL restart lock: ${err.message}`);
  process.exitCode = 1;
});
