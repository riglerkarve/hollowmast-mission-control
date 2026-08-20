//
// inbox.js — unified agent inbox for Mission Control.
//
// A single thread-based message store so you and the agents (Claude, Codex, Ollama,
// Hermes, Scribe) can leave messages for each other in one place. The owner posts as
// 'you'; agents post under their own name via /reply. Threads group messages by topic
// (default 'general') so a conversation about one thing stays findable later.
//
// The table is created here on first request — CREATE TABLE IF NOT EXISTS — following the
// same db.migrate() pattern board.js and todo.js use. No modification to db.js or index.js
// is needed; the route owns its own schema the way every other module does.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

db.migrate('inbox', [
  (d) => {
    d.exec(`
      CREATE TABLE inbox_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id  TEXT NOT NULL DEFAULT 'general',
        from_agent TEXT NOT NULL,
        to_agent   TEXT NOT NULL,
        text       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_thread ON inbox_messages(thread_id, id);
      CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_messages(created_at);
    `);
  },
]);

// Rows from node:sqlite arrive as null-prototype objects; spread them before JSON.
const plain = (r) => ({ ...r });

// Valid agent names for from_agent / to_agent. 'you' is the owner; 'all' is a broadcast
// target (only valid as to_agent, not from_agent). This is a closed vocabulary — a typo
// as a sender would be a message no agent ever sees, the same call todo.js made for owners.
const SENDERS = ['you', 'claude', 'codex', 'ollama', 'hermes', 'scribe'];
const RECIPIENTS = ['you', 'claude', 'codex', 'ollama', 'hermes', 'scribe', 'all'];

function validSender(s) { return SENDERS.includes(String(s || '').toLowerCase()); }
function validRecipient(s) { return RECIPIENTS.includes(String(s || '').toLowerCase()); }

// POST /api/inbox/send — body: { to: 'claude'|'codex'|'all'|..., text: '...' }
// Creates a message from 'you' to the named recipient. Returns the created message.
router.post('/send', express.json(), (req, res) => {
  const to = String((req.body && req.body.to) || 'all').toLowerCase();
  const text = String((req.body && req.body.text) || '').trim();
  const threadId = String((req.body && req.body.threadId) || 'general').trim() || 'general';

  if (!validRecipient(to)) return res.status(400).json({ error: `Unknown recipient: ${to}` });
  if (!text) return res.status(400).json({ error: 'Message text is required.' });

  const info = db.prepare(
    `INSERT INTO inbox_messages (thread_id, from_agent, to_agent, text) VALUES (?, 'you', ?, ?)`
  ).run(threadId, to, text);

  const row = db.prepare(`SELECT * FROM inbox_messages WHERE id = ?`).get(info.lastInsertRowid);
  res.json({
    id: row.id,
    threadId: row.thread_id,
    from: row.from_agent,
    to: row.to_agent,
    text: row.text,
    createdAt: row.created_at,
  });
});

// GET /api/inbox/thread?threadId=general — returns all messages in a thread.
router.get('/thread', (req, res) => {
  const threadId = String(req.query.threadId || 'general').trim() || 'general';
  const rows = db.prepare(
    `SELECT id, from_agent, to_agent, text, created_at
       FROM inbox_messages
      WHERE thread_id = ?
      ORDER BY id ASC`
  ).all(threadId).map(plain);

  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      from: r.from_agent,
      to: r.to_agent,
      text: r.text,
      createdAt: r.created_at,
    })),
  });
});

// GET /api/inbox/threads — returns a summary of all threads.
router.get('/threads', (req, res) => {
  const rows = db.prepare(
    `SELECT thread_id AS id,
            (SELECT text FROM inbox_messages sub WHERE sub.thread_id = im.thread_id ORDER BY id DESC LIMIT 1) AS last_message,
            MAX(created_at) AS last_at,
            COUNT(*) AS count
       FROM inbox_messages im
      GROUP BY thread_id
      ORDER BY MAX(id) DESC`
  ).all().map(plain);

  res.json({
    threads: rows.map((r) => ({
      id: r.id,
      lastMessage: r.last_message,
      lastAt: r.last_at,
      count: r.count,
    })),
  });
});

// POST /api/inbox/reply — body: { threadId, from, text }
// An agent posts a reply into an existing thread. Returns the created message.
router.post('/reply', express.json(), (req, res) => {
  const threadId = String((req.body && req.body.threadId) || 'general').trim() || 'general';
  const from = String((req.body && req.body.from) || '').toLowerCase();
  const to = String((req.body && req.body.to) || 'you').toLowerCase();
  const text = String((req.body && req.body.text) || '').trim();

  if (!validSender(from)) return res.status(400).json({ error: `Unknown sender: ${from}` });
  if (!validRecipient(to)) return res.status(400).json({ error: `Unknown recipient: ${to}` });
  if (!text) return res.status(400).json({ error: 'Message text is required.' });

  const info = db.prepare(
    `INSERT INTO inbox_messages (thread_id, from_agent, to_agent, text) VALUES (?, ?, ?, ?)`
  ).run(threadId, from, to, text);

  const row = db.prepare(`SELECT * FROM inbox_messages WHERE id = ?`).get(info.lastInsertRowid);
  res.json({
    id: row.id,
    threadId: row.thread_id,
    from: row.from_agent,
    to: row.to_agent,
    text: row.text,
    createdAt: row.created_at,
  });
});

// DELETE /api/inbox/:id — delete a single message.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id.' });

  const info = db.prepare(`DELETE FROM inbox_messages WHERE id = ?`).run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Message not found.' });
  res.json({ ok: true, id });
});

// Exported so activity.js can call the same query directly instead of reading
// inbox_messages itself — the module contract's "call the API", without a loopback
// HTTP round-trip to this same process.
function recentMessages(hours) {
  return db.prepare(`
    SELECT from_agent, to_agent, text, created_at, thread_id
      FROM inbox_messages
     WHERE datetime(created_at) >= datetime('now','localtime', ?)
     ORDER BY created_at DESC
     LIMIT 50
  `).all(`-${hours} hours`);
}

module.exports = router;
module.exports.recentMessages = recentMessages;