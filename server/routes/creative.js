'use strict';
//
// creative.js — idea capture, prompt generation, and the MindVirus OS
// creative engine.
//
// GET  /api/creative/ideas          — list all captured ideas
// POST /api/creative/ideas          — capture a new idea { text, tags[] }
// GET  /api/creative/ideas/:id      — get one idea with development
// POST /api/creative/ideas/:id/develop — develop an idea into a structured
//   concept { angle } -> returns { angle, hook, platforms, tags, nextSteps }
// POST /api/creative/prompts        — generate a prompt from a theme
//   { theme } -> { prompts: [{ text, angle, platform }] }
// GET  /api/creative/spark          — a random creative spark to start from
//
// This is M126. The owner's framing: "MindVirus OS" — a system that
// captures ideas before they evaporate, develops them into something
// actionable, and routes the good ones to the board.
//
// The prompt generator uses Ollama (local, free, private) to turn a theme
// into 5 concrete content angles. It does NOT send any finance or
// wellbeing data — it's a pure creativity tool.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const router = express.Router();

// --- database ---
const db = require('../db');

db.migrate('creative', [
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS creative_ideas (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        text        TEXT NOT NULL,
        tags        TEXT DEFAULT '[]',
        source      TEXT DEFAULT 'manual',
        developed   INTEGER DEFAULT 0,
        spark       TEXT,
        created_at  TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS creative_developments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id     INTEGER NOT NULL,
        angle       TEXT NOT NULL,
        hook        TEXT,
        platforms   TEXT DEFAULT '[]',
        next_steps  TEXT DEFAULT '[]',
        created_at  TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (idea_id) REFERENCES creative_ideas(id)
      );
    `);
  },
  // M129 shipped without an idempotence guard, and it cost a duplicate: creative
  // idea #8 was promoted on 20 Aug and again on 22 Aug, producing M157 and M270 --
  // identical in every field but created_at. M270 was closed as a duplicate on
  // 23 Aug and this is the cause being fixed rather than the symptom.
  //
  // The old code set `developed = 1` on promote, but `developed` is ALSO what
  // /develop sets, so the two states were collapsed into one boolean and neither
  // could be read as "already promoted". This adds the column that can be, and
  // records WHICH item the idea became, so the panel can link idea to work and a
  // second promote has something to refuse against.
  (d) => {
    d.exec('ALTER TABLE creative_ideas ADD COLUMN promoted_item_id TEXT');
    // Backfill DERIVED from the rows themselves rather than typed: every board
    // item promoted from an idea carries "Promoted from creative idea #N." in its
    // rationale. Earliest wins, which is the same survivor rule used when M270 was
    // Declined rows are excluded: a closed duplicate must never win the
    // earliest-wins race. Without this a fresh database could backfill onto the
    // very row that was closed FOR being a duplicate, which is the same bug one
    // level down and would look perfectly reasonable in the data.
    // closed into M157 -- so the two agree by construction rather than by luck.
    d.exec(`
      UPDATE creative_ideas SET promoted_item_id = (
        SELECT t.id FROM todo_items t
         WHERE t.rationale LIKE 'Promoted from creative idea #' || creative_ideas.id || '.%'
           AND t.status <> 'declined'
         ORDER BY t.created_at ASC LIMIT 1
      ) WHERE promoted_item_id IS NULL
    `);
  },
]);

// --- helpers ---
const TAGS = ['game', 'content', 'business', 'life', 'wild', 'tech', 'art'];

// Random creative sparks — seeds for when the owner has no idea yet.
const SPARKS = [
  { text: 'What if your game had a mode where the player is the world, not the survivor?', tags: ['game', 'wild'] },
  { text: 'A YouTube series where you build something live and explain the mistakes, not the result.', tags: ['content'] },
  { text: 'What product would you make if you could only sell to 100 people?', tags: ['business'] },
  { text: 'What if Mission Control had a "dream mode" that showed what your system looks like in 5 years?', tags: ['tech', 'art'] },
  { text: 'A newsletter about things you almost built but didn\'t, and why.', tags: ['content', 'wild'] },
  { text: 'What if the voice panel could narrate your day as a story?', tags: ['tech', 'art'] },
  { text: 'A physical product: a desk toy that represents your current project state.', tags: ['business', 'art'] },
  { text: 'What if HOLLOWMAST had a real-world component — a physical item players interact with?', tags: ['game', 'wild'] },
  { text: 'A tool that turns your board backlog into a strategy game where you "play" your priorities.', tags: ['tech', 'game'] },
  { text: 'What if you streamed the AI agents working, live, as a show?', tags: ['content', 'tech'] },
  { text: 'A coffee blend branded to each project. HOLLOWMAST dark roast, PrintProfit light roast.', tags: ['business', 'wild'] },
  { text: 'What if wellbeing was a garden you tend in the dashboard, not a journal you write?', tags: ['art', 'life'] },
  { text: 'A "what if" generator: take any two projects and combine them into one idea.', tags: ['wild'] },
  { text: 'What if the morning briefing was a podcast, automatically generated?', tags: ['content', 'tech'] },
  { text: 'A merch line: HOLLOWMAST survival gear, PrintProfit 3D-printed objects, Mission Control stickers.', tags: ['business'] },
  { text: 'What if you taught a 4B model to write in your voice, then let it draft your content?', tags: ['tech', 'content'] },
  { text: 'A community challenge: build something in 24 hours using only Mission Control and one AI agent.', tags: ['content', 'wild'] },
  { text: 'What if the dashboard had a "serendipity" panel that showed one unexpected connection per day?', tags: ['tech', 'art'] },
  { text: 'A physical zine: printed monthly, containing the best handovers and decisions from the team.', tags: ['content', 'art'] },
  { text: 'What if you made a game about running an AI agent team — a sim of your own workspace?', tags: ['game', 'wild'] },
];

// --- routes ---

// List all ideas
router.get('/ideas', (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const rows = db.prepare(
    'SELECT * FROM creative_ideas ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
  res.json({
    ideas: rows.map((r) => ({
      ...r, tags: JSON.parse(r.tags || '[]'),
    })),
  });
});

// Get one idea with its developments
router.get('/ideas/:id', (req, res) => {
  const idea = db.prepare('SELECT * FROM creative_ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });
  const dev = db.prepare(
    'SELECT * FROM creative_developments WHERE idea_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);
  res.json({
    ...idea,
    tags: JSON.parse(idea.tags || '[]'),
    developments: dev.map((d) => ({
      ...d, platforms: JSON.parse(d.platforms || '[]'),
      nextSteps: JSON.parse(d.next_steps || '[]'),
    })),
  });
});

// Capture a new idea
router.post('/ideas', (req, res) => {
  const text = String(req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Missing "text".' });
  const tags = JSON.stringify(
    (req.body.tags || []).filter((t) => TAGS.includes(t))
  );
  const source = String(req.body.source || 'manual');
  const result = db.prepare(
    'INSERT INTO creative_ideas (text, tags, source) VALUES (?, ?, ?)'
  ).run(text, tags, source);
  const idea = db.prepare('SELECT * FROM creative_ideas WHERE id = ?').get(result.lastInsertRowid);
  res.json({
    ...idea, tags: JSON.parse(idea.tags || '[]'),
  });
});

// Get a random spark
router.get('/spark', (req, res) => {
  const i = Math.floor(Math.random() * SPARKS.length);
  res.json(SPARKS[i]);
});

// Develop an idea — use Ollama to turn a raw idea into a structured concept
router.post('/ideas/:id/develop', async (req, res) => {
  const idea = db.prepare('SELECT * FROM creative_ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });

  const angle = String(req.body && req.body.angle || 'general').trim();

  // Try to use Ollama for development
  let development;
  try {
    const ollama = require('../ollama');
    const prompt = `You are a creative strategist. Take this idea: "${idea.text}".
Develop it from this angle: "${angle}".
Return a JSON object with:
- hook: a one-sentence pitch (max 100 chars)
- platforms: array of 2-3 platforms (youtube, blog, twitter, instagram, tiktok, newsletter, product, game)
- nextSteps: array of 3 concrete next steps (max 80 chars each)
Return ONLY the JSON, no preamble.`;

    const response = await ollama.ask({
      model: 'qwen3.5:4b',
      user: prompt,
      schema: {
        type: 'object',
        properties: {
          hook: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string' } },
          nextSteps: { type: 'array', items: { type: 'string' } },
        },
        required: ['hook', 'platforms', 'nextSteps'],
      },
      timeoutMs: 30000,
    });

    if (!response || !response.ok || !response.text) throw new Error('Ollama returned no content');
    const parsed = JSON.parse(response.text);
    development = {
      angle,
      hook: String(parsed.hook || '').slice(0, 200),
      platforms: Array.isArray(parsed.platforms) ? parsed.platforms.slice(0, 5) : [],
      nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.slice(0, 5) : [],
    };
  } catch (err) {
    // Fallback: generate a development without Ollama
    development = {
      angle,
      hook: `${idea.text.slice(0, 80)} — ${angle} angle`,
      platforms: ['blog', 'youtube', 'twitter'],
      nextSteps: [
        'Write a one-page outline',
        'Identify the audience for this angle',
        'Draft the first version in 30 minutes',
      ],
      fallback: true,
    };
  }

  // Save the development
  const result = db.prepare(
    'INSERT INTO creative_developments (idea_id, angle, hook, platforms, next_steps) VALUES (?, ?, ?, ?, ?)'
  ).run(
    req.params.id, development.angle, development.hook,
    JSON.stringify(development.platforms), JSON.stringify(development.nextSteps)
  );

  // Mark idea as developed
  db.prepare('UPDATE creative_ideas SET developed = 1, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(req.params.id);

  res.json({
    id: result.lastInsertRowid,
    idea_id: Number(req.params.id),
    ...development,
  });
});

// Generate prompts from a theme — use Ollama
router.post('/prompts', async (req, res) => {
  const theme = String(req.body && req.body.theme || '').trim();
  if (!theme) return res.status(400).json({ error: 'Missing "theme".' });

  try {
    const ollama = require('../ollama');
    const prompt = `You are a creative prompt generator. The theme is: "${theme}".
Generate 5 creative content prompts, each from a different angle.
Return a JSON array of objects with:
- text: the prompt (max 200 chars)
- angle: the angle (how-to, story, opinion, experiment, resource)
- platform: best platform (youtube, blog, twitter, newsletter, tiktok)
Return ONLY the JSON array.`;

    const response = await ollama.ask({
      model: 'qwen3.5:4b',
      user: prompt,
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            angle: { type: 'string' },
            platform: { type: 'string' },
          },
          required: ['text', 'angle', 'platform'],
        },
      },
      timeoutMs: 30000,
    });

    if (!response || !response.ok || !response.text) throw new Error('Ollama returned no content');
    const prompts = JSON.parse(response.text);
    if (!Array.isArray(prompts)) throw new Error('Expected array');
    res.json({ prompts: prompts.slice(0, 5) });
  } catch (err) {
    // Fallback prompts
    res.json({
      prompts: [
        { text: `How to start with ${theme} when you have nothing`, angle: 'how-to', platform: 'youtube' },
        { text: `The one thing nobody tells you about ${theme}`, angle: 'opinion', platform: 'twitter' },
        { text: `I tried ${theme} for 30 days — here's what happened`, angle: 'story', platform: 'blog' },
        { text: `5 tools that make ${theme} easier`, angle: 'resource', platform: 'newsletter' },
        { text: `What if ${theme} worked completely differently?`, angle: 'experiment', platform: 'tiktok' },
      ],
      fallback: true,
      error: err.message,
    });
  }
});

