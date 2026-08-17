const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = 14;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'dashboard.db');
if (!fs.existsSync(dbPath)) {
  console.log('No database file yet, nothing to back up.');
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `dashboard-${timestamp}.db`);

// VACUUM INTO produces a single-file, fully consistent snapshot regardless
// of WAL journal state — safer than copying the .db/-wal/-shm files directly.
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
db.close();
console.log(`Backup written: ${backupPath}`);

const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
for (const file of fs.readdirSync(BACKUP_DIR)) {
  if (!file.startsWith('dashboard-') || !file.endsWith('.db')) continue;
  const filePath = path.join(BACKUP_DIR, file);
  if (fs.statSync(filePath).mtimeMs < cutoff) {
    fs.unlinkSync(filePath);
    console.log(`Pruned old backup: ${file}`);
  }
}
