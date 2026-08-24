'use strict';
//
// suno.js — Suno Ground Control: a workflow tracker for prompt drafting and take
// review, NOT an embed of suno.com and NOT auto-generation. The owner always
// clicks generate on suno.com himself; this module is the staging area (prompt
// library + per-take queue + credit rollup) that cuts round-trip friction, not a
// control room. There is no Suno API — nothing here polls, scrapes, or embeds
// suno.com, and nothing ever will without the owner explicitly asking for it.
//
// SCHEMA (v1, converged across 4 council reviews + verifier gate pass — see
// kanban task t_2170f0e0 / t_bcd09b43 for the full reasoning).
//
//   prompts       — the reusable text you paste into suno.com. Editable in
//                    place; no versioning in v1.
//   queue_items   — one row PER TAKE, not per submission. Suno returns several
//                    takes per generation, and collapsing them to one row per
//                    submission would make "which prompts actually worked"
//                    uncomputable later without a rebuild. status tracks where
//                    the take is in the workflow; outcome is the ONLY field
//                    that turns week one into evidence for the pay/don't-pay
//                    decision rather than just an activity log — it is
//                    deliberately separate from status because a take can be
//                    "published" and still turn out "unusable" in hindsight.
//
// CREDIT TRACKING — one owner per figure (workspace rule). There is no
// separate credit-budget/ledger table: "credits used today" is always
// SUM(queue_items.credits_spent) scoped to today, computed here and only
// here. A panel that recomputed it would agree until one of the two drifted,
// and then disagree without either erroring.
//
// ENDPOINTS
//   GET    /api/suno/prompts            — all prompts, each with a derived
//                                          rollup (takes, published/usable, generated)
//   POST   /api/suno/prompts            — create { name, style_text, tags? }
//   PATCH  /api/suno/prompts/:id        — edit in place { name?, style_text?, tags? }
//   DELETE /api/suno/prompts/:id        — refused (409) if queue_items reference it
//   GET    /api/suno/queue              — all queue items, newest first, joined to prompt name
//   POST   /api/suno/queue              — add a take { prompt_id, status?, credits_spent?, notes? }
//   PATCH  /api/suno/queue/:id          — update status/outcome/credits/notes/published_url/
//                                          published_revenue_pence
//   POST   /api/suno/queue/:id/focus/start — start the focus timer on this take, auto-stopping
//                                             any other take's running timer first (see v2 below)
//   POST   /api/suno/queue/:id/focus/stop  — stop this take's running timer, banking elapsed seconds
//   DELETE /api/suno/queue/:id          — remove a queue item
//   GET    /api/suno/summary            — credits used today vs. the daily cap, plus totals
//
// v2 ADDITIONS (kanban t_2b8e1657) — focus_seconds and published_revenue_pence.
//
// focus_seconds/focus_started_at: a take is the unit of effort, same reasoning as
// credits_spent above — one row, one unit. Only ONE timer may run across the whole panel
// at a time (the owner works on one thing at a time); starting a new one stops whichever
// other row is running first, so totals never silently double-count from a forgotten open
// timer. focus_started_at is the ONLY "is a timer running" state — there is no separate
// in-memory flag, so a server restart mid-timer just means the elapsed-so-far is computed
// from the stored timestamp next time start/stop runs, not lost. Tab-close accuracy is
// explicitly best-effort (see suno.js beforeunload comment) — this module does not attempt
// idle detection or background tracking, by design (see task body).
//
// published_revenue_pence: nullable, INTEGER minor units, matching the house convention in
// income.js ("Money is INTEGER pence, always. The unit is in the column name."). Same
// only-settable-when-published gate as published_url, for the same reason: it isn't
// meaningful before then.
//
// THE BOUNDARY THAT MATTERS MOST: this module stores focus_seconds and
// published_revenue_pence as raw numbers and nothing else. It must never compute or
// display a per-hour rate, a total earned, or any effort-to-income ratio — that
// calculation belongs exclusively to the Mission Control Scribe profile (finance/wellbeing
// custody rule, see mission-control/TEAM.md and CLAUDE.md). If you are tempted to add a
// "£/hr" badge here, it belongs on the Scribe's side, not this one.
//
const express = require('express');
const db = require('../db.js');

const router = express.Router();

const STATUSES = ['planned', 'generated', 'rejected', 'published'];
const OUTCOMES = ['usable', 'unusable', 'unreviewed'];

// Owner-supplied estimate of the free-tier daily credit allowance, not fetched
// from anywhere (there is no Suno API). Change this constant if the owner's
// plan or Suno's free tier changes — it is the one place this number lives.
const DAILY_FREE_CREDIT_CAP = 50;

