//
// backup.js — nightly snapshot of the database AND of the repository's history.
//
// WHAT WAS WRONG WITH THE PREVIOUS VERSION, measured 18 Aug 2026:
//
//   33 database backups, all written to mission-control/backups/ — INSIDE the directory tree
//   being backed up. Losing or deleting the project folder took the database and all 33 of its
//   backups together, which is the one failure a backup exists to survive.
//
//   And nothing backed up the CODE at all. 101 commits, no git remote, no bundle, no mirror
//   anywhere on the disk: every line of Mission Control's history existed in exactly one place.
//   The whole history bundles to 724 KB, so this was never a cost problem.
//
// SO IT NOW WRITES TO SEVERAL DESTINATIONS and treats them independently. The in-tree location
// is kept — it is convenient and the scheduled task's behaviour is unchanged — but it is no
// longer the only one.
//
// THE HONEST LIMIT, stated because a backup people trust wrongly is worse than none: every
// destination here is on the SAME PHYSICAL DISK. `Get-CimInstance Win32_LogicalDisk` reports
// exactly one fixed drive (C:). This survives deleting the project folder. It does NOT survive
// the disk failing. Only an off-machine copy does that, and that needs an account, which is the
// owner's decision — set MC_BACKUP_EXTRA to a synced folder and this will use it.
//
// A BACKUP THAT REPORTS SUCCESS WHILE WRITING NOWHERE IS THE WORST OUTCOME, so destinations are
// counted rather than assumed: if every one fails, this exits non-zero and says so. And the
// bundle is VERIFIED with `git bundle verify` rather than merely written, because a truncated
// bundle is a file of the right name and the wrong contents, and nobody checks a backup until
// they need it.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RETENTION_DAYS = 14;

// In-tree first (unchanged behaviour), then out-of-tree, then anything the owner nominates.
const DESTS = [
  { dir: path.join(ROOT, 'backups'), label: 'in-tree (convenient, dies with the folder)' },
  { dir: path.join(ROOT, '..', '..', 'MissionControl-Backups'), label: 'out-of-tree (survives losing the project folder)' },
];
if (process.env.MC_BACKUP_EXTRA) {
  DESTS.push({ dir: process.env.MC_BACKUP_EXTRA, label: 'MC_BACKUP_EXTRA (off-machine if that folder syncs)' });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dbPath = path.join(DATA_DIR, 'dashboard.db');

let dbOk = 0;
let bundleOk = 0;
const problems = [];

// ---- 1. the database -------------------------------------------------------------------
if (!fs.existsSync(dbPath)) {
  console.log('No database file yet, nothing to back up.');
} else {
  for (const d of DESTS) {
    try {
      fs.mkdirSync(d.dir, { recursive: true });
      const out = path.join(d.dir, `dashboard-${stamp}.db`);
      // VACUUM INTO produces a single-file, fully consistent snapshot regardless of WAL
      // journal state — safer than copying the .db/-wal/-shm files directly.
      const db = new DatabaseSync(dbPath);
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      db.close();
      const mb = (fs.statSync(out).size / 1048576).toFixed(1);
      console.log(`  db      ${mb} MB -> ${out}`);
      dbOk += 1;
    } catch (e) {
      problems.push(`db to ${d.dir}: ${e.message}`);
    }
  }
}

// ---- 2. the repository's history ---------------------------------------------------------
// A bundle is a single file containing every commit, branch and tag. `git clone <file>` on it
// reconstructs the repository, so this is a real substitute for a remote for recovery purposes
// — it just cannot be pushed to.
let haveGit = true;
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'pipe' });
} catch {
  haveGit = false;
  problems.push('not a git repository, so no history was captured');
}

if (haveGit) {
  for (const d of DESTS) {
    const out = path.join(d.dir, `mission-control-${stamp}.bundle`);
    try {
      fs.mkdirSync(d.dir, { recursive: true });
      execFileSync('git', ['bundle', 'create', out, '--all'], { cwd: ROOT, stdio: 'pipe' });
      // Verify rather than trust. A truncated or partial bundle is a plausible-looking file.
      execFileSync('git', ['bundle', 'verify', out], { cwd: ROOT, stdio: 'pipe' });
      const kb = Math.round(fs.statSync(out).size / 1024);
      console.log(`  history ${kb} KB -> ${out}  (verified)`);
      bundleOk += 1;
    } catch (e) {
      // Remove a bundle that failed verification: a bad backup left in place is worse than a
      // missing one, because the missing one is obvious.
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch { /* nothing else to do */ }
      problems.push(`bundle to ${d.dir}: ${String(e.message).split('\n')[0]}`);
    }
  }
}

// ---- 3. prune, per destination ------------------------------------------------------------
const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
let pruned = 0;
for (const d of DESTS) {
  let files;
  try { files = fs.readdirSync(d.dir); } catch { continue; }
  for (const file of files) {
    const isDb = file.startsWith('dashboard-') && file.endsWith('.db');
    const isBundle = file.startsWith('mission-control-') && file.endsWith('.bundle');
    if (!isDb && !isBundle) continue;
    const p = path.join(d.dir, file);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); pruned += 1; }
    } catch (e) {
      problems.push(`prune ${file}: ${e.message}`);
    }
  }
}

// ---- 4. say what happened, and fail loudly if nothing landed ------------------------------
console.log(`\n  destinations: ${DESTS.length}   db copies: ${dbOk}   history copies: ${bundleOk}   pruned: ${pruned}`);
for (const d of DESTS) console.log(`    - ${d.dir}  ${d.label}`);
if (problems.length) {
  console.log('\n  PROBLEMS:');
  problems.forEach((p) => console.log(`    ${p}`));
}
console.log('\n  All destinations are on the same physical disk. This survives losing the project');
console.log('  folder; it does not survive the disk failing. Set MC_BACKUP_EXTRA to a synced');
console.log('  folder, or give the repository a remote, for that.');

if (fs.existsSync(dbPath) && dbOk === 0) {
  console.log('\n  NOTHING WAS BACKED UP. Exiting non-zero so this cannot pass silently.');
  process.exitCode = 1;
} else if (haveGit && bundleOk === 0) {
  console.log('\n  The database was saved but NO history was captured. Exiting non-zero.');
  process.exitCode = 1;
}
