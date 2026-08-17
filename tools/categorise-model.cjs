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
'use strict';

const db = require('../server/db');
require('../server/routes/finance');

const MODEL = process.env.PROBE_MODEL || 'qwen3.5:9b';
const HOST = 'http://127.0.0.1:11434';
const BATCH = 25;            // measured: 25 in one call is ~11s; 25 calls would be minutes

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

async function ask(rows) {
  const list = rows.map((r, i) => {
    const dir = r.amount_pence >= 0 ? 'money in' : 'money out';
    const desc = [r.counterparty, r.reference].filter(Boolean).join(' / ');
    return `${i}. [${dir}, ${r.type}] ${desc}`;
  }).join('\n');

  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      system: SYSTEM,
      prompt: `Categorise these ${rows.length} transactions:\n${list}`,
      stream: false,
      think: false,
      format: SCHEMA,
      options: { temperature: 0 },   // same import twice must give the same suggestions
    }),
  });

  const body = await res.json();
  if (body.error) throw new Error(body.error);
  const parsed = JSON.parse(body.response).results;
  if (!Array.isArray(parsed)) throw new Error('results was not an array');
  return parsed;
}

async function main() {
  const APPLY = process.argv.includes('--apply');

  // Ollama is a desktop app that will sometimes not be running. That must degrade to
  // "not categorised, do it yourself", never to a crash or a silent partial write.
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    console.error(`Ollama is not reachable at ${HOST} (${err.message}).`);
    console.error('Nothing was changed. The ledger keeps its rule-based categories and the');
    console.error('remaining rows stay uncategorised, which is the honest state.');
    process.exit(2);
  }

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

  const suggestions = [];
  const failed = [];
  const t0 = Date.now();

  for (let b = 0; b < rows.length; b += BATCH) {
    const chunk = rows.slice(b, b + BATCH);
    try {
      const out = await ask(chunk);
      const byIdx = new Map(out.map((o) => [Number(o.i), String(o.c)]));
      chunk.forEach((row, i) => {
        const c = byIdx.get(i);
        // A row the model skipped is a MISSING answer, not a wrong one, and must not be
        // silently dropped into "Other" — that would hide a broken batch as a result.
        if (!c) { failed.push({ id: row.id, why: 'no answer for this index' }); return; }
        if (!CATEGORIES.includes(c)) { failed.push({ id: row.id, why: `out-of-vocabulary "${c}"` }); return; }
        suggestions.push({ id: row.id, category: c, cp: row.counterparty });
      });
      process.stdout.write(`  ${Math.min(b + BATCH, rows.length)}/${rows.length}\r`);
    } catch (err) {
      chunk.forEach((row) => failed.push({ id: row.id, why: err.message }));
    }
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
