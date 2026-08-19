// Asks the local model to categorise only what the deterministic rules could not reach.
//
//   node tools/categorise-model.cjs            suggest and report, write nothing
//   node tools/categorise-model.cjs --apply    write suggestions to the review queue
//
// Everything written here is category_source='model', reviewed=0. Nothing is ever
// auto-accepted: the probe measured 20/20 on unambiguous merchants, and 20/20 is not
// 100% on the next 20.
//
// DO NOT ADD BUSINESS CONTEXT TO THE PROMPT. Measured and reproduced twice: naming the
// 3D-printing business dropped the unambiguous set from 20/20 to 16/20 by over-applying
// one category to unrelated merchants. Merchant knowledge belongs in finance_rules.
//
// ROUTES THROUGH tools/ollama-run.cjs, not a direct fetch to 11434 — this used to call the
// Ollama HTTP API straight, which skips server/ollama.js's cloud-privacy gate entirely. This
// script hands the model counterparty/reference text off finance_transactions, which is
// exactly the payload that gate exists to keep off a `-cloud` model. Nothing exploited that
// while MODEL was hardcoded local, but nothing was stopping a later edit from doing so either.
// Also adds the accuracy-floor gate ollama-shift.cjs already had and this script did not: the
// rule-categorised rows already in the ledger are the oracle, scored fresh every run rather
// than trusted from last week's probe number.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('claude');
require('../server/routes/finance');
const { checkAvailable, scoreOracle, askBatched } = require('./ollama-run');

const MODEL = process.env.PROBE_MODEL || 'qwen3.5:9b';
const BATCH = 25;            // measured: 25 in one call is ~11s; 25 calls would be minutes
const ACCURACY_FLOOR = 0.8;  // same floor ollama-shift.cjs uses; not re-derived, just reused

// The model may only answer from the vocabulary the ledger actually has. Read from the
// rules table so the two can never drift apart.
const CATEGORIES = db.prepare('SELECT DISTINCT category FROM finance_rules ORDER BY category')
  .all().map((r) => r.category).concat('Other');

