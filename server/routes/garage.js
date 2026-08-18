const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

// The Garage — the workspace console that used to live on :8688, folded in so there is
// one local service instead of three. Mounted at /garage.
//
// ------------------------------------------------------------------------------------
// THIS IS AN ALLOWLIST, NOT A STATIC MOUNT, AND THAT IS THE WHOLE POINT.
//
// .garage/garage-server.cjs served the ENTIRE workspace root. That was safe there and
// only there, because it bound 127.0.0.1. Mission Control binds 0.0.0.0 on purpose, so
// that the dashboard works from a phone on the LAN — and re-pointing the same root mount
// through this server would have published, unauthenticated, to anything on the network:
//
//   mission-control/data/dashboard.db      the live ledger, 6,839 real bank transactions
//   mission-control/backups/*.db           20 more copies of it, 13 MB in total
//   every CLAUDE.md, every project's source, ~1,116 files within three levels
//
// Nothing about the fold-in required that. The console links to six files. So this route
// serves those six and the two directories they legitimately draw from, and refuses the
// rest — including anything that resolves outside them after normalisation.
// ------------------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..', '..');   // the workspace root

// Exact files the console links to.
const FILES = new Set([
  'index.html',
  'Mini Games/give-way.html',
]);

// Directories those pages may draw assets from. Deliberately narrow: docs/ and the game
// folder, never a project root and never mission-control.
const DIRS = [
  'Mini Games/',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// Blocked regardless of where they sit. A database or a key that ends up inside an
// allowed directory later must not become reachable just because the directory was.
const BLOCKED_EXT = /\.(db|db-wal|db-shm|sqlite|sqlite3|env|key|pem|pfx|p12)$/i;

function resolveAllowed(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  // Normalise BEFORE testing membership, or "Mini Games/../mission-control/data/x.db"
  // passes a prefix check and then resolves somewhere else entirely.
  const abs = path.resolve(ROOT, rel);
  const norm = path.relative(ROOT, abs).split(path.sep).join('/');

  if (norm.startsWith('..') || path.isAbsolute(norm)) return null;   // escaped the root
  if (BLOCKED_EXT.test(norm)) return null;
  if (FILES.has(norm)) return abs;
  if (DIRS.some((d) => norm.startsWith(d))) return abs;
  return null;
}

const router = express.Router();

// Express 4 here, not 5: the wildcard is '*' and the capture is req.params[0]. The v5
// form ('/*splat') silently matches NOTHING rather than erroring, so every path 404s —
// including the ones that should serve, which is what made it look like a path bug.
router.get('*', (req, res) => {
  const file = resolveAllowed(req.params[0] || '/');

  if (!file) {
    // Say it is not served rather than pretending it does not exist — a flat 404 here
    // would send me hunting for a missing file that is present and deliberately refused.
    return res.status(404).type('text/plain')
      .send('Not served. The Garage route is an allowlist: the workspace console and Mini\n'
        + 'Games only. The telemetry pages it used to borrow from Oxford AutoWorks were\n'
        + 'dropped on 18 Aug — this workspace parses its own sessions now, and the\n'
        + 'Oxford-rooted copy was attributing 0 edited files to every one of them.\n\n'
        + 'This server listens on 0.0.0.0, so it must never mount the workspace root — the\n'
        + 'finance ledger and its backups live under it. See server/routes/garage.js.\n');
  }

  fs.stat(file, (serr, st) => {
    const target = !serr && st.isDirectory() ? path.join(file, 'index.html') : file;
    fs.readFile(target, (err, data) => {
      if (err) return res.status(404).type('text/plain').send('not found');
      res.setHeader('content-type', MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      res.send(data);
    });
  });
});

module.exports = router;
module.exports.resolveAllowed = resolveAllowed;
module.exports.ROOT = ROOT;
