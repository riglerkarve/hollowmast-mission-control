#!/usr/bin/env node
// dupe-scan.cjs -- find backlog items that say the same thing in different words,
// using the local model as a JUDGE over a shortlist a deterministic filter built.
//
//   node tools/dupe-scan.cjs                    # scan open items, print candidates
//   node tools/dupe-scan.cjs --threshold 0.30   # widen the shortlist
//   node tools/dupe-scan.cjs --selftest         # prove the filter and the parser fire
//
// WHY THIS JOB AND NOT ANOTHER. The workspace policy offloads work that is
// high-volume, low-stakes, reviewable and structurally constrained, and refuses
// anything that produces a number, is auto-applied, or asserts a fact about the
// code. Near-duplicate detection is the one backlog job that sits squarely in the
// first list: the output is a SUGGESTION, a human confirms every pair, and being
// wrong costs a glance.
//
// It is also a problem this workspace has demonstrably got twice in one week.
// M157/M270 were caught only because their titles matched exactly. R027 was two
// unrelated records under one id. And the session that closed M157 made the point
// this tool exists for: "a title sweep cannot see a near-duplicate whose title
// differs". A string match answers a narrower question than the one being asked.
//
// THE ARCHITECTURE, AND THE REASON FOR IT. 191 open items is 18,145 pairs. At the
// measured 423 ms per call that is 128 minutes of model time, so asking the model
// about every pair is not an option. A cheap lexical filter shortlists, and the
// model judges only what survives.
//
// THAT MAKES THE FILTER LOAD-BEARING, so it reports its residue and states what it
// does not key on -- which is the part that will actually bite. It keys on shared
// content words. Two items that describe one problem with NO vocabulary in common
// ("the briefing never mentions stalled work" / "reports only show what moved")
// score zero and are never shown to the model at all. This tool cannot find those,
// and says so rather than presenting its output as a sweep.
//
// THE RESULT, MEASURED 23 AUG 2026, AND IT IS NEGATIVE. Keep this tool for its
// shortlist and its residue reporting; do NOT trust its verdicts.
//
// Over 171 open items / 14,535 pairs, the filter shortlisted 6 and the model
// judged 4 "duplicate" and 2 "overlapping". ALL SIX WERE WRONG. Every one was a
// pair drawn from M107-M110, the four BATCH H rows, which share a title template
// and cover DIFFERENT panels -- H1 finance/budget, H2 board/team/todo, H3
// health/exercise, H4 analytics/atlas. Four distinct slices of work, not one.
//
// The proof is internal rather than a matter of opinion. All six pairs are the
// SAME relationship: BATCH Hn against BATCH Hm. If the model were reading the
// distinction it was asked for, all six would carry one verdict. It split them
// 4/2, and inconsistently even within one row's pairs -- M107+M110 "duplicate"
// while M107+M108 and M107+M109 came back "overlapping". Nothing about the pairs
// justifies the split, so it is tracking surface phrasing rather than the
// question.
//
// This is the same failure the workspace already recorded when business context
// was added to the transaction-categorising prompt: the model is confident,
// fluent, and keyed on the wrong feature. Duplicate JUDGING therefore belongs on
// the never-offload list beside numbers and claims about the code. The two real
// duplicates found this week -- M157/M270 and the R027 id collision -- were both
// caught by exact string match and by a human reading rationales.
//
// What survives is the half that is deterministic: the shortlist, and a residue
// line that states 10,277 of 14,529 dropped pairs shared no content word at all.
//
// OUTPUT IS NEVER APPLIED. It prints pairs and stops. Nothing is closed, nothing
// is edited, no status is changed. That is not caution about this tool, it is the
// policy: nothing from the model is auto-applied, and a duplicate closure destroys
// a row's history.

const EXIT_OK = 0, EXIT_NO_MODEL = 2;
const args = process.argv.slice(2);
const SELFTEST = args.includes('--selftest');
const ti = args.indexOf('--threshold');
const THRESH = (ti >= 0 && args[ti + 1]) ? Number(args[ti + 1]) : 0.34;
const mi = args.indexOf('--model');
const MODEL = (mi >= 0 && args[mi + 1]) ? args[mi + 1] : 'qwen3.5:9b';
const API = 'http://127.0.0.1:3000';
const OLLAMA = 'http://127.0.0.1:11434';

// Words that carry no signal here. Kept short and visible rather than a long list
// nobody audits -- every entry is a word that appears in a majority of rows.
const STOP = new Set(('the a an and or of to in for on is are be it its this that with '
  + 'as at by from not no so if then than which who what when where why how have has had '
  + 'do does did can could should would will shall may might must panel route item items '
  + 'backlog mission control should').split(' '));

function tokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------- the judge
// The categories are an ENUM in a JSON schema, not a request in the prompt.
// Plain format:'json' here returns a bare object where a field was wanted; the
// enum makes an out-of-vocabulary answer structurally impossible rather than
// merely discouraged.
const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['duplicate', 'overlapping', 'unrelated'] },
    why: { type: 'string' },
  },
  required: ['verdict', 'why'],
};

