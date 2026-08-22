'use strict';
//
// journal.js — voice journal: speak a reflection, it transcribes, tags,
// and stores it. Searchable, private, local.
//
// GET  /api/journal/entries          — list entries (optional ?q=search&limit=20)
// POST /api/journal/entries          — create { text, mood? } -> { id, text, mood, tags, createdAt }
// GET  /api/journal/entries/:id      — get one entry
// DELETE /api/journal/entries/:id    — delete an entry
// GET  /api/journal/stats            — { total, thisWeek, tags: {tag:count} }
//
// Auto-tagging is keyword-based, not model-based — the journal is private
// and the owner's wellbeing is protected by CLAUDE.md. No journal text is
// sent to Ollama or any model. Tags are derived from simple keyword
// matching (work, health, money, game, idea, life, feeling).
const express = require('express');
const router = express.Router();
const db = require('../db');

db.migrate('journal', [
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        text        TEXT NOT NULL,
        mood        TEXT,
        tags        TEXT DEFAULT '[]',
        source      TEXT DEFAULT 'voice',
        created_at  TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);
  },
]);

// Simple keyword-based tagging. No model, no data leaving the machine.
const TAG_RULES = [
  { tag: 'work', words: ['work', 'code', 'bug', 'fix', 'build', 'commit', 'session', 'agent', 'task', 'project'] },
  { tag: 'health', words: ['health', 'sleep', 'tired', 'energy', 'sick', 'doctor', 'walk', 'exercise', 'gym'] },
  { tag: 'money', words: ['money', 'budget', 'spend', 'income', 'cost', 'profit', 'payment', 'fee', 'invoice'] },
  { tag: 'game', words: ['game', 'hollowmast', 'survive', 'play', 'player', 'build', 'craft'] },
  { tag: 'idea', words: ['idea', 'what if', 'spark', 'creative', 'concept', 'maybe', 'could'] },
  { tag: 'life', words: ['life', 'family', 'home', 'house', 'food', 'cook', 'read', 'watch'] },
  { tag: 'feeling', words: ['feel', 'happy', 'sad', 'stressed', 'calm', 'excited', 'worried', 'good', 'bad', 'great'] },
];

function autoTag(text) {
  const lower = String(text).toLowerCase();
  const tags = [];
  for (const rule of TAG_RULES) {
    if (rule.words.some((w) => lower.includes(w))) tags.push(rule.tag);
  }
  return tags.length ? tags : ['untagged'];
}

// List entries
router.get('/entries', (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const q = String(req.query.q || '').trim();

  let rows;
  if (q) {
    rows = db.prepare(
      `SELECT * FROM journal_entries WHERE text LIKE '%' || ? || '%' ORDER BY created_at DESC LIMIT ?`
    ).all(q, limit);
  } else {
    rows = db.prepare(
      'SELECT * FROM journal_entries ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  }

  res.json({
    entries: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') })),
  });
});

// Create entry
router.post('/entries', (req, res) => {
  const text = String(req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Missing "text".' });
  const mood = String(req.body.mood || '').trim() || null;
  const tags = JSON.stringify(autoTag(text));
  const source = String(req.body.source || 'voice');

  const result = db.prepare(
    'INSERT INTO journal_entries (text, mood, tags, source) VALUES (?, ?, ?, ?)'
  ).run(text, mood, tags, source);

  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...entry, tags: JSON.parse(entry.tags || '[]') });
});

// Get one entry
router.get('/entries/:id', (req, res) => {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ ...entry, tags: JSON.parse(entry.tags || '[]') });
});

// Delete entry
router.delete('/entries/:id', (req, res) => {
  const result = db.prepare('DELETE FROM journal_entries WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ deleted: true, id: Number(req.params.id) });
});

// Stats
router.get('/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM journal_entries').get().n;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const thisWeek = db.prepare(
    "SELECT COUNT(*) as n FROM journal_entries WHERE created_at >= ?"
  ).get(weekAgo).n;

  // Tag counts
  const allTags = {};
  for (const row of db.prepare('SELECT tags FROM journal_entries').all()) {
    for (const t of JSON.parse(row.tags || '[]')) {
      allTags[t] = (allTags[t] || 0) + 1;
    }
  }

  res.json({ total, thisWeek, tags: allTags });
});

module.exports = router;