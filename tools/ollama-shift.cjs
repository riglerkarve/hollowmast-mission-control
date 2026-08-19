#!/usr/bin/env node
//
// ollama-shift.cjs — put the local model to work on the backlog's `kind` field.
//
//   node tools/ollama-shift.cjs             measure and report, write nothing
//   node tools/ollama-shift.cjs --apply     write the answers it earned the right to write
//   node tools/ollama-shift.cjs --cloud     use gpt-oss:20b-cloud instead of qwen3.5:9b
//
// THE JOB. 33 open backlog items have no `kind`, and `kind` is an input to server/dispatch.js —
// a bug with a known cause routes differently from an investigation. So filling it improves
// routing rather than decorating a row, which is the difference between this and a chore.
//
// It fits the offload gates properly: low-stakes (a wrong kind changes a routing hint, never a
// figure), reviewable (it shows on the board), structurally constrained (four values), and
// reversible in one UPDATE.
//
// RULES FIRST, MODEL FOR THE TAIL — the order this project's own measurement demands. On the
// real categorisation job, deterministic rules did 95.3% and the model 4.7%. So a rule runs
// first, and it does double duty: the items the rule CAN settle become the ORACLE the model is
// scored against. There was no labelled data for `kind` at all, and inventing labels by hand
// would have made me the thing being tested.
//
// THE MODEL DOES NOT GET TO WRITE UNLESS IT EARNS IT. If it disagrees with the rule on the
// oracle more than ACCURACY_FLOOR allows, nothing is written and the run says so. A model that
// cannot reproduce answers a regex already knows is not one to trust on the answers nobody
// knows.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');
const ollama = require('../server/ollama');

const APPLY = process.argv.includes('--apply');
const USE_CLOUD = process.argv.includes('--cloud');
const MODEL = process.argv.find((a) => /^--model=/.test(a))?.split('=')[1]
  || (USE_CLOUD ? 'gpt-oss:20b-cloud' : ollama.LOCAL_DEFAULT);
const BATCH = 10;
const ACCURACY_FLOOR = 0.8;

const KINDS = ['bug', 'feature', 'chore', 'question'];

// The deterministic half. Narrow on purpose: a pattern that matches half the backlog is not a
// rule, it is noise with a regex around it. Anything it cannot settle returns null and goes to
// the model, which is the whole point of having one.
function byRule(item) {
  const t = `${item.title || ''}`.toLowerCase();
  if (/\bdoes not|is not|cannot|fails|broken|wrong|silently|incorrect|regress|leak\b/.test(t)) return 'bug';
  if (/^(add|build|create|implement|expand|introduce) /.test(t)) return 'feature';
  if (/\b(investigate|research|decide|which|whether|should we|\?)\b/.test(t)) return 'question';
  if (/\b(rename|tidy|update the doc|consolidate|archive|clean up|move the)\b/.test(t)) return 'chore';
  return null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, kind: { type: 'string', enum: KINDS } },
        required: ['id', 'kind'],
      },
    },
  },
  required: ['answers'],
};

const SYSTEM = 'You label work items. bug = something behaves wrongly now. feature = something new to build. '
  + 'chore = upkeep with no behaviour change. question = a decision or investigation with no agreed answer yet. '
  + 'Answer with the id and one label. Do not explain.';

async function askBatch(items) {
  const list = items.map((r) => `${r.id}: ${r.title}`).join('\n');
  const r = await ollama.ask({ model: MODEL, system: SYSTEM, user: list, schema: SCHEMA, timeoutMs: 300000 });
  if (!r.ok) return { fail: r };
  try { return { answers: JSON.parse(r.text).answers || [], ms: r.ms }; }
  catch { return { fail: { why: `unparseable JSON: ${String(r.text).slice(0, 70)}` } }; }
}

