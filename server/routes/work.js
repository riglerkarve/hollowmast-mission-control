// Work — hand a prompt over and walk away.
//
// Backlog M43. This is the first real consumer of tools/offload-router.cjs: it does not
// decide anything about models itself, it asks route(task) and honours the answer, refusals
// included. There is deliberately no second routing rule anywhere in this file.
//
// FOUR THINGS THIS MODULE REFUSES TO DO, and each is why a line of it looks the way it does:
//
//   1. It never auto-applies. A result is text you read. Nothing here writes to another
//      module's tables, and there is no "apply" endpoint to add later without noticing.
//   2. It never silently downgrades. The Express process holds no frontier credential and
//      cannot get one from a conversation, so a frontier job WAITS for a session rather than
//      quietly running on the local model. A local answer delivered where a frontier one was
//      asked for is the worst outcome available here, because it looks like success.
//   3. It never guesses the classification. route() keys on lowStakes / reviewable /
//      outputConstrained and on the four NEVER flags, and only the person writing the prompt
//      knows those. Defaults are all false, which routes to frontier — the tier that waits.
//      A default of "low stakes" would be the flattering one and would run everything.
//   4. It records the model and tier PER ITEM. "Which model answered this" is exactly the
//      question you ask when an answer looks wrong, and it is unrecoverable afterwards.
'use strict';

const express = require('express');
const db = require('../db');
const { route } = require('../../tools/offload-router.cjs');

db.migrate('work', [
  (d) => {
    d.exec(`
      CREATE TABLE work_items (
        id            INTEGER PRIMARY KEY,
        prompt        TEXT NOT NULL,
        title         TEXT,
        -- what the submitter said about the task; route() reads these and nothing else
        flags         TEXT NOT NULL DEFAULT '{}',
        tier          TEXT NOT NULL,
        -- queued | waiting_session | running | done | failed | refused | cancelled
        -- 'failed' and 'done' with an empty result must never look the same, so failure
        -- carries its own status AND an error string.
        status        TEXT NOT NULL,
        router_note   TEXT,
        router_reason TEXT,
        model         TEXT,
        result        TEXT,
        error         TEXT,
        tokens        INTEGER,
        ms            INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        started_at    TEXT,
        finished_at   TEXT
      );
      CREATE INDEX work_items_status ON work_items (status, id);
    `);
  },
]);

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'qwen3.5:9b';

const router = express.Router();

