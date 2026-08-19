'use strict';
//
// ollama-run.cjs — the ONE place every Ollama-offloaded job in this workspace runs through.
//
//   const { checkAvailable, scoreOracle, askBatched } = require('./ollama-run.cjs');
//
// Four callers had each reimplemented a version of this by hand — ollama-shift.cjs,
// categorise-model.cjs, classify-senders.cjs — with real drift between them. This centralises
// the parts CLAUDE.md and ARCHITECTURE.md already state as fixed policy, so a new caller gets
// them for free instead of re-deriving them, and an existing one cannot quietly drop one.
//
// THE FIX THIS FILE IS ACTUALLY FOR. `categorise-model.cjs` and `classify-senders.cjs` both
// called `fetch('http://127.0.0.1:11434/api/generate', ...)` directly. server/ollama.js's
// ask() is the ONE place the cloud-privacy gate lives — the check that a payload naming
// finance, health or wellbeing data never reaches a `-cloud` model, even though cloud and
// local are served from the same 127.0.0.1 endpoint and look identical in a URL or a log line.
// A direct fetch skips that gate entirely. Nothing exploited this today — both callers
// hardcode a local model — but categorise-model.cjs processes finance_transactions
// counterparty/reference text, and classify-senders.cjs processes mail sender addresses:
// exactly the payloads the gate exists for. A later edit that swapped either to a `-cloud`
// model for speed would have sent that data off this machine with nothing to stop it. Routing
// every call through server/ollama.js's ask() closes that structurally, rather than trusting
// every future caller to remember to check.
//
// WHAT THIS DOES NOT DO. It does not decide whether a task should be offloaded at all — that
// is offload-router.cjs's job, against ARCHITECTURE.md's policy. It does not choose write
// semantics: some callers stage a suggestion for review (category_source='model', reviewed=0);
// ollama-shift.cjs applies its tail directly, because a `kind` mismatch is a one-UPDATE undo.
// That stays with the caller — it depends on what the column means, which this module cannot
// know.
require('./_run-log.cjs').record();

const ollama = require('../server/ollama');

// ---------------------------------------------------------------------------------- 1. degrade
// Every caller gets the SAME failure shape. Ollama is a desktop app that will sometimes not be
// running, and that must degrade to "not categorised, do it yourself" — never a crash, and
// never a silent partial result that looks complete.
async function checkAvailable() {
  const a = await ollama.available();
  if (!a.up) {
    console.log(`  Ollama is not reachable (${a.why}).`);
    console.log('  Nothing was changed. This degrades to "not categorised, do it yourself" —');
    console.log('  the honest state, not a failure this tool tries to hide.');
  }
  return a;
}

// ---------------------------------------------------------------------------------- 2. askBatched
// Chunk items, call through server/ollama.js's ask() — NEVER a direct fetch to 11434 — and let
// the caller parse its own response shape, because the three existing callers do not agree on
// one (some key answers by the item's own id, some by position in the batch). What is
// centralised is the loop, the timeout/batch defaults, the ollama.ask() call itself (so the
// privacy gate is always in the path), and uniform bookkeeping of what failed and why.
//
//   buildPrompt(chunk) -> string                           the user-turn text for this batch
//   parseResponse(text, chunk) -> { got: Map(key, value), badKeys: [key, ...] }
//
// Returns { answers: Map(key, value), failed: [{ item, why }] }. A batch Ollama could not
// reach or could not parse fails EVERY item in it explicitly, rather than silently skipping —
// absence and failure must not look the same, here as everywhere else in this workspace.
async function askBatched({
  model, system, schema, items, buildPrompt, parseResponse,
  batchSize = 25, timeoutMs = 300000, onBatch,
}) {
  const answers = new Map();
  const failed = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const r = await ollama.ask({ model, system, user: buildPrompt(chunk), schema, timeoutMs });

    if (!r.ok) {
      chunk.forEach((item) => failed.push({ item, why: r.refused ? `REFUSED: ${r.why}` : r.why }));
      if (onBatch) onBatch({ done: Math.min(i + batchSize, items.length), total: items.length, ok: false, why: r.why });
      // A refusal is a policy decision, not a flaky batch — retrying it would not change the
      // answer, and continuing to the next batch could still be useful for the rest.
      continue;
    }

    let parsed;
    try { parsed = parseResponse(r.text, chunk); }
    catch (e) { parsed = { got: new Map(), badKeys: [] }; chunk.forEach((item) => failed.push({ item, why: `unparseable response: ${String(e.message || e).slice(0, 90)}` })); }

    for (const [k, v] of parsed.got) answers.set(k, v);
    for (const k of parsed.badKeys) {
      const item = chunk.find((c) => String(c.id ?? c.i) === String(k));
      failed.push({ item: item || k, why: 'out of vocabulary or unanswered' });
    }

    if (onBatch) onBatch({ done: Math.min(i + batchSize, items.length), total: items.length, ok: true });
  }

  return { answers, failed };
}

// ------------------------------------------------------------------------------------ 3. the gate
// Score the model against items whose truth is ALREADY known — a rule-derived oracle, never
// hand-labelled data (inventing labels by hand would make the author the thing being tested).
// RE-MEASURED EVERY RUN, not trusted from a historical probe result: a model swap, a prompt
// edit, or the model simply not being warmed can all move accuracy, and a cached number from
// last week's probe would not know it moved. This is the discipline ollama-shift.cjs already
// had and the other two callers did not.
async function scoreOracle({
  model, system, schema, oracle, buildPrompt, parseResponse, keyOf,
  floor = 0.8, batchSize = 25, timeoutMs = 300000,
}) {
  if (!oracle.length) {
    return { ok: false, accuracy: null, seen: 0, matched: 0, misses: [], floor, why: 'NO ORACLE: nothing to score against, so nothing is written — a broken run, not a clean one' };
  }

  const { answers } = await askBatched({ model, system, schema, items: oracle, buildPrompt, parseResponse, batchSize, timeoutMs });

  let matched = 0; let seen = 0;
  const misses = [];
  for (const o of oracle) {
    const got = answers.get(String(keyOf(o)));
    if (got == null) continue;
    seen += 1;
    if (got === o.truth) matched += 1;
    else misses.push({ id: keyOf(o), truth: o.truth, got });
  }

  if (!seen) {
    return { ok: false, accuracy: null, seen: 0, matched: 0, misses: [], floor, why: 'THE MODEL ANSWERED NOTHING on the oracle — a failure to look, not a score of zero' };
  }

  const accuracy = matched / seen;
  return {
    ok: accuracy >= floor, accuracy, seen, matched, misses, floor,
    why: accuracy >= floor ? null
      : `BELOW THE FLOOR (${Math.round(floor * 100)}%): a model that cannot reproduce answers a rule already knows is not trusted on the ones nobody knows`,
  };
}

module.exports = { checkAvailable, askBatched, scoreOracle };
