// Measures whether the local model is good enough for Mission Control's runtime work.
// The job under test is the real one: categorising bank transactions for the finance
// ledger. Ground truth is hand-labelled below and split into two classes, because
// "accuracy" over a mixed set would flatter the model — see UNAMBIGUOUS vs JUDGEMENT.
//
//   node tools/llm-probe.cjs
//
// RESULT, qwen3.5:9b @ num_ctx 16384, 17 Aug 2026:
//   UNAMBIGUOUS 20/20   JUDGEMENT 3/5   ~440 ms/transaction, 25 in one batched call.
//   Safe as a SUGGESTION with review. Not safe to auto-apply.
//
// DO NOT ADD BUSINESS CONTEXT TO THE PROMPT. Tested and it is actively harmful:
//   PROBE_CONTEXT="sells 3D-printed goods; buys filament, printer parts…"
//   -> UNAMBIGUOUS 16/20, JUDGEMENT 2/5. Reproduced twice.
// Naming a domain biases the model toward that category across unrelated inputs — it
// filed Sainsbury's, Nando's and Greggs as "Business supplies". The flag is kept only so
// the regression stays reproducible. Merchant-specific knowledge belongs in a
// DETERMINISTIC RULES TABLE (descriptor match -> category), which is auditable, exact,
// and cannot destabilise the other 24 rows.
'use strict';

const MODEL = process.env.PROBE_MODEL || 'qwen3.5:9b';
const HOST = 'http://127.0.0.1:11434';

const CATEGORIES = [
  'Groceries', 'Fuel', 'Software & subscriptions', 'Eating out', 'Utilities',
  'Transport', 'Business supplies', 'Income', 'Bank & fees', 'Entertainment', 'Other',
];

// hard: the descriptor names the merchant plainly, so a wrong answer is a real failure.
// soft: a careful human could defensibly disagree. Scored separately, never merged.
const CASES = [
  { d: 'TESCO STORES 3241 OXFORD',                    c: 'Groceries',                k: 'hard' },
  { d: 'SAINSBURYS SMKTS CD 4471',                    c: 'Groceries',                k: 'hard' },
  { d: 'BP CONNECT BOTLEY RD',                        c: 'Fuel',                     k: 'hard' },
  { d: 'SHELL COWLEY ROAD',                           c: 'Fuel',                     k: 'hard' },
  { d: 'GITHUB INC HTTPSGITHUB.C',                    c: 'Software & subscriptions', k: 'hard' },
  { d: 'ANTHROPIC CLAUDE SUBSCRIPTION',               c: 'Software & subscriptions', k: 'hard' },
  { d: 'ADOBE SYSTEMS SOFTWARE IE',                   c: 'Software & subscriptions', k: 'hard' },
  { d: 'NANDOS OXFORD 0158',                          c: 'Eating out',               k: 'hard' },
  { d: 'GREGGS PLC 1123 OXFORD',                      c: 'Eating out',               k: 'hard' },
  { d: 'THAMES WATER UTILITIES LTD DD',               c: 'Utilities',                k: 'hard' },
  { d: 'OCTOPUS ENERGY LTD DDR',                      c: 'Utilities',                k: 'hard' },
  { d: 'TFL TRAVEL CHARGE TFL.GOV.UK',                c: 'Transport',                k: 'hard' },
  { d: 'GWR TRAIN TICKET OXFORD PAD',                 c: 'Transport',                k: 'hard' },
  { d: 'PAYHIP PAYOUT REF 88213',                     c: 'Income',                   k: 'hard' },
  { d: 'FASTER PAYMENT RECEIVED INV 0042',            c: 'Income',                   k: 'hard' },
  { d: 'NON-STERLING TRANSACTION FEE',                c: 'Bank & fees',              k: 'hard' },
  { d: 'MONTHLY ACCOUNT MAINTENANCE FEE',             c: 'Bank & fees',              k: 'hard' },
  { d: 'NETFLIX.COM 866-579-7172',                    c: 'Entertainment',            k: 'hard' },
  { d: 'STEAM GAMES PURCHASE',                        c: 'Entertainment',            k: 'hard' },
  { d: 'RS COMPONENTS LTD CORBY',                     c: 'Business supplies',        k: 'hard' },

  // Defensibly arguable. A human ledger would need a rule, not a guess.
  { d: 'AMAZON.CO.UK*2M4K71NB3',                      c: 'Other',                    k: 'soft' },
  { d: 'TESCO PETROL FILLING STN',                    c: 'Fuel',                     k: 'soft' },
  { d: 'PAYPAL *3DPRINTUK',                           c: 'Business supplies',        k: 'soft' },
  { d: 'UBER *TRIP HELP.UBER.COM',                    c: 'Transport',                k: 'soft' },
  { d: 'CLOUDFLARE REGISTRAR DOMAIN',                 c: 'Software & subscriptions', k: 'soft' },
];