(async () => {
  // THE ORACLE IS THE ITEMS THAT ALREADY HAVE A KIND, not the ones being filled. The first
  // version derived both from the same unset rows, so APPLYING the rules destroyed the oracle
  // for every later run: 12 items settled, written, and then invisible to the next scoring
  // pass. A test whose passing removes the evidence can only be run once.
  const rows = db.prepare("SELECT id, title, cluster, priority FROM todo_items WHERE status = 'open' AND kind IS NULL ORDER BY id").all();
  const known = db.prepare("SELECT id, title, kind FROM todo_items WHERE kind IS NOT NULL ORDER BY id").all();
  console.log(`\n  model: ${MODEL}${USE_CLOUD ? '   (OFF THIS MACHINE)' : '   (on this machine)'}`);
  console.log(`  ${rows.length} open items with no kind\n`);

  // --------------------------------------------------------------- the rules pass
  const settled = known.filter((r) => byRule(r) === r.kind);
  const tail = rows;
  console.log(`  oracle: ${settled.length} items already labelled and reproducible by rule; ${tail.length} unlabelled`);
  console.log(`  -> ${Math.round((settled.length / rows.length) * 100)}% needed no model at all\n`);

  if (!settled.length) {
    console.log('  NO ORACLE. The rules settled nothing, so there is nothing to score the model');
    console.log('  against and nothing will be written. That is a broken run, not a clean one.\n');
    process.exit(1);
  }

  // ------------------------------------------------------- warm, then score on the oracle
  if (!USE_CLOUD) {
    process.stdout.write('  warming the model... ');
    const w = await ollama.warm(MODEL);
    console.log(w.ok ? `${w.ms}ms` : `FAILED: ${w.why}`);
    if (!w.ok) { console.log('\n  Could not load the model. Nothing written.\n'); process.exit(2); }
  }

  console.log(`  scoring against the ${settled.length} the rules already answered...`);
  let ok = 0; let seen = 0;
  const misses = [];
  for (let i = 0; i < settled.length; i += BATCH) {
    const slice = settled.slice(i, i + BATCH);
    const res = await askBatch(slice);
    if (res.fail) { console.log(`    batch ${i / BATCH + 1}: could not look -- ${res.fail.why}`); continue; }
    for (const a of res.answers) {
      const truth = settled.find((s) => String(s.id) === String(a.id));
      if (!truth) continue;
      seen += 1;
      if (a.kind === truth.kind) ok += 1;
      else misses.push(`${a.id}  model ${a.kind}  rule ${truth.kind}  ${truth.title.slice(0, 46)}`);
    }
  }

  if (!seen) {
    console.log('\n  THE MODEL ANSWERED NOTHING on the oracle. That is a failure to look, not a');
    console.log('  score of zero, and nothing is written.\n');
    process.exit(2);
  }

  const acc = ok / seen;
  console.log(`  agreement with the rules: ${ok}/${seen}  ${Math.round(acc * 100)}%`);
  for (const m of misses.slice(0, 8)) console.log(`    ${m}`);
  if (misses.length > 8) console.log(`    ...and ${misses.length - 8} more`);

  if (acc < ACCURACY_FLOOR) {
    console.log(`\n  BELOW THE FLOOR (${Math.round(ACCURACY_FLOOR * 100)}%). NOTHING WRITTEN.`);
    console.log('  A model that cannot reproduce answers a regex already knows is not one to');
    console.log('  trust on the answers nobody knows. The rules pass still stands on its own.\n');
  }

  // ------------------------------------------------------------------------ the tail
  let applied = 0;
  if (APPLY) {
    const up = db.prepare('UPDATE todo_items SET kind = ? WHERE id = ? AND kind IS NULL');

    // THE RULES PASS APPLIES TO THE UNLABELLED ROWS, NOT TO THE ORACLE. It iterated the
    // oracle -- rows that by definition already have a kind -- against an UPDATE guarded on
    // kind being null. So it could never write, printed "wrote 0 from the RULES", and handed
    // every unlabelled row to the model with the deterministic pass silently skipped.
    // Rules-first was the whole design, and one variable name inverted it.
    //
    // Found by Codex on independent review. I had SEEN the "wrote 0" line and read it as
    // "nothing left to do", because a manual pass minutes earlier had covered those twelve.
    // Measured afterwards: 12 of 12 rule-settleable items hold the matching kind, so no data
    // was harmed -- by luck rather than by design, which is not a defence.
    const ruled = tail.map((r) => ({ ...r, kind: byRule(r) })).filter((r) => r.kind);
    const modelTail = tail.filter((r) => !byRule(r));
    db.withTransaction(() => { for (const s of ruled) applied += up.run(s.kind, s.id).changes; });
    console.log(`\n  wrote ${applied} kinds from the RULES (exact, auditable, free).`);

    if (acc >= ACCURACY_FLOOR && modelTail.length) {
      let m = 0;
      for (let i = 0; i < modelTail.length; i += BATCH) {
        const res = await askBatch(modelTail.slice(i, i + BATCH));
        if (res.fail) { console.log(`    tail batch ${i / BATCH + 1}: ${res.fail.why}`); continue; }
        db.withTransaction(() => {
          for (const a of res.answers) if (KINDS.includes(a.kind)) m += up.run(a.kind, a.id).changes;
        });
      }
      console.log(`  wrote ${m} more from the MODEL, on the tail the rules could not settle.`);
    } else if (modelTail.length) {
      console.log(`  wrote 0 from the model: ${acc < ACCURACY_FLOOR ? 'it did not clear the floor' : 'nothing left in the tail'}.`);
    }
  } else {
    console.log('\n  Report only. Nothing written. Add --apply.');
  }

  const left = db.prepare("SELECT COUNT(*) n FROM todo_items WHERE status='open' AND kind IS NULL").get().n;
  console.log(`\n  open items still without a kind: ${left}`);
  console.log('  A kind is a routing hint, not a figure. It is visible on the board and one');
  console.log('  UPDATE undoes it, which is why a model is allowed near it at all.\n');
})();
