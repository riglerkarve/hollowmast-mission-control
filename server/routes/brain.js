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
  // Backlog #M2, 18 Aug 2026: "make sure the second brain is storing more than just
  // memories". Measured first, and the request is right — every one of the 132 files in
  // the store is a lesson CLAUDE wrote after getting something wrong. The `type` field
  // (feedback 91, project 21, reference 19) distinguishes what KIND of lesson, not what
  // kind of thing, and the 19 'reference' entries are facts about tooling, not resources.
  // `user` has zero entries because there has never been a way for the owner to write one:
  // the only write path in this module was POST /:name/flag.
  //
  // STORED HERE RATHER THAN AS .md FILES IN THE MEMORY DIRECTORY, and that follows the rule
  // already stated at the top of this file rather than overriding it. The store is
  // hand-maintained across sessions with no merge; a second writer is how it rots. So the
  // owner's entries live in Mission Control's own database and reach Claude through ONE
  // generated file this module owns, exactly as flags already do.
  (d) => {
    d.exec(`
      CREATE TABLE brain_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slug       TEXT NOT NULL UNIQUE,   -- so [[slug]] can point at it like any memory
        title      TEXT NOT NULL,
        kind       TEXT NOT NULL,          -- 'note' | 'reference' | 'decision'
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX idx_brain_notes_kind ON brain_notes(kind);
    `);
  },
]);

const NOTE_KINDS = ['note', 'reference', 'decision'];

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
    // Generated files are excluded BY PREFIX, not by name. The original list named
    // '_flags.md' explicitly, so adding _notes.md (#M2) immediately made it appear as a
    // 133rd "memory" with type 'unknown' — a file this module writes, counted as something
    // Claude learned. Any future generated file would have repeated it.
    files = fs.readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('_'));
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
      // Kept only in process while handling a local search. It is deliberately stripped
      // before the list response: searching a memory body should find a memory, not turn
      // the index endpoint into another way to download every memory body.
      searchText: `${name}\n${meta.description || ''}\n${body}`.toLowerCase(),
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

  let filtered = q ? store.map((memory) => {
    const matchedFields = [];
    if (memory.name.toLowerCase().includes(q)) matchedFields.push('name');
    if (memory.description.toLowerCase().includes(q)) matchedFields.push('description');
    // `searchText` contains the body only in memory, and is removed below. The result says
    // THAT a body matched without exposing the sentence that matched it.
    if (memory.searchText.includes(q) && !matchedFields.length) matchedFields.push('body');
    return { ...memory, matchedFields };
  }).filter((memory) => memory.matchedFields.length) : store.slice();
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
    searchScope: q ? 'Matched locally against memory name, description and body. Body text is not returned by this index.' : null,
    memories: filtered.map(({ searchText, ...memory }) => memory),
  });
});

// NOTE: `GET /:name` is deliberately registered at the BOTTOM of this file, not here.
// Express matches in registration order, so a catch-all parameter route placed above the
// specific ones swallows them: with it here, GET /api/brain/notes resolved as a memory
// named "notes" and answered 404. Caught while adding the notes routes (#M2). Anything
// specific added later must also go above it.

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

// ---------------------------------------------------------------------------- your notes
// Backlog #M2. Everything above this line is Claude's. Everything below it is yours.

const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function uniqueSlug(base, ignoreId) {
  const root = base || 'note';
  for (let n = 0; n < 200; n += 1) {
    const slug = n ? `${root}-${n + 1}` : root;
    const clash = db.prepare('SELECT id FROM brain_notes WHERE slug = ?').get(slug);
    if (!clash || clash.id === ignoreId) return slug;
  }
  return `${root}-${Date.now()}`;
}

// Rebuilt IN FULL from the database on every change, never appended to, so it cannot drift
// from what it represents. Same contract as _flags.md — one writer, one direction.
function writeNotesFile() {
  const rows = db.prepare('SELECT * FROM brain_notes ORDER BY kind, updated_at DESC').all();
  const file = path.join(MEMORY_DIR, '_notes.md');

  if (!rows.length) { try { fs.unlinkSync(file); } catch { /* nothing to remove */ } return 0; }

  const L = [
    '# The owner\'s own entries — written by them, via Mission Control',
    '',
    'GENERATED FILE. Written by `mission-control/server/routes/brain.js`; do not hand-edit,',
    'it is rebuilt in full from the database on every change.',
    '',
    'Everything else in this directory was written by Claude — lessons learned from getting',
    'something wrong. **These were written by the user.** They are not lessons and were not',
    'inferred from anything; they are what the owner wanted kept. Treat them as instruction',
    'and fact, not as observation.',
    '',
  ];
  for (const kind of NOTE_KINDS) {
    const of = rows.filter((r) => r.kind === kind);
    if (!of.length) continue;
    L.push(`## ${kind}`, '');
    for (const r of of) {
      L.push(`### ${r.title}  _([[${r.slug}]], updated ${r.updated_at})_`, '', r.body.trim(), '');
    }
  }
  fs.writeFileSync(file, L.join('\n'));
  return rows.length;
}

