#!/usr/bin/env node
//
// llm-probe-project.cjs — can the local model assign a PROJECT to a backlog item?
//
//   node tools/llm-probe-project.cjs
//
// The question "what can a local model do here" is answerable by measurement or by opinion,
// and this project has a standing rule about which one counts. `tools/llm-probe.cjs` already
// did this for transaction categorisation and found rules 95.3% against the model's 4.7%.
// This is the same shape of test on a different job.
//
// WHY THIS JOB. 119 open backlog items have no `project` and 44 do, because the migration
// assigned a project only where the cluster or the title named one outright and refused to
// guess the rest. Assigning the remainder is exactly the shape the offload policy says local
// is for: low-stakes (a wrong tag is a filter, not a figure), reviewable (44 already have a
// human-verifiable answer), structurally constrained (the output is one of nine names), and
// high-volume (119 of them).
//
// THE 44 ARE THE ORACLE, and they were labelled by a mechanical rule rather than by me
// eyeballing them, so they are not contaminated by the thing being tested. The model is run
// BLIND on them and scored against what the rule already decided.
//
// TWO BUCKETS, NOT ONE BLENDED FIGURE. `unambiguous` items name their project in the title;
// `judgement` items were assigned from the cluster and do not say it outright. A single
// accuracy number over both would flatter the model exactly where it matters least.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');

const OLLAMA = 'http://127.0.0.1:11434/api/chat';
const MODEL = process.argv[2] || 'qwen3.5:9b';
const BATCH = 12;

const PROJECTS = ['HOLLOWMAST', 'Mission Control', 'PrintProfit', 'thin-air', 'emberfall',
  'Oxford AutoWorks', 'Fallow', 'Mini Games', 'SecondBrain', 'dropshipping', 'NONE'];

const labelled = db.prepare(`
  SELECT id, title, cluster, project FROM todo_items
   WHERE project IS NOT NULL ORDER BY id`).all();

if (!labelled.length) {
  console.log('\n  NO LABELLED ITEMS. That is a broken probe, not a clean result.\n');
  process.exit(1);
}

// An item whose TITLE contains its project name is unambiguous; one assigned from its cluster
// alone is a judgement call. Splitting on the input rather than on the outcome, so the split
// cannot be drawn to flatter the score.
const bucket = (r) => (r.title.toLowerCase().includes(r.project.toLowerCase()) ? 'unambiguous' : 'judgement');

const SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, project: { type: 'string', enum: PROJECTS } },
        required: ['id', 'project'],
      },
    },
  },
  required: ['answers'],
};

// The enum is the point. Bare format:'json' returned an object where an array was wanted on
// the earlier probe; an enum makes an out-of-vocabulary answer structurally impossible rather
// than merely unlikely.
async function ask(items) {
  const list = items.map((r) => `${r.id}: ${r.title}`).join('\n');
  const res = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
      messages: [
        {
          role: 'system',
          content: 'You assign each work item to the project it belongs to. Answer only with the id and one project from the allowed list. Use NONE when the item is not about any single project. Do not explain.',
        },
        { role: 'user', content: `Projects: ${PROJECTS.join(', ')}\n\nItems:\n${list}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = await res.json();
  return JSON.parse(j.message.content).answers || [];
}

(async () => {
  console.log(`\n  model: ${MODEL}   oracle: ${labelled.length} items already assigned by rule\n`);

  const got = new Map();
  const t0 = Date.now();
  let failed = 0;
  for (let i = 0; i < labelled.length; i += BATCH) {
    const slice = labelled.slice(i, i + BATCH);
    try {
      for (const a of await ask(slice)) got.set(String(a.id), a.project);
    } catch (e) {
      // COULD NOT LOOK is not a wrong answer. A timeout must not be scored as a miss.
      failed += slice.length;
      console.log(`  batch ${i / BATCH + 1}: could not look -- ${String(e.message).slice(0, 60)}`);
    }
  }
  const ms = Date.now() - t0;

  const score = { unambiguous: { n: 0, ok: 0 }, judgement: { n: 0, ok: 0 } };
  const misses = [];
  let unanswered = 0;
  for (const r of labelled) {
    const b = bucket(r);
    score[b].n += 1;
    const a = got.get(String(r.id));
    if (a === undefined) { unanswered += 1; continue; }
    if (a === r.project) score[b].ok += 1;
    else misses.push(`${r.id}  said ${a}  · rule says ${r.project}  · ${r.title.slice(0, 52)}`);
  }

  const pc = (o) => (o.n ? `${o.ok}/${o.n}  ${Math.round((o.ok / o.n) * 100)}%` : 'none');
  console.log(`  unambiguous (project named in the title): ${pc(score.unambiguous)}`);
  console.log(`  judgement   (assigned from cluster only): ${pc(score.judgement)}`);
  console.log(`  unanswered: ${unanswered}${failed ? ` (${failed} in batches that failed)` : ''}`);
  console.log(`  ${Math.round(ms / labelled.length)} ms per item, ${(ms / 1000).toFixed(1)}s total, batched ${BATCH}`);

  if (misses.length) {
    console.log('\n  every miss, because an accuracy figure with the misses hidden is decoration:');
    for (const m of misses.slice(0, 14)) console.log(`    ${m}`);
    if (misses.length > 14) console.log(`    ...and ${misses.length - 14} more`);
  }

  console.log('\n  WHAT THIS DOES NOT SHOW: whether the 119 UNASSIGNED items are like these 44.');
  console.log('  They are not a random sample -- they are the ones a mechanical rule could');
  console.log('  already answer, so they are the EASY end by construction. A score here is an');
  console.log('  upper bound on the real job, never an estimate of it.\n');
})();
