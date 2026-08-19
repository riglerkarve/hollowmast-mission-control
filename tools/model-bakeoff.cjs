#!/usr/bin/env node
'use strict';
// model-bakeoff.cjs -- compare local models on the four things the Scribe actually needs.
//
// Owner instruction, 20 August 2026: "If the model installed is not good enough - check
// other open models my hardware can handle."
//
// The reason this is a script and not a judgement: the last time a model was chosen here
// it was chosen on a benchmark article, and checking the article's top recommendation
// found it did not exist -- "Llama 3.3 8B" is a 70B model whose smallest build is 43 GB,
// five times this card. A leaderboard is a claim about someone else's hardware running
// someone else's job.
//
// FOUR TESTS, IN THE ORDER THAT LETS YOU STOP EARLY. Each is pass/fail on its own and a
// model failing 1 or 2 cannot be rescued by doing well at 3.
//
//   1 FIT          Does it sit 100% on the GPU? Anything less spills to system RAM and is
//                  slower AND less reliable than a smaller model that fits. Measured from
//                  /api/ps, not from the file size -- the KV cache lives in VRAM too and
//                  is why a 6.6 GB model failed to fit in 7.8 GB of free card.
//
//   2 SCHEMA       Does it honour a JSON schema with an enum? gpt-oss:20b-cloud does not,
//                  and is larger and faster and useless for constrained work as a result.
//                  A model that ignores the constraint is not a faster constrained model.
//
//   3 CLASSIFY     The 12-item oracle. THE ORACLE COMES FROM THE RULES TABLE, not from me
//                  and not from another model -- a model scored against labels a model
//                  wrote is not scored at all.
//
//   4 DISCRIMINATE The one that matters and the one qwen3.5:4b failed on 20 Aug. The same
//                  question is asked twice with the evidence INVERTED. A model that gives
//                  the same verdict both times has not read the evidence, however well
//                  reasoned its answer sounds. This is pass/fail and there is no partial
//                  credit: a constant verdict carries zero information.
//
// Usage:  node tools/model-bakeoff.cjs qwen3.5:4b qwen3:8b

const path = require('path');
const OLLAMA = 'http://127.0.0.1:11434';
const KEEP = '15m';

async function chat(model, messages, format) {
  const body = { model, stream: false, keep_alive: KEEP, options: { temperature: 0 }, messages };
  if (format) body.format = format;
  const t0 = Date.now();
  // A hang must surface as "could not look", not as an uncaught fetch failure that takes
  // the whole run down after three tests have already passed.
  let r;
  try {
    r = await fetch(OLLAMA + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000),
    });
  } catch (e) {
    return { error: 'request failed or timed out: ' + e.message, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  // A 200 with an error body reads as success to a naive res.ok check. Look at the body.
  const j = await r.json();
  if (j.error) return { error: j.error, ms };
  // Thinking models put reasoning in .thinking and the answer in .content. An empty
  // .content is not an empty answer.
  return { content: (j.message && j.message.content) || '', thinking: (j.message && j.message.thinking) || '', ms };
}

// ---- 1 FIT -----------------------------------------------------------------
async function testFit(model) {
  // A 5.2 GB model does not become resident the instant the first call returns, and the
  // first version of this checked once and reported FAIL for a model that then passed
  // every later test. "Not resident yet" and "does not fit" are different answers and
  // only one of them is a failure -- so poll, and if it never appears say COULD NOT LOOK
  // rather than FAIL.
  await chat(model, [{ role: 'user', content: 'hi' }]);      // force a load
  let m = null;
  for (let i = 0; i < 10 && !m; i++) {
    const ps = await (await fetch(OLLAMA + '/api/ps')).json();
    // Ollama reports 'qwen3:8b' in one field and may tag the other; match either, loosely.
    m = (ps.models || []).find(x => x.name === model || x.model === model
                                 || String(x.name || '').startsWith(model));
    if (!m) await new Promise(r => setTimeout(r, 3000));
  }
  if (!m) return { pass: null, note: 'COULD NOT LOOK: never appeared in /api/ps after 30s of polling' };
  const pct = Math.round(100 * m.size_vram / m.size);
  return {
    pass: pct >= 100,
    pct,
    gb: (m.size / 1e9).toFixed(1),
    note: pct >= 100 ? 'fully on the card' : 'SPILLS ' + (100 - pct) + '% to system RAM',
  };
}

// ---- 2 SCHEMA --------------------------------------------------------------
const KIND_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['bug', 'feature', 'chore', 'question'] },
        },
        required: ['id', 'kind'],
      },
    },
  },
  required: ['answers'],
};

