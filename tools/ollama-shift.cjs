#!/usr/bin/env node
//
// ollama-shift.cjs — put the local model to work on the backlog's `kind` field.
//
//   node tools/ollama-shift.cjs             measure and report, write nothing
//   node tools/ollama-shift.cjs --apply     write the answers it earned the right to write
//   node tools/ollama-shift.cjs --cloud     use the shared cloud default instead of the local default
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

// The verifier must be self-contained: starting this script without MC_DB_PATH would load the
// live database before it could prove anything. The parent process creates a unique temporary
// path, then the child below runs the same writer against it.
const VERIFY_KIND_LOG = process.argv.includes('--verify-kind-log');
if (VERIFY_KIND_LOG && !process.env.MC_DB_PATH) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-kind-log-'));
  const tempDb = path.join(tempDir, 'dashboard.db');
  const child = spawnSync(process.execPath, [__filename, '--verify-kind-log'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MC_DB_PATH: tempDb, MC_DISABLE_ACCESS_LOG: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  console.log(`  temporary database: ${tempDb}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(child.status == null ? 1 : child.status);
}
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');
const ollama = require('../server/ollama');

const APPLY = process.argv.includes('--apply');
const USE_CLOUD = process.argv.includes('--cloud');
const MODEL = process.argv.find((a) => /^--model=/.test(a))?.split('=')[1]
  || (USE_CLOUD ? ollama.CLOUD_DEFAULT : ollama.LOCAL_DEFAULT);
const BATCH = 10;
const ACCURACY_FLOOR = 0.8;

const KINDS = ['bug', 'feature', 'chore', 'question'];

// Update first, then append exactly one provenance row only when the guarded write changed a
// row. The two statements are called inside db.withTransaction(), so a committed kind can
// never lack its source entry and a losing concurrent update cannot fabricate one.
function setKind(update, log, { id, kind, source, model = null }) {
  const changed = update.run(kind, id).changes;
  if (changed) log.run(id, kind, source, model);
  return changed;
}

function verifyKindLog() {
  const live = require('node:path').resolve(__dirname, '..', 'data', 'dashboard.db');
  if (!process.env.MC_DB_PATH || require('node:path').resolve(db.databasePath) === live) {
    throw new Error('--verify-kind-log refuses the live database; run without MC_DB_PATH so it creates a temporary one');
  }

  // Loading this route applies its append-only migration to the temporary database only.
  require('../server/routes/todo');
  const insert = db.prepare(
    `INSERT INTO todo_items (id, source, title, priority, owner, status, kind)
     VALUES (?, 'test', ?, 'P2', 'DET', 'open', NULL)`,
  );
  const update = db.prepare('UPDATE todo_items SET kind = ? WHERE id = ? AND kind IS NULL');
  const log = db.prepare('INSERT INTO todo_kind_log (todo_item_id, kind, source, model) VALUES (?, ?, ?, ?)');
  const rowsFor = db.prepare('SELECT todo_item_id, kind, source, model FROM todo_kind_log WHERE todo_item_id = ? ORDER BY id');

  db.withTransaction(() => {
    insert.run('M116-rule-probe', 'temporary rule provenance probe');
    insert.run('M116-model-probe', 'temporary model provenance probe');
    if (setKind(update, log, { id: 'M116-rule-probe', kind: 'bug', source: 'rule' }) !== 1) throw new Error('rule write did not change its temporary row');
    if (setKind(update, log, { id: 'M116-rule-probe', kind: 'bug', source: 'rule' }) !== 0) throw new Error('second rule write bypassed the guarded update');
    if (setKind(update, log, { id: 'M116-model-probe', kind: 'question', source: 'model', model: 'test-model' }) !== 1) throw new Error('model write did not change its temporary row');
  });

  const ruleRows = rowsFor.all('M116-rule-probe');
  const modelRows = rowsFor.all('M116-model-probe');
  if (ruleRows.length !== 1 || ruleRows[0].kind !== 'bug' || ruleRows[0].source !== 'rule' || ruleRows[0].model !== null) {
    throw new Error('rule provenance row is missing or wrong');
  }
  if (modelRows.length !== 1 || modelRows[0].kind !== 'question' || modelRows[0].source !== 'model' || modelRows[0].model !== 'test-model') {
    throw new Error('model provenance row is missing or wrong');
  }
  console.log('  PASS kind log: one append-only row per successful rule/model write; no row for a guarded no-op.');
}

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

if (VERIFY_KIND_LOG) {
  verifyKindLog();
} else (async () => {
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
  // RULED AND MODELTAIL ARE COMPUTED HERE, ONCE, because a P2 Codex found on independent
  // review (M114) traced to exactly this being computed twice with two different meanings.
  // The line below used to print settled.length / rows.length -- the ORACLE (known rows the
  // rule reproduces) divided by the UNLABELLED count. Those are different populations, and
  // the percentage could exceed 100% or simply be wrong; it was never the "needed no model"
  // figure it claimed to be. `ruled` -- unlabelled rows the rule itself can settle -- is the
  // honest numerator, and it also used to exist only inside `if (APPLY)`, so a plain report
  // run never saw it at all.
  const ruled = tail.map((r) => ({ ...r, kind: byRule(r) })).filter((r) => r.kind);
  const modelTail = tail.filter((r) => !byRule(r));
  console.log(`  oracle: ${settled.length} items already labelled and reproducible by rule; ${tail.length} unlabelled`);
  console.log(`  -> ${tail.length ? Math.round((ruled.length / tail.length) * 100) : 0}% of the unlabelled rows the rules can settle without a model\n`);

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
    const log = db.prepare('INSERT INTO todo_kind_log (todo_item_id, kind, source, model) VALUES (?, ?, ?, ?)');

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
    // `ruled` and `modelTail` are computed once, above, before this block -- not re-derived here.
    db.withTransaction(() => {
      for (const s of ruled) applied += setKind(up, log, {
        id: s.id, kind: s.kind, source: 'rule',
      });
    });
    console.log(`\n  wrote ${applied} kinds from the RULES (exact, auditable, free).`);

    if (acc >= ACCURACY_FLOOR && modelTail.length) {
      let m = 0;
      for (let i = 0; i < modelTail.length; i += BATCH) {
        const res = await askBatch(modelTail.slice(i, i + BATCH));
        if (res.fail) { console.log(`    tail batch ${i / BATCH + 1}: ${res.fail.why}`); continue; }
        db.withTransaction(() => {
          for (const a of res.answers) if (KINDS.includes(a.kind)) m += setKind(up, log, {
            id: a.id, kind: a.kind, source: 'model', model: MODEL,
          });
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