db.migrate('suno', [
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS suno_prompts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        style_text TEXT NOT NULL,
        tags       TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suno_queue_items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id         INTEGER NOT NULL REFERENCES suno_prompts(id),
        status            TEXT NOT NULL DEFAULT 'planned',
        outcome           TEXT NOT NULL DEFAULT 'unreviewed',
        credits_spent     INTEGER NOT NULL DEFAULT 0,
        notes             TEXT,
        published_url     TEXT,
        created_at        TEXT NOT NULL,
        status_changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_suno_queue_prompt ON suno_queue_items(prompt_id);
      CREATE INDEX IF NOT EXISTS idx_suno_queue_created ON suno_queue_items(created_at);
    `);
  },
  (d) => {
    // v2 — focus timer + manual revenue (kanban t_2b8e1657). focus_started_at is nullable:
    // NULL means no timer running on this row, a timestamp means it is running since then.
    // Only one row in the whole table should ever have a non-NULL focus_started_at at once;
    // the /focus/start route enforces that by stopping any other running row first.
    d.exec(`
      ALTER TABLE suno_queue_items ADD COLUMN focus_seconds INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE suno_queue_items ADD COLUMN focus_started_at TEXT;
      ALTER TABLE suno_queue_items ADD COLUMN published_revenue_pence INTEGER;
    `);
  },
]);

const now = () => new Date().toISOString();
// One clock, local time, matching the discipline used elsewhere in this codebase
// (habit-tracker.js, lifestyle.js): UTC midnight names the wrong day for the
// first hour after local midnight during BST, which would misdate "today".
const localToday = () => db.prepare("SELECT date('now','localtime') AS d").get().d;

function rollupByPrompt() {
  // One query, grouped, rather than one query per prompt in a loop — this
  // route can be called with dozens of prompts and each render should not
  // become N+1 queries against the same table.
  const rows = db.prepare(`
    SELECT prompt_id,
           COUNT(*) AS takes,
           SUM(CASE WHEN status != 'planned' THEN 1 ELSE 0 END) AS generated,
           SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
           SUM(CASE WHEN outcome = 'usable' THEN 1 ELSE 0 END) AS usable
      FROM suno_queue_items
     GROUP BY prompt_id
  `).all();
  return new Map(rows.map((r) => [r.prompt_id, r]));
}

router.get('/prompts', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM suno_prompts ORDER BY updated_at DESC').all();
    const rollup = rollupByPrompt();
    const prompts = rows.map((p) => {
      const r = rollup.get(p.id);
      const takes = r ? r.takes : 0;
      return {
        ...p,
        takes,
        generated: r ? r.generated : 0,
        published: r ? r.published : 0,
        usable: r ? r.usable : 0,
        // null, not 0, when there is nothing to compute a rate from — a prompt
        // with zero takes has no success rate, and 0% would read as "tried and
        // failed" rather than "not tried yet".
        success_rate: takes ? Math.round((r.usable / takes) * 100) : null,
      };
    });
    res.json({
      prompts,
      count: prompts.length,
      state: prompts.length === 0
        ? 'No prompts yet. Add one to start staging takes for suno.com.'
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, prompts: [], count: 0 });
  }
});

router.post('/prompts', express.json(), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const styleText = String(b.style_text || '').trim();
  if (!name || !styleText) {
    return res.status(400).json({ error: 'name and style_text are required' });
  }
  const ts = now();
  const info = db.prepare(
    'INSERT INTO suno_prompts (name, style_text, tags, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run(name, styleText, b.tags ? String(b.tags) : null, ts, ts);
  const row = db.prepare('SELECT * FROM suno_prompts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, prompt: { ...row, takes: 0, generated: 0, published: 0, usable: 0, success_rate: null } });
});

router.patch('/prompts/:id', express.json(), (req, res) => {
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM suno_prompts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such prompt' });

  const fields = ['name', 'style_text', 'tags'];
  const set = [];
  const vals = [];
  for (const f of fields) {
    if (b[f] !== undefined) {
      set.push(`${f} = ?`);
      vals.push(b[f] === null ? null : String(b[f]));
    }
  }
  if (!set.length) return res.status(400).json({ error: 'nothing to update' });
  set.push('updated_at = ?');
  vals.push(now());
  vals.push(row.id);
  db.prepare(`UPDATE suno_prompts SET ${set.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true, prompt: db.prepare('SELECT * FROM suno_prompts WHERE id = ?').get(row.id) });
});