// The definitions matter more than the enum. Running the schema example WITHOUT them
// returned valid JSON with both labels wrong -- a schema constrains the shape, not the
// understanding.
const KIND_SYSTEM =
  'Classify each item as exactly one of four kinds.\n' +
  'bug = something behaves wrongly now.\n' +
  'feature = something new to build.\n' +
  'chore = upkeep with no behaviour change.\n' +
  'question = a decision with no agreed answer yet.\n' +
  'Return one answer per item, using the id given. Do not skip any.';

async function testSchema(model) {
  const r = await chat(model, [
    { role: 'system', content: KIND_SYSTEM },
    { role: 'user', content: 'X1: the panel renders nothing when its API is down\nX2: add a date filter to the board' },
  ], KIND_SCHEMA);
  if (r.error) return { pass: false, note: 'error: ' + r.error };
  try {
    const j = JSON.parse(r.content);
    const ok = Array.isArray(j.answers) && j.answers.length === 2 && j.answers.every(a => a.id && a.kind);
    return { pass: ok, ms: r.ms, got: r.content.slice(0, 120), note: ok ? 'valid against the schema' : 'parsed but wrong shape' };
  } catch (e) {
    return { pass: false, ms: r.ms, got: r.content.slice(0, 120), note: 'NOT JSON -- ignores the schema' };
  }
}

// ---- 3 CLASSIFY ------------------------------------------------------------
// The oracle is loaded from the database, from rows a DETERMINISTIC RULE labelled.
// If none exist the test reports could-not-look rather than a score.
async function testClassify(model) {
  let rows = [];
  let oracle = '';
  try {
    // db.js sets module.exports = db itself -- destructuring { db } here silently yields
    // undefined, and the failure then surfaces as "could not look" rather than as a bug.
    const db = require(path.join(__dirname, '..', 'server', 'db.js'));
    rows = db.prepare(
      "SELECT id, title, kind FROM todo_items WHERE kind IS NOT NULL AND title IS NOT NULL " +
      "ORDER BY id LIMIT 12"
    ).all();
    // THIS ORACLE IS CONTAMINATED AND THE AMOUNT IS KNOWN.
    // Of ~70 labelled rows, 21 kinds were written BY A MODEL during the run where the
    // rules-first pass was inverted, and nothing records which 21 -- todo_items carries no
    // per-row actor and the access log holds nothing for this table. So up to 30% of any
    // sample may be model-written, and a model scored against labels a model wrote is not
    // scored at all. The score below is an UPPER BOUND on capability, never an estimate of
    // it, and it is stated that way wherever it is repeated.
    oracle = 'todo_items.kind (CONTAMINATED: up to 21 of ~70 labels are model-written and '
           + 'cannot be individually identified; treat any score as an upper bound)';
  } catch (e) {
    return { pass: null, note: 'COULD NOT LOOK: ' + e.message };
  }
  if (rows.length < 6) return { pass: null, note: 'COULD NOT LOOK: only ' + rows.length + ' labelled rows available' };

  const list = rows.map(r => r.id + ': ' + r.title).join('\n');
  const res = await chat(model, [
    { role: 'system', content: KIND_SYSTEM },
    { role: 'user', content: list },
  ], KIND_SCHEMA);
  if (res.error) return { pass: null, note: 'COULD NOT LOOK: ' + res.error };

  let got;
  try { got = JSON.parse(res.content).answers; } catch (e) { return { pass: false, note: 'unparseable' }; }

  const byId = new Map(got.map(a => [a.id, a.kind]));
  const misses = [];
  let hit = 0;
  for (const r of rows) {
    const g = byId.get(r.id);
    if (g === r.kind) hit++;
    else misses.push({ id: r.id, title: r.title.slice(0, 60), expected: r.kind, got: g === undefined ? '(no answer)' : g });
  }
  // A missing answer is not a wrong answer. Small models quietly truncate; count first.
  const answered = rows.filter(r => byId.has(r.id)).length;
  return {
    pass: hit / rows.length >= 0.8,
    score: +(hit / rows.length).toFixed(2),
    hit, of: rows.length, answered, oracle, misses, ms: res.ms,
    note: answered < rows.length ? 'TRUNCATED: answered ' + answered + ' of ' + rows.length : '',
  };
}

