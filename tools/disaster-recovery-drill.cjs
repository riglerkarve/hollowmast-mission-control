#!/usr/bin/env node
//
// disaster-recovery-drill.cjs — restore Mission Control using ONLY what would still exist if
// this machine were gone, and prove the result runs.
//
// M142, migrated from the backlog: migrate-from-zero and restore-backup (built 18-20 Aug) both
// proved something narrower than "this survives a disaster" — they restore a LOCAL backup file
// into a LOCAL temp path, on THIS disk, using tools that already live in THIS repo checkout.
// If this machine is what's gone, none of that is available. This drill is honest about that
// gap: it pulls the CODE from GitHub over the network (not from this checkout's .git objects)
// and the DATABASE from the OneDrive-synced folder (not from mission-control/backups/, which
// dies with the project folder), decrypts it with the same passphrase file this checkout uses,
// and proves the restored server actually starts and answers a request.
//
// WHAT THIS DOES NOT PROVE, stated because a drill that overclaims is worse than none: it still
// runs on this machine's disk, this machine's OS, and this machine's copy of Node. It cannot
// prove the disk itself, or Windows, or Node's availability elsewhere. See the printed section
// "WHAT A REAL DRILL STILL NEEDS" for exactly what closes that gap.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const REMOTE_URL = 'https://github.com/riglerkarve/hollowmast-mission-control.git';
const ONEDRIVE_DIR = 'C:/Users/jcwhi/OneDrive/MissionControl-Backups';
const crypt = require('./backup-crypt.cjs');

const problems = [];
const steps = [];
async function step(label, fn) {
  try {
    const result = await fn();
    steps.push({ label, ok: true, result });
    console.log(`OK   ${label}${result ? ' — ' + result : ''}`);
    return result;
  } catch (e) {
    steps.push({ label, ok: false, error: e.message });
    problems.push(`${label}: ${e.message}`);
    console.error(`FAIL ${label}: ${e.message}`);
    return undefined;
  }
}

function closeQuietly(db) { try { db.close(); } catch { /* already reported */ } }