const SYSTEM = `You categorise UK bank transaction descriptors for a personal ledger.
Reply ONLY with JSON: {"results":[{"i":<index>,"c":"<category>"}]}
One category per transaction, from this list, spelled identically:
${CATEGORIES.join(' | ')}
"Other" is the correct answer when the descriptor does not clearly indicate any of the rest.
No prose, no explanation.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, c: { type: 'string', enum: CATEGORIES } },
        required: ['i', 'c'],
      },
    },
  },
  required: ['results'],
};

function buildPrompt(rows) {
  const list = rows.map((r, i) => {
    const dir = r.amount_pence >= 0 ? 'money in' : 'money out';
    const desc = [r.counterparty, r.reference].filter(Boolean).join(' / ');
    return `${i}. [${dir}, ${r.type}] ${desc}`;
  }).join('\n');
  return `Categorise these ${rows.length} transactions:\n${list}`;
}

// Positional index in the prompt (needed so the model does not have to echo a long id back
// correctly) resolved to the row's real id here, so every caller of askBatched keys answers
// the same way regardless of what its own schema calls the index.
function parseResponse(text, chunk) {
  const parsed = JSON.parse(text).results;
  if (!Array.isArray(parsed)) throw new Error('results was not an array');
  const byIdx = new Map(parsed.map((o) => [Number(o.i), String(o.c || '').trim()]));
  const got = new Map();
  const badKeys = [];
  chunk.forEach((row, i) => {
    const c = byIdx.get(i);
    if (!c || !CATEGORIES.includes(c)) { badKeys.push(row.id); return; }
    got.set(String(row.id), c);
  });
  return { got, badKeys };
}

async function main() {
  const APPLY = process.argv.includes('--apply');

  const avail = await checkAvailable();
  if (!avail.up) process.exit(2);

  const rows = db.prepare(
    `SELECT id, counterparty, reference, type, amount_pence
     FROM finance_transactions
     WHERE category IS NULL
     ORDER BY ABS(amount_pence) DESC`      // biggest first: if it stops early, it stopped on the small ones
  ).all();

  if (!rows.length) { console.log('nothing uncategorised. rules covered everything.'); return; }

  console.log(`model        ${MODEL}`);
  console.log(`vocabulary   ${CATEGORIES.length} categories, read from finance_rules`);
  console.log(`to do        ${rows.length} rows the rules could not reach\n`);

  // THE GATE. Rows the RULES already categorised are the oracle — reproducible, not hand
  // labelled, and re-scored every run so a stale probe number never stands in for a live one.
  const oracle = db.prepare(
    `SELECT id, counterparty, reference, type, amount_pence, category AS truth
     FROM finance_transactions
     WHERE category IS NOT NULL AND category_source = 'rule'
     ORDER BY RANDOM() LIMIT 40`
  ).all();

  console.log(`scoring against ${oracle.length} rule-categorised rows before touching anything uncategorised...`);
  const score = await scoreOracle({
    model: MODEL, system: SYSTEM, schema: SCHEMA, oracle, buildPrompt, parseResponse,
    keyOf: (o) => o.id, floor: ACCURACY_FLOOR, batchSize: BATCH,
  });
  if (score.accuracy != null) {
    console.log(`agreement with the rules: ${score.matched}/${score.seen}  ${Math.round(score.accuracy * 100)}%`);
    for (const m of score.misses.slice(0, 5)) console.log(`  id ${m.id}  rule ${m.truth}  model ${m.got}`);
  }
  if (!score.ok) {
    console.log(`\n${score.why}\n`);
    process.exit(1);
  }

  const t0 = Date.now();
  const { answers, failed: batchFailed } = await askBatched({
    model: MODEL, system: SYSTEM, schema: SCHEMA, items: rows, buildPrompt, parseResponse, batchSize: BATCH,
    onBatch: (p) => process.stdout.write(`  ${p.done}/${p.total}\r`),
  });

  const suggestions = [];
  const failed = batchFailed.map((f) => ({ id: f.item && f.item.id ? f.item.id : f.item, why: f.why }));
  for (const row of rows) {
    const c = answers.get(String(row.id));
    if (c) suggestions.push({ id: row.id, category: c, cp: row.counterparty });
  }

  const secs = (Date.now() - t0) / 1000;
  console.log(`\nsuggested    ${suggestions.length}  in ${secs.toFixed(0)}s  (${(secs / rows.length * 1000).toFixed(0)} ms/row)`);
  console.log(`no answer    ${failed.length}${failed.length ? '  <- these stay uncategorised, which is correct' : ''}`);

  const byCat = new Map();
  suggestions.forEach((s) => byCat.set(s.category, (byCat.get(s.category) || 0) + 1));
  console.log('');
  [...byCat].sort((a, b) => b[1] - a[1]).forEach(([c, n]) =>
    console.log(`  ${String(n).padStart(4)}  ${c}`));

  if (failed.length) {
    console.log(`\nNO ANSWER (${failed.length}):`);
    failed.slice(0, 5).forEach((f) => console.log(`  id ${f.id}: ${f.why}`));
  }

  if (!APPLY) { console.log('\nnothing written. re-run with --apply to queue these for review.'); return; }

  db.exec('BEGIN');
  try {
    const upd = db.prepare(
      `UPDATE finance_transactions SET category = ?, category_source = 'model', reviewed = 0
       WHERE id = ? AND category IS NULL`
    );
    let n = 0;
    suggestions.forEach((s) => { n += upd.run(s.category, s.id).changes; });
    db.exec('COMMIT');
    console.log(`\napplied: ${n} suggestions queued for review (category_source='model', reviewed=0)`);
    console.log('none of these are accepted. they are proposals until you say otherwise.');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('FAILED, rolled back:', err.message);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