// ------------------------------------------------------------------ submitting
router.post('/items', express.json(), (req, res) => {
  const prompt = String((req.body && req.body.prompt) || '').trim();
  if (!prompt) return res.status(400).json({ error: 'a prompt is required' });
  const title = String((req.body && req.body.title) || '').trim() || prompt.slice(0, 60);

  // Only the seven keys route() reads are kept. Anything else a caller sends is discarded
  // rather than stored, so nothing can later be mistaken for part of the routing decision.
  const f = (req.body && req.body.flags) || {};
  const flags = {
    lowStakes: !!f.lowStakes,
    reviewable: !!f.reviewable,
    outputConstrained: !!f.outputConstrained,
    highVolume: !!f.highVolume,
    producesNumbers: !!f.producesNumbers,
    autoApplied: !!f.autoApplied,
    assertsFactAboutCode: !!f.assertsFactAboutCode,
    module: String(f.module || ''),
  };

  const decision = route(flags);
  // A refusal is a first-class outcome that is STORED and shown with its reason. Dropping the
  // job on the floor would make the policy invisible and unarguable, which is how policies
  // get worked around instead of understood.
  const status = decision.tier === 'refuse' ? 'refused'
    : decision.tier === 'frontier' ? 'waiting_session'
      : decision.tier === 'local' ? 'queued'
        : 'refused';   // 'rules' means no model is needed at all — see the note below

  const routerNote = decision.tier === 'rules'
    ? 'A deterministic answer exists, so no model should do this. Write the rule instead. '
      + decision.note
    : decision.note;

  const info = db.prepare(
    `INSERT INTO work_items (prompt, title, flags, tier, status, router_note, router_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(prompt, title, JSON.stringify(flags), decision.tier, status, routerNote,
    (decision.reasons || []).join(' '));

  res.status(201).json({ id: info.lastInsertRowid, tier: decision.tier, status, decision });
});

// ------------------------------------------------------------------ reading
router.get('/items', (req, res) => {
  const rows = db.prepare(
    `SELECT id, title, prompt, tier, status, model, result, error, tokens, ms,
            router_note, router_reason, created_at, started_at, finished_at
     FROM work_items ORDER BY id DESC LIMIT 60`
  ).all();

  const counts = {};
  db.prepare('SELECT status, COUNT(*) AS n FROM work_items GROUP BY status')
    .all().forEach((r) => { counts[r.status] = r.n; });

  // Whether the local tier can run AT ALL is a fact about this machine, not about the queue,
  // and it is reported separately so an empty queue and a dead Ollama never look alike.
  res.json({
    items: rows.map((r) => ({ ...r, flags: undefined })),
    counts,
    note: 'Nothing here is applied anywhere. A result is text to read.',
    frontierNote: 'Frontier jobs wait for a session. This server holds no frontier credential '
      + 'and will not run them on the local model instead.',
  });
});

router.post('/items/:id/cancel', (req, res) => {
  const row = db.prepare('SELECT status FROM work_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such item' });
  if (['done', 'failed', 'refused'].includes(row.status)) {
    return res.status(409).json({ error: `already ${row.status}` });
  }
  db.prepare("UPDATE work_items SET status = 'cancelled', finished_at = datetime('now','localtime') WHERE id = ?")
    .run(req.params.id);
  res.json({ id: Number(req.params.id), status: 'cancelled' });
});

// ------------------------------------------------------------------ the runner
// Called from the daily briefing pass, and by POST /run. NOT a scheduled task of its own:
// five already exist and each one added is another thing that can silently stop.
//
// Writes RESULTS PER ITEM, never once at the end. A run killed halfway must leave every
// finished item finished — a batch that only writes at the end loses everything it did.
async function runQueued({ limit = 5 } = {}) {
  const rows = db.prepare("SELECT id, prompt FROM work_items WHERE status = 'queued' ORDER BY id LIMIT ?")
    .all(limit);
  const out = { attempted: rows.length, done: 0, failed: 0, unreachable: false };
  if (!rows.length) return out;

  for (const row of rows) {
    // Re-read the status: it may have been cancelled since the list was taken.
    const now = db.prepare('SELECT status FROM work_items WHERE id = ?').get(row.id);
    if (!now || now.status !== 'queued') continue;

    db.prepare("UPDATE work_items SET status = 'running', started_at = datetime('now','localtime'), model = ? WHERE id = ?")
      .run(MODEL, row.id);
    const t0 = Date.now();
    try {
      const r = await fetch(`${OLLAMA}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: row.prompt,
          stream: false,
          // think:false is load-bearing. A thinking model under a strict schema returned an
          // EMPTY response with done_reason 'stop', which reads as "unreachable" and is not.
          think: false,
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) throw new Error(`ollama ${r.status}`);
      const b = await r.json();
      const text = String(b.response || '').trim();
      if (!text) throw new Error(`ollama answered with an empty response (done_reason ${b.done_reason || '?'})`);
      db.prepare(
        `UPDATE work_items SET status = 'done', result = ?, tokens = ?, ms = ?,
         finished_at = datetime('now','localtime') WHERE id = ?`
      ).run(text, (b.eval_count || 0) + (b.prompt_eval_count || 0), Date.now() - t0, row.id);
      out.done += 1;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (/ECONNREFUSED|fetch failed/i.test(msg)) out.unreachable = true;
      // Back to 'queued' if the machine simply was not running Ollama — that is not a failed
      // job, it is a job that has not had its chance yet. A real error stays failed.
      db.prepare(
        `UPDATE work_items SET status = ?, error = ?, ms = ?, finished_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(out.unreachable ? 'queued' : 'failed', msg.slice(0, 300), Date.now() - t0, row.id);
      if (!out.unreachable) out.failed += 1;
    }
  }
  return out;
}

router.post('/run', express.json(), async (req, res) => {
  const r = await runQueued({ limit: Number((req.body && req.body.limit) || 5) });
  res.json(r);
});

module.exports = router;
module.exports.runQueued = runQueued;