const BUSINESS = process.env.PROBE_CONTEXT ? `
The trader's business: ${process.env.PROBE_CONTEXT}` : '';
const SYSTEM = `You categorise UK bank transaction descriptors for a sole trader's ledger.${BUSINESS}
Reply ONLY with a JSON array of objects: [{"i":<index>,"c":"<category>"}]
Use exactly one category per transaction, chosen from this list and spelled identically:
${CATEGORIES.join(' | ')}
No prose, no code fences, no explanation.`;

async function run() {
  const list = CASES.map((t, i) => `${i}. ${t.d}`).join('\n');
  const t0 = Date.now();

  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      system: SYSTEM,
      prompt: `Categorise these ${CASES.length} transactions:\n${list}`,
      stream: false,
      think: false,
      // A JSON *schema*, not format:'json'. Two reasons, both load-bearing:
      // format:'json' alone let the model answer with a single object instead of the
      // whole array. And the enum makes an out-of-vocabulary category structurally
      // impossible, so the ledger can never receive a category it has no column for.
      format: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                i: { type: 'integer' },
                c: { type: 'string', enum: CATEGORIES },
              },
              required: ['i', 'c'],
            },
          },
        },
        required: ['results'],
      },
      options: { temperature: 0 },
    }),
  });

  const body = await res.json();
  if (body.error) { console.error('OLLAMA ERROR:', body.error); process.exit(1); }
  const wall = (Date.now() - t0) / 1000;

  let parsed;
  try {
    parsed = JSON.parse(body.response.trim().replace(/^```(?:json)?|```$/g, '')).results;
    if (!Array.isArray(parsed)) throw new Error('results was not an array');
  } catch (e) {
    console.error('UNPARSEABLE RESPONSE — that is itself a finding.\n', body.response.slice(0, 500));
    process.exit(1);
  }

  const got = new Map(parsed.map(r => [Number(r.i), String(r.c || '').trim()]));
  const score = { hard: [0, 0], soft: [0, 0] };
  const misses = [];

  CASES.forEach((t, i) => {
    const g = got.get(i) ?? '(missing)';
    const ok = g === t.c;
    score[t.k][1]++;
    if (ok) score[t.k][0]++;
    else misses.push({ i, d: t.d, expected: t.c, got: g, k: t.k });
  });

  const pct = ([a, b]) => b ? `${a}/${b} (${(100 * a / b).toFixed(0)}%)` : 'n/a';
  const tps = body.eval_count / (body.eval_duration / 1e9);

  console.log(`\nmodel        ${MODEL}`);
  console.log(`wall         ${wall.toFixed(1)}s for ${CASES.length} transactions  (${(wall / CASES.length * 1000).toFixed(0)} ms each)`);
  console.log(`throughput   ${tps.toFixed(1)} tok/s, ${body.eval_count} tokens out`);
  console.log(`\nUNAMBIGUOUS  ${pct(score.hard)}   <- a miss here is a real failure`);
  console.log(`JUDGEMENT    ${pct(score.soft)}   <- a human could defensibly disagree; not a failure`);

  if (misses.length) {
    console.log('\nmisses:');
    for (const m of misses) {
      console.log(`  [${m.k}] ${m.d}\n         expected ${m.expected}  ->  got ${m.got}`);
    }
  }

  const [h, hn] = score.hard;
  console.log(`\nVERDICT: ${h === hn
    ? 'clean on the unambiguous set — safe to use as a SUGGESTION with review'
    : `${hn - h} unambiguous miss(es) — must not auto-apply without review`}`);
}

run().catch(e => { console.error(e); process.exit(1); });
