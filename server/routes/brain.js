const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

// The memory store is CLAUDE'S, written across sessions, and it is load-bearing — it is
// read at the start of every session. This module therefore READS those files and never
// edits them. Your steer is stored here, in Mission Control's database, and surfaced back
// to Claude through exactly ONE generated file (_flags.md) that only this module writes.
// Two writers on ~100 hand-maintained files with no merge is how a knowledge base rots.
const MEMORY_DIR = process.env.MEMORY_DIR
  || 'C:/Users/jcwhi/.claude/projects/C--Users-jcwhi-Claude-Outputs/memory';

db.migrate('brain', [
  (d) => {
    d.exec(`
      CREATE TABLE brain_flags (
        name       TEXT PRIMARY KEY,     -- the memory's frontmatter slug
        status     TEXT NOT NULL,        -- 'wrong' | 'stale' | 'important'
        note       TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);
  },
]);

const router = express.Router();

// --- reading the store ------------------------------------------------------------
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let inMetadata = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^metadata:/.test(line)) { inMetadata = true; continue; }
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, value] = kv;
    // Strip YAML quoting. Some descriptions are quoted (they contain a colon) and some
    // are not; leaving the quotes in renders half the list with a stray leading ".
    const v = value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (inMetadata && indent.length > 0) meta[key] = v;
    else if (indent.length === 0) { inMetadata = false; meta[key] = v; }
  }
  return { meta, body: m[2] };
}

function readStore() {
  let files;
  try {
    files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== '_flags.md');
  } catch (err) {
    // Could-not-look must never render as found-nothing.
    const e = new Error(`memory directory unreadable at ${MEMORY_DIR}: ${err.message}`);
    e.unreadable = true;
    throw e;
  }

  const flags = new Map(db.prepare('SELECT * FROM brain_flags').all().map((r) => [r.name, r]));

  return files.map((file) => {
    const full = path.join(MEMORY_DIR, file);
    const text = fs.readFileSync(full, 'utf8');
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name || file.replace(/\.md$/, '');
    const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]);
    const f = flags.get(name);
    return {
      name,
      file,
      description: meta.description || '',
      type: meta.type || 'unknown',
      links,
      words: body.trim().split(/\s+/).length,
      // Prefer the frontmatter `modified` stamp over the file's mtime. The mtime records
      // when the FILE was last written, which any bulk edit resets: a consolidation pass
      // on 17 Aug rewrote all 120 memories and left every mtime identical, making "newest"
      // meaningless. The frontmatter stamp is written by the memory system when the
      // MEMORY changes, which is the thing actually being asked about.
      modified: (meta.modified || '').slice(0, 10) || fs.statSync(full).mtime.toISOString().slice(0, 10),
      // Which of the two the date came from, so the caveat can be specific rather than
      // hedging about both cases at once.
      dateFrom: meta.modified ? 'frontmatter' : 'file mtime',
      flag: f ? { status: f.status, note: f.note, updated_at: f.updated_at } : null,
    };
  });
}

// Item 2: "second brain filters — newest". Sorting is applied here rather than in the
// panel so the SAME order is what /api/brain returns to anything else that asks.
//
// `modified` prefers the frontmatter stamp and falls back to file mtime — see readStore.
// The fallback is the weak case and the response says how many rows are on it, because a
// bulk edit resets every mtime at once: after the 17 Aug consolidation all 120 files
// shared one date and "newest" ordered nothing. Measured before and after — 1 distinct
// date on mtime, 3 on the frontmatter stamp.
const SORTS = {
  name: (a, b) => (a.name < b.name ? -1 : 1),
  newest: (a, b) => (a.modified === b.modified ? (a.name < b.name ? -1 : 1) : (a.modified > b.modified ? -1 : 1)),
  oldest: (a, b) => (a.modified === b.modified ? (a.name < b.name ? -1 : 1) : (a.modified < b.modified ? -1 : 1)),
  longest: (a, b) => b.words - a.words,
  linked: (a, b) => b.links.length - a.links.length,
  flagged: (a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0) || (a.name < b.name ? -1 : 1),
};

router.get('/', (req, res) => {
  let store;
  try { store = readStore(); } catch (err) { return res.status(503).json({ error: err.message }); }

  const q = String(req.query.q || '').toLowerCase().trim();
  const type = String(req.query.type || '').trim();
  const flaggedOnly = req.query.flagged === '1';

  let filtered = q
    ? store.filter((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
    : store.slice();
  if (type) filtered = filtered.filter((m) => m.type === type);
  if (flaggedOnly) filtered = filtered.filter((m) => m.flag);

  const sort = SORTS[req.query.sort] ? req.query.sort : 'name';
  filtered.sort(SORTS[sort]);

  // A link to a memory that does not exist is not an error — it marks something worth
  // writing. Reported so it can be seen rather than silently dropped.
  const names = new Set(store.map((m) => m.name));
  const dangling = [...new Set(store.flatMap((m) => m.links).filter((l) => !names.has(l)))];

  const byType = {};
  store.forEach((m) => { byType[m.type] = (byType[m.type] || 0) + 1; });

  res.json({
    dir: MEMORY_DIR,
    total: store.length,
    shown: filtered.length,
    sort,
    sorts: Object.keys(SORTS),
    // Shipped with the data so the panel cannot present "newest" as more than it is.
    sortCaveat: sort === 'newest' || sort === 'oldest'
      ? `Ordered by when each memory was last changed. ${filtered.filter((m) => m.dateFrom === 'file mtime').length} of ${filtered.length} have no frontmatter stamp and fall back to file mtime, which any bulk edit resets.`
      : null,
    byType,
    flagged: store.filter((m) => m.flag).length,
    dangling,
    memories: filtered,
  });
});

router.get('/:name', (req, res) => {
  let store;
  try { store = readStore(); } catch (err) { return res.status(503).json({ error: err.message }); }
  const m = store.find((x) => x.name === req.params.name);
  if (!m) return res.status(404).json({ error: `no memory named "${req.params.name}"` });
  const text = fs.readFileSync(path.join(MEMORY_DIR, m.file), 'utf8');
  res.json({ ...m, markdown: text });
});

// --- steering ---------------------------------------------------------------------
const STATUSES = ['wrong', 'stale', 'important'];

// Regenerated in full every time, from the database. Never appended to, so it cannot
// drift from the flags it is supposed to represent.
function writeFlagsFile() {
  const rows = db.prepare('SELECT * FROM brain_flags ORDER BY status, name').all();
  const file = path.join(MEMORY_DIR, '_flags.md');

  if (!rows.length) { try { fs.unlinkSync(file); } catch { /* nothing to remove */ } return 0; }

  const L = [
    '# Flags on memory — set by the user, via Mission Control',
    '',
    'GENERATED FILE. Written by `mission-control/server/routes/brain.js`; do not hand-edit,',
    'it is rebuilt in full from the database on every change.',
    '',
    'These are the user\'s corrections to memories Claude wrote. **A memory flagged `wrong`',
    'should not be acted on, and should be deleted or rewritten rather than left in place.**',
    '',
  ];
  for (const s of STATUSES) {
    const of = rows.filter((r) => r.status === s);
    if (!of.length) continue;
    L.push(`## ${s}`, '');
    of.forEach((r) => L.push(`- [[${r.name}]]${r.note ? ` — ${r.note}` : ''} _(${r.updated_at})_`));
    L.push('');
  }
  fs.writeFileSync(file, L.join('\n'));
  return rows.length;
}

router.post('/:name/flag', (req, res) => {
  const { status, note } = req.body || {};
  const name = req.params.name;

  if (status !== null && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be null or one of ${STATUSES.join(', ')}` });
  }

  let store;
  try { store = readStore(); } catch (err) { return res.status(503).json({ error: err.message }); }
  if (!store.some((m) => m.name === name)) {
    return res.status(404).json({ error: `no memory named "${name}"` });
  }

  if (status === null) db.prepare('DELETE FROM brain_flags WHERE name = ?').run(name);
  else {
    db.prepare(
      `INSERT INTO brain_flags (name, status, note, updated_at)
       VALUES (?, ?, ?, datetime('now', 'localtime'))
       ON CONFLICT(name) DO UPDATE SET status = excluded.status, note = excluded.note,
         updated_at = excluded.updated_at`
    ).run(name, status, note || null);
  }

  let written;
  try { written = writeFlagsFile(); } catch (err) {
    // The flag is saved but Claude will not see it. Say so — a half-applied steer that
    // reports success is worse than a failure.
    return res.status(500).json({ error: `flag saved to the database but _flags.md could not be written: ${err.message}` });
  }

  res.json({ name, status, note: note || null, flagsFile: `${written} flag(s) written to _flags.md` });
});

module.exports = router;