async function judge(a, b) {
  const prompt =
`Two items from a software project's backlog. Decide their relationship.

ITEM A (${a.id}): ${a.title}
${String(a.rationale || '').slice(0, 400)}

ITEM B (${b.id}): ${b.title}
${String(b.rationale || '').slice(0, 400)}

"duplicate"   = the same piece of work; doing one does the other.
"overlapping" = genuinely related, but each asks for work the other does not.
"unrelated"   = different work that happens to share vocabulary.

Judge only what is written. Do not guess at the codebase. One short sentence for "why".`;

  const r = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false,
                           format: SCHEMA, options: { temperature: 0, num_predict: 200 } }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j = await r.json();
  let out;
  try { out = JSON.parse(j.response); } catch { return null; }   // residue, not a crash
  if (!out || !['duplicate', 'overlapping', 'unrelated'].includes(out.verdict)) return null;
  return out;
}

function selftest() {
  const A = tokens('The briefing should surface what has been stuck longest');
  const B = tokens('Briefing: show items stuck the longest, not only what changed');
  const C = tokens('Pull YouTube data for three accounts');
  const ab = jaccard(A, B), ac = jaccard(A, C);
  console.log('  self test -- does the shortlist filter discriminate?');
  console.log(`    near-identical pair -> ${ab.toFixed(3)}  (want: above ${THRESH})`);
  console.log(`    unrelated pair      -> ${ac.toFixed(3)}  (want: below ${THRESH})`);
  const pass = ab > THRESH && ac < THRESH;
  console.log(`  ${pass ? 'PASS' : 'FAIL'} -- the filter ${pass ? 'separates' : 'DOES NOT separate'} at this threshold`);
  process.exitCode = pass ? EXIT_OK : 1;
}

(async () => {
  if (SELFTEST) return selftest();

  const res = await fetch(`${API}/api/todo/items?limit=900`);
  const data = await res.json();
  const open = (data.items || data || [])
    // The tracker's resolved states are done and DECLINED. It has no 'wontfix' at
    // all -- naming a status that does not exist excluded nothing and did so
    // silently, so 21 declined rows sat in the "open" set and the first run
    // reported three already-resolved duplicates as findings. Absence and a
    // no-op filter looked identical. The list is taken from the live status
    // distribution rather than guessed: {open, in_progress, done, declined}.
    .filter(x => !['done', 'declined'].includes(String(x.status)))
    .map(x => ({ id: x.id, title: String(x.title || ''), rationale: String(x.rationale || ''),
                 project: x.project || '?', tok: tokens(x.title + ' ' + String(x.rationale || '').slice(0, 300)) }));

  const pairsTotal = open.length * (open.length - 1) / 2;
  const shortlist = [];
  let scoredZero = 0;
  for (let i = 0; i < open.length; i++)
    for (let k = i + 1; k < open.length; k++) {
      const s = jaccard(open[i].tok, open[k].tok);
      if (s === 0) scoredZero++;
      if (s >= THRESH) shortlist.push({ a: open[i], b: open[k], score: s });
    }
  shortlist.sort((x, y) => y.score - x.score);

  console.log(`open items            ${open.length}`);
  console.log(`pairs considered      ${pairsTotal}`);
  console.log(`shortlisted (>= ${THRESH})  ${shortlist.length}`);
  console.log('');
  console.log('RESIDUE -- what this filter dropped and what it cannot see:');
  console.log(`  ${pairsTotal - shortlist.length} pairs dropped below the threshold, of which ${scoredZero} shared no content word at all.`);
  console.log('  NOT KEYED ON: meaning. Two items describing one problem in different');
  console.log('  vocabulary score zero and never reach the model. This is a shortlist of');
  console.log('  lexically similar pairs, not a sweep for duplicates.');
  console.log('');

  if (!shortlist.length) { console.log('Nothing to judge at this threshold.'); process.exitCode = EXIT_OK; return; }

  const out = [];
  let unparsed = 0;
  for (const p of shortlist) {
    let v;
    try { v = await judge(p.a, p.b); }
    catch (e) {
      console.log(`COULD NOT JUDGE: ${MODEL} unreachable (${e.message}).`);
      console.log(`${shortlist.length} shortlisted pairs are listed below UNJUDGED. The shortlist is`);
      console.log('deterministic and is unaffected; only the verdicts are missing.');
      shortlist.forEach(q => console.log(`  ${q.score.toFixed(2)}  ${q.a.id} / ${q.b.id}  ${q.a.title.slice(0, 48)}`));
      process.exitCode = EXIT_NO_MODEL; return;
    }
    if (!v) { unparsed++; continue; }
    out.push({ ...p, ...v });
  }

  for (const tier of ['duplicate', 'overlapping']) {
    const rows = out.filter(r => r.verdict === tier);
    console.log(`${tier.toUpperCase()} -- ${rows.length}`);
    for (const r of rows) {
      console.log(`  ${r.a.id} + ${r.b.id}   lexical ${r.score.toFixed(2)}   [${r.a.project}]`);
      console.log(`     A: ${r.a.title.slice(0, 76)}`);
      console.log(`     B: ${r.b.title.slice(0, 76)}`);
      console.log(`     why: ${String(r.why).slice(0, 150)}`);
    }
    console.log('');
  }
  const unrelated = out.filter(r => r.verdict === 'unrelated').length;
  console.log(`unrelated (shortlisted but judged apart): ${unrelated}`);
  if (unparsed) console.log(`unparseable model replies (counted, not silently dropped): ${unparsed}`);
  console.log('');
  console.log('NOTHING HAS BEEN CHANGED. These are suggestions for a human to confirm.');
  process.exitCode = EXIT_OK;
})();