// Promote a developed idea to the board as a backlog item (M129)
router.post('/ideas/:id/promote', async (req, res) => {
  const idea = db.prepare('SELECT * FROM creative_ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });

  // IDEMPOTENT. Promoting twice used to create a second board row every time,
  // silently, because nothing here read any flag on the way in -- see the
  // migration note above. 409 rather than 200 so a caller cannot mistake a
  // refusal for a success, and the existing item id comes back so the UI can go
  // there instead of guessing.
  if (idea.promoted_item_id) {
    return res.status(409).json({
      error: 'Already promoted to the board.',
      alreadyPromoted: true,
      boardItemId: idea.promoted_item_id,
      ideaId: Number(req.params.id),
    });
  }

  // Get the latest development for the idea, if any
  const dev = db.prepare(
    'SELECT * FROM creative_developments WHERE idea_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.params.id);

  // Build the backlog item title from the idea + development hook
  const title = dev
    ? `${idea.text.slice(0, 60)} — ${dev.hook || dev.angle}`
    : idea.text;

  // Determine project from tags
  const tagToProject = {
    'game': 'HOLLOWMAST',
    'content': 'PrintProfit',
    'business': 'Mission Control',
    'tech': 'Mission Control',
    'art': 'Mission Control',
    'life': null,
    'wild': null,
  };
  const tags = JSON.parse(idea.tags || '[]');
  const project = tagToProject[tags[0]] || null;
  const kind = tags.includes('business') ? 'feature' : tags.includes('content') ? 'feature' : 'feature';

  try {
    const r = await fetch('http://127.0.0.1:3000/api/todo/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: String(title).slice(0, 200),
        cluster: 'Creative',
        priority: req.body.priority || 'P2',
        owner: 'YOU',
        project,
        kind,
        rationale: `Promoted from creative idea #${idea.id}. Source: ${idea.source}.`,
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return res.status(500).json({ error: 'Board creation failed: ' + (e.error || r.status) });
    }
    const d = await r.json();
    // Mark the idea as promoted
    // Record WHICH item it became, not merely that it happened. That is what the
    // guard above reads, and it is why a second promote can now name the row the
    // caller should be looking at instead of quietly making another one.
    db.prepare(
      'UPDATE creative_ideas SET developed = 1, promoted_item_id = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?'
    ).run(d.item && d.item.id ? String(d.item.id) : null, req.params.id);
    res.json({
      promoted: true,
      boardItem: d.item,
      ideaId: Number(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach board API: ' + err.message });
  }
});

module.exports = router;