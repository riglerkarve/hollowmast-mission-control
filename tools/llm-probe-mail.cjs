#!/usr/bin/env node
//
// llm-probe-mail.cjs — can Ollama classify the sender tail that rules cannot?
//
// Modelled on tools/llm-probe.cjs, which answered the same question for bank transactions
// and found rules did 95.3% and the model 4.7%. Mail is a DIFFERENT shape and that is the
// point of measuring rather than assuming: on 48,021 real messages, pattern rules classify
// 50.4% of senders and 73.1% of message volume, leaving a 561-sender tail.
//
// METHOD, copied deliberately from the transaction probe:
//   * a JSON SCHEMA with an enum, not format:'json'. The enum makes an out-of-vocabulary
//     answer structurally impossible rather than merely unlikely.
//   * temperature 0.
//   * cases SPLIT into unambiguous and judgement, because a blended accuracy figure flatters.
//   * NO DOMAIN CONTEXT IN THE PROMPT. The recorded finding from the transaction probe is
//     that naming the owner's business broke four answers that were already right. So this
//     prompt says nothing about who the owner is or what they do.
'use strict';
require('./_run-log.cjs').record();

const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1] : 'qwen3.5:9b';

const CATEGORIES = ['marketing', 'transactional', 'social', 'survey', 'adult', 'jobs', 'finance', 'personal', 'other'];

// Real senders from the imported mail, with a hand label. Chosen so the truth is decidable
// from the address itself — a case whose answer I could not defend is not a test case.
const UNAMBIGUOUS = [
  ['temu@eu.temuemail.com', 'marketing'],
  ['googleplay-noreply@google.com', 'transactional'],
  ['messages-noreply@linkedin.com', 'social'],
  ['surveys@populuslive.com', 'survey'],
  ['follownotify@bk.chaturbate.com', 'adult'],
  ['totaljobs@jobs.totaljobsmail.com', 'jobs'],
  ['no-reply@notify.onlyfans.com', 'adult'],
  ['isabel@valuedopinions.co.uk', 'survey'],
  ['news@mail.bitcoinclub.game', 'marketing'],
  ['mail@pennyadz.com', 'marketing'],
];

// Cases where a competent human could disagree. Reported SEPARATELY — a single blended
// number would hide exactly the failures that matter.
const JUDGEMENT = [
  ['clinton-and-frank@infinitytrafficboost.com', 'marketing'],
  ['hello@gomining.com', 'marketing'],
  ['support@revolut.com', 'finance'],
  ['noreply@sainsburys.co.uk', 'transactional'],
  ['jon.smith@gmail.com', 'personal'],
];

const ALL = [...UNAMBIGUOUS, ...JUDGEMENT];

async function classify(addrs) {
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      // Deliberately context-free. No mention of the owner, their work, or what the data is
      // for — see the header. The task is stated as a property of the address alone.
      prompt: 'Classify each email sender address by what kind of mail it sends.\n'
        + `Allowed categories: ${CATEGORIES.join(', ')}.\n`
        + 'Answer for every address, in the same order.\n\n'
        + addrs.map((a, i) => `${i + 1}. ${a}`).join('\n'),
      format: {
        type: 'object',
        required: ['results'],
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              required: ['n', 'c'],
              properties: {
                n: { type: 'integer' },
                c: { type: 'string', enum: CATEGORIES },
              },
            },
          },
        },
      },
      // think:false IS LOAD-BEARING, not tuning. qwen3.5 is a thinking model, and with a
      // strict JSON schema it spent its whole output budget in `thinking` and returned an
      // EMPTY response — done_reason "stop", 40 tokens, zero of them in the answer. The
      // probe then reported "ollama unreachable", which was wrong: it answered, with nothing.
      think: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const b = await res.json();
  return JSON.parse(b.response).results;
}

(async () => {
  console.log(`  model ${MODEL}, ${ALL.length} hand-labelled senders, temperature 0\n`);
  const t0 = Date.now();
  let out;
  try { out = await classify(ALL.map(([a]) => a)); }
  catch (err) {
    // Degrades to "not classified, do it yourself" — the rule for every offloaded feature.
    console.error(`  ollama unreachable or refused: ${err.message}`);
    console.error('  A feature built on this must fall back to rules-only, not to a blank.');
    process.exitCode = 1;
    return;
  }
  const ms = Date.now() - t0;

  const byN = new Map(out.map((r) => [r.n, r.c]));
  const score = (set, label) => {
    let ok = 0;
    console.log(`  ${label}`);
    set.forEach(([addr, want]) => {
      const i = ALL.findIndex((x) => x[0] === addr) + 1;
      const got = byN.get(i);
      const hit = got === want;
      if (hit) ok++;
      console.log(`    ${hit ? 'ok  ' : 'MISS'} ${String(addr).slice(0, 40).padEnd(42)}want ${String(want).padEnd(14)}got ${got}`);
    });
    console.log(`    ${ok}/${set.length}\n`);
    return ok;
  };

  const u = score(UNAMBIGUOUS, 'UNAMBIGUOUS — the address states what it is');
  const j = score(JUDGEMENT, 'JUDGEMENT — a competent human could disagree');

  console.log(`  unambiguous ${u}/${UNAMBIGUOUS.length}   judgement ${j}/${JUDGEMENT.length}`);
  console.log(`  ${ms} ms for ${ALL.length} senders = ${Math.round(ms / ALL.length)} ms each, one batched call`);
  console.log('\n  Reported split, never blended: a single accuracy figure hides which half failed,');
  console.log('  and only one of the halves would matter in production.');
})();