router.delete('/prompts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM suno_prompts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such prompt' });
  const inUse = db.prepare('SELECT COUNT(*) n FROM suno_queue_items WHERE prompt_id = ?').get(row.id);
  if (inUse.n > 0) {
    return res.status(409).json({
      error: `cannot delete — ${inUse.n} queue item(s) reference this prompt. `
        + 'Remove or reassign them first, or the per-take history is lost silently.',
    });
  }
  db.prepare('DELETE FROM suno_prompts WHERE id = ?').run(row.id);
  res.json({ ok: true, removed: row.name });
});

router.get('/queue', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT q.*, p.name AS prompt_name, p.style_text AS prompt_style_text
        FROM suno_queue_items q
        JOIN suno_prompts p ON p.id = q.prompt_id
       ORDER BY q.created_at DESC
    `).all();
    res.json({
      items: rows,
      count: rows.length,
      state: rows.length === 0
        ? 'No queue items yet. Add one against a prompt after you generate on suno.com.'
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, items: [], count: 0 });
  }
});

router.post('/queue', express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.prompt_id) return res.status(400).json({ error: 'prompt_id is required' });
  const prompt = db.prepare('SELECT id FROM suno_prompts WHERE id = ?').get(b.prompt_id);
  if (!prompt) return res.status(404).json({ error: 'no such prompt' });

  const status = b.status ? String(b.status) : 'planned';
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const outcome = b.outcome ? String(b.outcome) : 'unreviewed';
  if (!OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` });
  }
  const creditsSpent = Number.isFinite(Number(b.credits_spent)) ? Math.max(0, Math.trunc(Number(b.credits_spent))) : 0;
  const ts = now();
  const info = db.prepare(
    'INSERT INTO suno_queue_items '
    + '(prompt_id, status, outcome, credits_spent, notes, published_url, created_at, status_changed_at) '
    + 'VALUES (?,?,?,?,?,?,?,?)'
  ).run(prompt.id, status, outcome, creditsSpent, b.notes ? String(b.notes) : null,
        b.published_url ? String(b.published_url) : null, ts, ts);
  const row = db.prepare(`
    SELECT q.*, p.name AS prompt_name, p.style_text AS prompt_style_text FROM suno_queue_items q
      JOIN suno_prompts p ON p.id = q.prompt_id WHERE q.id = ?
  `).get(info.lastInsertRowid);
  res.json({ ok: true, item: row });
});