// Backlinks across BOTH sides of the store. This is the derivation that makes an entry more
// than a text box: writing [[a-cap-is-a-biased-sample]] in a note makes that note visible
// FROM the memory, which is the direction you cannot get by reading the file you wrote.
// Nothing computed backlinks before — only outbound links were ever shown.
function linkGraph(store) {
  const notes = db.prepare('SELECT slug, title, body FROM brain_notes').all();

  const nodes = [
    ...store.map((m) => ({ id: m.name, kind: 'memory', links: m.links })),
    ...notes.map((n) => ({
      id: n.slug,
      kind: 'note',
      links: [...String(n.body).matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]),
    })),
  ];

  const backlinks = new Map();
  for (const n of nodes) {
    for (const target of new Set(n.links)) {
      if (!backlinks.has(target)) backlinks.set(target, []);
      backlinks.get(target).push({ from: n.id, kind: n.kind });
    }
  }
  return { nodes, backlinks };
}

router.get('/notes', (req, res) => {
  const rows = db.prepare('SELECT * FROM brain_notes ORDER BY updated_at DESC').all();
  let reaches = null;
  try { reaches = fs.existsSync(path.join(MEMORY_DIR, '_notes.md')); } catch { reaches = null; }

  res.json({
    notes: rows,
    kinds: NOTE_KINDS,
    byKind: NOTE_KINDS.reduce((a, k) => ({ ...a, [k]: rows.filter((r) => r.kind === k).length }), {}),
    // Three states, not two: written and confirmed on disk / none written / could not look.
    reachesClaude: reaches,
    reachesNote: reaches === null
      ? 'Could not check whether the generated file exists — that is a failure to look.'
      : reaches
        ? 'Written to _notes.md in the memory directory, which Claude reads alongside its own.'
        : 'Nothing written yet, so no file exists. It appears with your first entry.',
  });
});

router.post('/notes', express.json(), (req, res) => {
  const title = String((req.body && req.body.title) || '').trim();
  const body = String((req.body && req.body.body) || '').trim();
  const kind = String((req.body && req.body.kind) || 'note').trim();

  if (!title) return res.status(400).json({ error: 'a title is required' });
  if (!body) return res.status(400).json({ error: 'a body is required — a title alone is not worth keeping' });
  if (!NOTE_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${NOTE_KINDS.join(', ')}` });
  }

  const slug = uniqueSlug(slugify(title));
  const info = db.prepare(
    'INSERT INTO brain_notes (slug, title, kind, body) VALUES (?, ?, ?, ?)'
  ).run(slug, title, kind, body);

  const written = writeNotesFile();
  res.status(201).json({ id: Number(info.lastInsertRowid), slug, written });
});

router.patch('/notes/:id', express.json(), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM brain_notes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'no such note' });

  const title = req.body && req.body.title !== undefined ? String(req.body.title).trim() : row.title;
  const body = req.body && req.body.body !== undefined ? String(req.body.body).trim() : row.body;
  const kind = req.body && req.body.kind !== undefined ? String(req.body.kind).trim() : row.kind;

  if (!title || !body) return res.status(400).json({ error: 'title and body cannot be emptied' });
  if (!NOTE_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${NOTE_KINDS.join(', ')}` });
  }

  // The slug only moves if the title does, because anything that already wrote [[slug]]
  // is pointing at this row and a silent rename would break those links with no error.
  const slug = title === row.title ? row.slug : uniqueSlug(slugify(title), id);

  db.prepare(
    `UPDATE brain_notes SET title = ?, body = ?, kind = ?, slug = ?,
            updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(title, body, kind, slug, id);

  writeNotesFile();
  res.json({ id, slug, renamed: slug !== row.slug });
});

router.delete('/notes/:id', (req, res) => {
  const r = db.prepare('DELETE FROM brain_notes WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such note' });
  const written = writeNotesFile();
  res.json({ deleted: Number(req.params.id), remaining: written });
});

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

// --- the catch-all, LAST ------------------------------------------------------------
// Must stay the final GET registered. It matches any single path segment, so every
// specific route has to be declared above it or Express never reaches them.
router.get('/:name', (req, res) => {
  let store;
  try { store = readStore(); } catch (err) { return res.status(503).json({ error: err.message }); }
  const m = store.find((x) => x.name === req.params.name);
  if (!m) return res.status(404).json({ error: `no memory named "${req.params.name}"` });
  const text = fs.readFileSync(path.join(MEMORY_DIR, m.file), 'utf8');

  // Backlinks: what points AT this memory, from Claude's own store and from the owner's
  // notes alike. The store has always exposed outbound links; nothing computed the reverse
  // direction, which is the half you cannot get by reading the file in front of you.
  const { backlinks } = linkGraph(store);
  res.json({
    ...m,
    markdown: text,
    backlinks: backlinks.get(m.name) || [],
  });
});

module.exports = router;