// ---- 4 DISCRIMINATE --------------------------------------------------------
// The same question twice, evidence inverted. qwen3.5:4b returned REJECT to both.
const DISC_SYSTEM =
  'You are reviewing a claim made by a worker. Accept it only if the evidence given supports it. ' +
  'Answer with ACCEPT or REJECT as the verdict, and one sentence of reasoning.';

const DISC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ACCEPT', 'REJECT'] },
    because: { type: 'string' },
  },
  required: ['verdict', 'because'],
};

const CASE_FALSE =
  'Claim: "The Ko-fi donation link is live and configured."\n\n' +
  'Evidence:\n- site/support.html line 546 reads:  kofi: null,\n' +
  '- No file in the repository contains a Ko-fi account name.\n' +
  '- The support page renders a Ko-fi button only when kofi is non-null.';

const CASE_TRUE =
  'Claim: "The Ko-fi donation link is live and configured."\n\n' +
  'Evidence:\n- site/support.html line 546 reads:  kofi: \'https://ko-fi.com/hollowmast\',\n' +
  '- LAUNCH.md line 148 lists hollowmast as the Ko-fi account name.\n' +
  '- The support page renders a Ko-fi button only when kofi is non-null.';

async function testDiscriminate(model) {
  const runs = [];
  for (const [label, body, want] of [['evidence CONTRADICTS', CASE_FALSE, 'REJECT'], ['evidence SUPPORTS', CASE_TRUE, 'ACCEPT']]) {
    // NO SCHEMA HERE, deliberately. A thinking model under a strict schema returns an
    // empty response on this machine -- it is a recorded failure mode, and the first run
    // of this script hit it and died after three tests had already passed. The verdict is
    // one of two words, so it is read out of the text instead.
    const r = await chat(model, [
      { role: 'system', content: DISC_SYSTEM },
      { role: 'user', content: body },
    ]);
    let v = null, why = '';
    if (!r.error) {
      const txt = String(r.content || '');
      const m = txt.match(/\b(ACCEPT|REJECT)\b/i);
      if (m) v = m[1].toUpperCase();
      why = txt.replace(/\s+/g, ' ').trim();
    }
    runs.push({ label, want, got: v, because: why, ms: r.ms, error: r.error });
  }
  // THREE OUTCOMES, NOT TWO, and the first version of this collapsed two of them.
  // A run that produced NO verdict is "could not look" -- qwen3.5:4b returned an empty
  // answer on the second case and the script reported "verdict did not move", which is a
  // claim about reasoning made from a missing answer. Absence and failure must not print
  // the same sentence.
  const silent = runs.filter(r => !r.got);
  if (silent.length) {
    return {
      pass: null, runs,
      note: 'COULD NOT LOOK: ' + silent.length + ' of 2 runs returned no verdict at all '
          + '(empty answer or error). That is not evidence about its judgement either way -- '
          + 'it is a missing measurement, and scoring it as a wrong answer would invent a finding.',
    };
  }
  const moved = runs[0].got !== runs[1].got;
  const correct = runs[0].got === 'REJECT' && runs[1].got === 'ACCEPT';
  return {
    pass: !!correct,
    moved,
    runs,
    note: correct ? 'verdict tracked the evidence in both directions'
        : moved ? 'verdict MOVED but landed wrong at least once'
        : 'VERDICT DID NOT MOVE -- identical answer to inverted evidence, so it carries no '
          + 'information about the evidence',
  };
}