async function main() {
  console.log('=== Mission Control disaster-recovery drill ===');
  console.log('Simulating: this project folder and this repo checkout are both gone.');
  console.log('Only sources used below: GitHub (network) and OneDrive (synced folder).\n');

  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-disaster-drill-'));
  console.log(`Drill workspace (stands in for "new machine"): ${drillRoot}\n`);

  // ---- 1. code, from GitHub, not from this checkout -----------------------------------------
  const codeDir = path.join(drillRoot, 'code');
  await step('clone repository history from GitHub (network, not local .git objects)', () => {
    execFileSync('git', ['clone', '--quiet', REMOTE_URL, codeDir], { stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codeDir }).toString().trim();
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: codeDir }).toString().trim();
    return `HEAD ${sha.slice(0, 12)}, ${count} commits`;
  });

  await step('compare cloned tree against this checkout\'s tracked files (catches "works here, missing on GitHub")', () => {
    if (!fs.existsSync(codeDir)) throw new Error('clone did not produce a directory to compare');
    const localTracked = execFileSync('git', ['ls-files'], { cwd: ROOT }).toString().split(/\r?\n/).filter(Boolean);
    const missing = localTracked.filter((f) => !fs.existsSync(path.join(codeDir, f)));
    if (missing.length) {
      throw new Error(`${missing.length} file(s) tracked locally are absent from the GitHub clone (uncommitted or unpushed): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`);
    }
    return `all ${localTracked.length} locally-tracked files are present in the GitHub clone`;
  });

  await step('install dependencies in the cloned copy (proves package.json + lockfile are sufficient)', () => {
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'npm', 'install', '--omit=dev', '--no-audit', '--no-fund']]
      : ['npm', ['install', '--omit=dev', '--no-audit', '--no-fund']];
    execFileSync(cmd, args, { cwd: codeDir, stdio: 'pipe' });
    return 'npm install completed';
  });

  // ---- 2. database, from OneDrive, not from mission-control/backups/ ------------------------
  let restoredDbPath = null;
  let sourceEncFile = null;
  await step('find newest OneDrive-synced encrypted backup (off-machine copy, not in-tree)', () => {
    if (!fs.existsSync(ONEDRIVE_DIR)) throw new Error(`OneDrive backup folder not found: ${ONEDRIVE_DIR}`);
    const candidates = fs.readdirSync(ONEDRIVE_DIR)
      .filter((n) => /^dashboard-.*\.db\.enc$/i.test(n))
      .map((n) => ({ file: path.join(ONEDRIVE_DIR, n), stat: fs.statSync(path.join(ONEDRIVE_DIR, n)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (!candidates.length) throw new Error(`no dashboard-*.db.enc files in ${ONEDRIVE_DIR}`);
    sourceEncFile = candidates[0].file;
    const newest = candidates[0];
    return `${path.basename(newest.file)} (${(newest.stat.size / 1048576).toFixed(1)} MB, ${newest.stat.mtime.toISOString()})`;
  });

  if (sourceEncFile) {
    await step('decrypt the OneDrive backup using data/backup-key.txt', () => {
      const dataDir = path.join(drillRoot, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      restoredDbPath = path.join(dataDir, 'dashboard.db');
      const pass = crypt.passphrase();
      const r = crypt.decrypt(sourceEncFile, restoredDbPath, pass);
      return `decrypted -> ${(r.bytesOut / 1048576).toFixed(1)} MB`;
    });

    await step('open the decrypted database read-only and run PRAGMA integrity_check', () => {
      const db = new DatabaseSync(restoredDbPath, { readOnly: true });
      try {
        const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
        if (integrity !== 'ok') throw new Error(`integrity check reported: ${integrity}`);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const totalRows = tables.reduce((sum, t) => {
          const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get().n;
          return sum + n;
        }, 0);
        return `integrity ok, ${tables.length} tables, ${totalRows} total rows`;
      } finally {
        closeQuietly(db);
      }
    });

    await step('compare restored row counts against the live database (informational)', () => {
      const livePath = path.join(ROOT, 'data', 'dashboard.db');
      if (!fs.existsSync(livePath)) return 'live database not present, nothing to compare';
      const live = new DatabaseSync(livePath, { readOnly: true });
      const restored = new DatabaseSync(restoredDbPath, { readOnly: true });
      try {
        const tables = live.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
        let diffCount = 0;
        for (const t of tables) {
          const liveN = live.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n;
          let restoredN;
          try { restoredN = restored.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n; } catch { restoredN = null; }
          if (restoredN !== null && restoredN !== liveN) diffCount += 1;
        }
        return `${diffCount} of ${tables.length} tables differ from live (expected — the backup predates now)`;
      } finally {
        closeQuietly(live); closeQuietly(restored);
      }
    });
  } else {
    problems.push('no OneDrive backup available; database restore steps skipped');
  }

  // ---- 3. the whole thing, actually running --------------------------------------------------
  if (restoredDbPath && fs.existsSync(path.join(codeDir, 'server', 'index.js'))) {
    await step('start the cloned server against the restored database and confirm it answers HTTP', () => {
      const port = 34521 + Math.floor(Math.random() * 500);
      const child = spawn(process.execPath, [path.join(codeDir, 'server', 'index.js')], {
        cwd: codeDir,
        env: { ...process.env, PORT: String(port), MC_DB_PATH: restoredDbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const deadline = Date.now() + 15000;
      return new Promise((resolve, reject) => {
        let settled = false;
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          reject(new Error(`server process exited (code ${code}) before answering. Last output:\n${out.slice(-800)}`));
        });
        const tryFetch = () => {
          if (settled) return;
          const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
            res.resume();
            if (settled) return;
            settled = true;
            child.kill();
            resolve(`responded ${res.statusCode} on port ${port} within drill`);
          });
          req.on('error', () => {
            if (settled) return;
            if (Date.now() > deadline) {
              settled = true;
              child.kill();
              reject(new Error(`no response before timeout. Last output:\n${out.slice(-800)}`));
            } else {
              setTimeout(tryFetch, 500);
            }
          });
          req.end();
        };
        setTimeout(tryFetch, 800);
      });
    });
  } else {
    problems.push('server smoke-test skipped: missing restored database or server entrypoint in the clone');
  }

  // ---- 4. report ------------------------------------------------------------------------------
  console.log('\n=== WHAT A REAL DRILL STILL NEEDS (this script cannot prove these) ===');
  console.log('1. A SECOND PHYSICAL DEVICE. This drill ran on the same disk, same OS, same Node');
  console.log('   install as production. It proves the ARTIFACTS (GitHub clone + OneDrive backup)');
  console.log('   are sufficient in principle; it cannot prove availability on hardware it never');
  console.log('   touched.');
  console.log('2. THE PASSPHRASE, reachable from that second device. data/backup-key.txt is');
  console.log('   gitignored and lives only on this disk. If this disk is the thing that is gone,');
  console.log('   the passphrase must already be somewhere else (password manager, paper) —');
  console.log('   this script read it from this disk and cannot verify a second copy exists.');
  console.log('3. NETWORK ACCESS to github.com and OneDrive on that device, and the OneDrive');
  console.log('   account signed in there (not just the folder synced on this machine).');
  console.log('4. NODE.JS installed on that device — this repo pins no engine version; whatever');
  console.log(`   is closest to ${process.version} is the tested target.`);
  console.log('5. THE SCHEDULED TASK that runs scripts/backup.js nightly is Windows-Task-Scheduler');
  console.log('   config on THIS machine and is not itself backed up anywhere; recreating it on a');
  console.log('   replacement machine is a manual step, not a restore.');
  console.log('6. WORK ON A BRANCH THAT IS NOT PUSHED, or files that are staged/untracked, are NOT');
  console.log('   in the GitHub clone by construction — step 2 above checks for this on every run');
  console.log('   and fails loudly if this checkout has tracked files GitHub does not.');

  console.log('\n=== RESULT ===');
  console.log(`${steps.filter((s) => s.ok).length}/${steps.length} steps passed.`);
  if (problems.length) {
    console.log('PROBLEMS:');
    problems.forEach((p) => console.log(`  - ${p}`));
  }
  try { fs.rmSync(drillRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  if (problems.length) {
    console.log('\nFAIL disaster-recovery-drill: see PROBLEMS above.');
    process.exitCode = 1;
  } else {
    console.log('\nPASS disaster-recovery-drill: code cloned from GitHub, database decrypted from the');
    console.log('OneDrive-synced folder, and the restored server answered HTTP — using only the two');
    console.log('off-machine sources. The six items above are NOT proven and need a genuinely');
    console.log('separate device to close.');
  }
}

main().catch((e) => {
  console.error('FAIL disaster-recovery-drill: unexpected error: ' + (e.stack || e.message));
  process.exitCode = 1;
});
