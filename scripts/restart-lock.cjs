// A shared inter-process lock for every action that stops or starts
// MissionControl-Server. The holder keeps it until the new server has passed a health check.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'restart.lock');

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // it exists, but belongs to another account
  }
}

function releaseIfOwned(file, token) {
  const current = readLock(file);
  if (!current || current.token !== token) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// `link` is atomic and only publishes the completed JSON file when there is no existing
// lock. Opening the lock path directly with `wx` would expose a briefly empty lock which a
// competing process could incorrectly reclaim.
function publishLock(file, record) {
  const claim = `${file}.claim-${process.pid}-${record.token}`;
  fs.writeFileSync(claim, JSON.stringify(record));
  try {
    fs.linkSync(claim, file);
  } finally {
    try { fs.unlinkSync(claim); } catch { /* best-effort temporary cleanup */ }
  }
}

function acquireRestartLock({ file = DEFAULT_FILE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomUUID();
    const record = { pid: process.pid, token, acquiredAt: new Date().toISOString() };
    try {
      publishLock(file, record);
      return {
        acquired: true,
        file,
        holder: record,
        release: () => releaseIfOwned(file, token),
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const holder = readLock(file);
    if (holder && processIsAlive(holder.pid)) return { acquired: false, file, holder };

    // Claim a stale lock by moving it first. Never unlink the live lock path directly:
    // another restart may acquire it between our stale check and the cleanup.
    const stale = `${file}.stale-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(file, stale);
      try { fs.unlinkSync(stale); } catch { /* a stale artefact is harmless */ }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return { acquired: false, file, holder: readLock(file) };
}

module.exports = { DEFAULT_FILE, acquireRestartLock };