// ---- run -------------------------------------------------------------------
(async () => {
  const models = process.argv.slice(2);
  if (!models.length) { console.error('usage: node tools/model-bakeoff.cjs <model> [<model>...]'); process.exit(2); }

  const results = {};
  for (const m of models) {
    console.log('\n=== ' + m + ' ===');
    const fit = await testFit(m);
    console.log('  1 FIT          ' + (fit.pass ? 'PASS' : 'FAIL') + '  ' + (fit.gb || '?') + ' GB, ' + (fit.pct ?? '?') + '% on GPU -- ' + fit.note);

    const sch = await testSchema(m);
    console.log('  2 SCHEMA       ' + (sch.pass ? 'PASS' : 'FAIL') + '  ' + (sch.ms || '?') + 'ms -- ' + sch.note);

    const cls = await testClassify(m);
    if (cls.pass === null) console.log('  3 CLASSIFY     ----  ' + cls.note);
    else {
      console.log('  3 CLASSIFY     ' + (cls.pass ? 'PASS' : 'FAIL') + '  ' + cls.hit + '/' + cls.of + ' = ' + cls.score + ' vs floor 0.8, ' + cls.ms + 'ms' + (cls.note ? '  [' + cls.note + ']' : ''));
      console.log('                 oracle: ' + cls.oracle);
      for (const x of cls.misses) console.log('                 MISS ' + x.id + ' expected ' + x.expected + ', got ' + x.got + ' -- ' + x.title);
    }

    const dis = await testDiscriminate(m);
    console.log('  4 DISCRIMINATE ' + (dis.pass ? 'PASS' : 'FAIL') + '  -- ' + dis.note);
    for (const r of dis.runs) console.log('                 ' + r.label.padEnd(20) + ' want ' + r.want.padEnd(6) + ' got ' + String(r.got).padEnd(6) + ' | ' + String(r.because).slice(0, 90));

    results[m] = { fit, schema: sch, classify: cls, discriminate: dis };
  }

  console.log('\n=== VERDICT ===');
  // Y / N / ? are three states on purpose. '?' is could-not-look and must never render as
  // a failure: a model nobody managed to measure and a model measured as bad are different
  // situations, and only the second is a reason not to use it.
  const mark = v => v === null || v === undefined ? '?' : v ? 'Y' : 'N';
  for (const [m, r] of Object.entries(results)) {
    const unknown = [r.fit.pass, r.schema.pass, r.classify.pass, r.discriminate.pass]
      .filter(v => v === null || v === undefined).length;
    const failedHard = r.fit.pass === false || r.schema.pass === false;
    console.log('  ' + m.padEnd(16)
      + ' fit=' + mark(r.fit.pass)
      + ' schema=' + mark(r.schema.pass)
      + ' classify=' + mark(r.classify.pass)
      + ' discriminate=' + mark(r.discriminate.pass)
      + (failedHard ? '   <- fails a hard gate, nothing downstream can rescue it' : '')
      + (unknown ? '   <- ' + unknown + ' gate(s) COULD NOT BE MEASURED, which is not a pass' : ''));
  }
  console.log('\nNothing here is written to the capability table automatically. A score becomes a');
  console.log('capability only through POST /api/team/scribe/measure, with its oracle named.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