router.patch('/queue/:id', express.json(), (req, res) => {
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM suno_queue_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such queue item' });

  if (b.status !== undefined && !STATUSES.includes(String(b.status))) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  if (b.outcome !== undefined && !OUTCOMES.includes(String(b.outcome))) {
    return res.status(400).json({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` });
  }
  // published_url and published_revenue_pence are only meaningful once status is (or
  // becomes) 'published' — intentionally the only publish-tracking behaviour in v1/v2,
  // not a system.
  const nextStatus = b.status !== undefined ? String(b.status) : row.status;
  if (b.published_url !== undefined && b.published_url && nextStatus !== 'published') {
    return res.status(400).json({ error: "published_url can only be set when status is 'published'" });
  }
  if (b.published_revenue_pence !== undefined && b.published_revenue_pence !== null && nextStatus !== 'published') {
    return res.status(400).json({ error: "published_revenue_pence can only be set when status is 'published'" });
  }

  const set = [];
  const vals = [];
  if (b.status !== undefined) {
    set.push('status = ?'); vals.push(String(b.status));
    set.push('status_changed_at = ?'); vals.push(now());
  }
  if (b.outcome !== undefined) { set.push('outcome = ?'); vals.push(String(b.outcome)); }
  if (b.credits_spent !== undefined) {
    const c = Number(b.credits_spent);
    if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: 'credits_spent must be a non-negative number' });
    set.push('credits_spent = ?'); vals.push(Math.trunc(c));
  }
  if (b.notes !== undefined) { set.push('notes = ?'); vals.push(b.notes === null ? null : String(b.notes)); }
  if (b.published_url !== undefined) { set.push('published_url = ?'); vals.push(b.published_url === null ? null : String(b.published_url)); }
  if (b.published_revenue_pence !== undefined) {
    if (b.published_revenue_pence === null) {
      set.push('published_revenue_pence = ?'); vals.push(null);
    } else {
      const rev = Number(b.published_revenue_pence);
      if (!Number.isFinite(rev) || rev < 0) {
        return res.status(400).json({ error: 'published_revenue_pence must be a non-negative number' });
      }
      set.push('published_revenue_pence = ?'); vals.push(Math.trunc(rev));
    }
  }

  if (!set.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(row.id);
  db.prepare(`UPDATE suno_queue_items SET ${set.join(', ')} WHERE id = ?`).run(...vals);
  const updated = db.prepare(`
    SELECT q.*, p.name AS prompt_name, p.style_text AS prompt_style_text FROM suno_queue_items q
      JOIN suno_prompts p ON p.id = q.prompt_id WHERE q.id = ?
  `).get(row.id);
  res.json({ ok: true, item: updated });
});

router.delete('/queue/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM suno_queue_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such queue item' });
  db.prepare('DELETE FROM suno_queue_items WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// FOCUS TIMER — v2 (kanban t_2b8e1657). Only one row across the whole table may have a
// running timer (non-NULL focus_started_at) at once. /start therefore does two things in
// one place, not two round trips from the client: bank-and-stop whatever else is running,
// then start this row. That ordering is what stops a forgotten-open timer from silently
// double-counting into a second take.
function bankElapsed(row) {
  if (!row.focus_started_at) return row.focus_seconds;
  const startedMs = Date.parse(row.focus_started_at);
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : 0;
  return row.focus_seconds + elapsedSec;
}

router.post('/queue/:id/focus/start', (req, res) => {
  const row = db.prepare('SELECT * FROM suno_queue_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such queue item' });

  // Stop any OTHER row currently running, banking its elapsed time, before starting this
  // one. Deliberately not wrapped with the new start in a single transaction: each write is
  // independently valid and idempotent, and withTransaction refuses nested async work — this
  // stays plain sequential synchronous calls.
  const others = db.prepare('SELECT * FROM suno_queue_items WHERE focus_started_at IS NOT NULL AND id != ?').all(row.id);
  for (const other of others) {
    db.prepare('UPDATE suno_queue_items SET focus_seconds = ?, focus_started_at = NULL WHERE id = ?')
      .run(bankElapsed(other), other.id);
  }

  // Starting an already-running row is a no-op on the timestamp (don't reset progress),
  // but still bank+restart nothing extra since it's the sole runner already.
  if (!row.focus_started_at) {
    db.prepare('UPDATE suno_queue_items SET focus_started_at = ? WHERE id = ?').run(now(), row.id);
  }
  const updated = db.prepare(`
    SELECT q.*, p.name AS prompt_name, p.style_text AS prompt_style_text FROM suno_queue_items q
      JOIN suno_prompts p ON p.id = q.prompt_id WHERE q.id = ?
  `).get(row.id);
  res.json({ ok: true, item: updated, stopped: others.map((o) => o.id) });
});

router.post('/queue/:id/focus/stop', (req, res) => {
  const row = db.prepare('SELECT * FROM suno_queue_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such queue item' });
  if (row.focus_started_at) {
    db.prepare('UPDATE suno_queue_items SET focus_seconds = ?, focus_started_at = NULL WHERE id = ?')
      .run(bankElapsed(row), row.id);
  }
  const updated = db.prepare(`
    SELECT q.*, p.name AS prompt_name, p.style_text AS prompt_style_text FROM suno_queue_items q
      JOIN suno_prompts p ON p.id = q.prompt_id WHERE q.id = ?
  `).get(row.id);
  res.json({ ok: true, item: updated });
});

// The one line of "should I keep going today" — no live polling, no scraping,
// no embedding of suno.com (there is no API). Purely SUM(credits_spent) scoped
// to today against the owner-supplied constant above.
router.get('/summary', (req, res) => {
  try {
    const today = localToday();
    const row = db.prepare(
      "SELECT COALESCE(SUM(credits_spent), 0) AS spent, COUNT(*) AS takes "
      + "FROM suno_queue_items WHERE date(created_at, 'localtime') = ?"
    ).get(today);
    const totals = db.prepare(
      "SELECT COUNT(*) AS total_takes, "
      + "SUM(CASE WHEN outcome = 'usable' THEN 1 ELSE 0 END) AS total_usable, "
      + "SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS total_published "
      + "FROM suno_queue_items"
    ).get();
    res.json({
      today,
      credits_used_today: row.spent,
      daily_free_cap: DAILY_FREE_CREDIT_CAP,
      cap_note: 'Owner-supplied estimate, not fetched — there is no Suno API.',
      takes_today: row.takes,
      over_cap: row.spent > DAILY_FREE_CREDIT_CAP,
      total_takes: totals.total_takes || 0,
      total_usable: totals.total_usable || 0,
      total_published: totals.total_published || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.STATUSES = STATUSES;
module.exports.OUTCOMES = OUTCOMES;
