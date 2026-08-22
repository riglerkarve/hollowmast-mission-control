//
// ollama.js — one client for both Ollama tiers, and one place the privacy rule is enforced.
//
// Owner instruction, 19 Aug 2026: "Implement ollama pro and local model usage."
//
// THE DANGEROUS FACT THIS FILE EXISTS FOR: local and cloud models are served by the SAME
// endpoint. `http://127.0.0.1:11434/api/chat` runs qwen3.5:9b on this machine and
// gpt-oss:120b-cloud in Ollama's datacentre, and the request is identical apart from the model
// name. Verified today: gpt-oss:120b-cloud and gpt-oss:20b-cloud both answer on localhost.
//
// So "it goes to 127.0.0.1, therefore nothing leaves the machine" — the sentence the whole
// finance-and-wellbeing policy rests on, and which ARCHITECTURE.md states outright — is NO
// LONGER TRUE, and nothing in a URL, a log line or a code review would show it. A `-cloud`
// suffix is the only signal, and it is a suffix in a string.
//
// That is the same shape as a route that is safe bound to 127.0.0.1 and publishes the ledger
// bound to 0.0.0.0: the destination changed, the label did not, and the code looks identical.
//
// MEASURED HERE TODAY, so the numbers are this machine's rather than the vendor's:
//   cold call (loads the model)   17.4s
//   warm call, model resident      2.9s        <- 6x, so keep_alive is not a nicety
//   qwen3.5:9b resident            64% on GPU  <- 36% already spilling to CPU at 6.6 GB
//   a probe with no keep_alive     ALL FOUR BATCHES TIMED OUT, because every batch reloaded
'use strict';

const LOCAL = 'http://127.0.0.1:11434';

// Verified reachable on 19 Aug 2026. Several documented cloud models are RETIRED and answer
// with an error rather than a 404 — qwen3-coder:480b, deepseek-v3.1:671b, kimi-k2:1t, glm-4.6
// and minimax-m2 all returned "was retired at ...". So this list is what was tested, not what
// the documentation offers, and a caller naming something else gets a clear failure.
// MEASURED 19 Aug 2026, and it changes what the cloud tier may be used for: gpt-oss:20b-cloud
// IGNORES a JSON schema. Given format:<schema> with an enum it returned the plain text
// "X1: Bug  X2: Feature Request" rather than the structure, twice.
//
// That matters more than its speed. The offload policy admits a model only when the output is
// STRUCTURALLY CONSTRAINED, and an enum is what makes an out-of-vocabulary answer impossible
// rather than merely unlikely. A model that ignores the constraint is not a faster version of
// a constrained one -- it is an unconstrained one, and the gate it fails is the gate.
//
// So a caller needing a schema must check SCHEMA_HONOURED before trusting the tier, and a
// cloud answer must be parsed defensively rather than assumed to be JSON. `null` means
// UNMEASURED, which is not the same as false and must not be read as either.
const CLOUD_MODELS = ['gpt-oss:120b-cloud', 'gpt-oss:20b-cloud'];
// A caller chooses a tier, never a model name. Keeping the selected cloud default beside the
// capability list prevents individual tools drifting as measured models are replaced.
const CLOUD_DEFAULT = 'gpt-oss:20b-cloud';
const SCHEMA_HONOURED = { 'qwen3.5:4b': true, 'qwen3.5:9b': true, 'gpt-oss:20b-cloud': false, 'gpt-oss:120b-cloud': null };
// MEASURED 19 Aug: THE SMALLEST MODEL IS THE BEST ONE HERE, because it is the only one that
// fits. On an 8151 MiB card with 7841 MiB free when idle:
//
//   qwen3.5:4b  3.4 GB  100% ON GPU   12.5s warm   10/12 (83%)   honours schemas
//   qwen3.5:9b  6.6 GB   64% on GPU   17.7s warm    1/2, batches timed out
//   gemma4:12b  7.6 GB   61% on GPU   35.3s warm   10/12 (83%)   DELETED, see below
//
// Weights alone are not the constraint -- weights PLUS the KV cache at a useful context are,
// which is why 6.6 GB does not fit in 7.8 GB of free VRAM.
//
// gemma4:12b was removed on 19 Aug after being measured once (M88, owner decision). It tied
// with the 4B on accuracy -- 10/12 on the same oracle -- while taking 2.2x the disk, spilling
// 39% to the CPU, and running 2.8x slower warm. It lost on every axis and tied on the only
// one that could have justified it.
//
// IT WAS MEASURED BEFORE BEING DELETED, and that order is the point: it had sat installed and
// unmeasured, which made it look like a spare option when it was an unknown one. Deleting an
// unmeasured model would have removed the unknown without ever answering it, and the next
// person to see a 12B on the shelf would have wondered.
const LOCAL_MODELS = ['qwen3.5:4b', 'qwen3.5:9b'];
const LOCAL_DEFAULT = 'qwen3.5:4b';

const isCloud = (model) => /-cloud$|:cloud$/.test(String(model));

// The same vocabulary the dispatcher refuses to send off this machine. Kept as one exported
// constant so the two cannot drift: a guard that disagrees with the router is worse than
// either alone, because each looks correct in isolation.
const SENSITIVE = /\b(ledger|finance|bank|transaction|statement|counterpart|salary|pension|credit[- ]rating|health|wellbeing|medical|mood|journal|credential|secret|api[- ]?key|token|sort[- ]code|iban|account number)\b/i;

class Refused extends Error {}

/**
 * Ask a model. Returns { ok, text, model, tier, ms, why }.
 * NEVER throws for a policy refusal or an unreachable server — the caller must be able to tell
 * "refused", "could not look" and "answered" apart, and an exception collapses the first two.
 */
async function ask({
  model, system, user, schema, timeoutMs = 240000, keepAlive = '15m', temperature = 0, think = false,
} = {}) {
  const tier = isCloud(model) ? 'cloud' : 'local';
  const t0 = Date.now();

  // ---------------------------------------------------------------- the privacy gate
  // Checked on the PAYLOAD, not on the caller's intent. A caller that believes its data is
  // harmless is exactly the caller this needs to stop, and the payload is the only thing that
  // actually leaves.
  if (tier === 'cloud') {
    const payload = `${system || ''}\n${user || ''}`;
    const hit = payload.match(SENSITIVE);
    if (hit) {
      return {
        ok: false,
        refused: true,
        model,
        tier,
        ms: 0,
        why: `REFUSED before sending: the payload contains "${hit[0]}", and a -cloud model leaves this machine. `
          + 'It is served from 127.0.0.1 like the local models, which is exactly why this is checked on content rather than on the URL. '
          + 'Use a local model, or take the data out of the prompt.',
      };
    }
  }

  let res;
  try {
    res = await fetch(`${LOCAL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        // KEEP IT RESIDENT. Without this the model unloads between calls and every call pays
        // 17.4s instead of 2.9s — which is what turned a 44-item probe into four timeouts.
        keep_alive: keepAlive,
        // A SCHEMA WITH AN ENUM, never bare format:'json'. The earlier probe on this project
        // got an object where an array was wanted; an enum makes an out-of-vocabulary answer
        // structurally impossible rather than merely unlikely.
        ...(schema ? { format: schema } : {}),
        // LOAD-BEARING DEFAULT, not a convenience worth dropping. Two callers this was
        // extracted FROM (categorise-model.cjs, classify-senders.cjs) each had this hardcoded,
        // independently, with the same reasoning: qwen3.5 is a thinking model, and with a
        // strict schema it spends the whole output budget in `thinking`, returning an EMPTY
        // `message.content`. This function already DETECTS that below (an empty `content` with
        // `thinking` populated is reported as `empty: true`, not as a silent failure) — but
        // detection is not prevention, and this function had never actually set `think: false`
        // to stop it happening. Verified by removing it: routing those two callers through this
        // function without it reproduced the exact empty-response failure their own comments
        // already warned about, on the first live run of the code that now calls this.
        think,
        options: { temperature },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    // COULD NOT LOOK. Distinct from a refusal and from an answer, and it must stay distinct:
    // Ollama is a desktop app that will sometimes not be running.
    return { ok: false, unreachable: true, model, tier, ms: Date.now() - t0, why: `could not reach Ollama: ${String(e.message).slice(0, 90)}` };
  }

  if (!res.ok) {
    return { ok: false, unreachable: true, model, tier, ms: Date.now() - t0, why: `Ollama answered ${res.status}` };
  }

  const j = await res.json();
  if (j.error) {
    // Retired cloud models answer 200 with an error body rather than a 404, so a naive
    // res.ok check reads a retirement as a successful empty answer.
    return { ok: false, unreachable: true, model, tier, ms: Date.now() - t0, why: `Ollama: ${String(j.error).slice(0, 110)}` };
  }

  // A THINKING MODEL PUTS ITS REASONING SOMEWHERE ELSE. qwen3.5:9b returns `message.thinking`
  // alongside `message.content`, and reading the wrong field gives an empty string that looks
  // exactly like a model with nothing to say.
  const text = String((j.message && j.message.content) || '').trim();
  if (!text) {
    return {
      ok: false,
      empty: true,
      model,
      tier,
      ms: Date.now() - t0,
      thinking: String((j.message && j.message.thinking) || '').slice(0, 200),
      why: 'the model returned no content. It may have put everything in `thinking` — that is an empty ANSWER, not an empty QUESTION, and is not recorded as a result.',
    };
  }

  return { ok: true, text, model, tier, ms: Date.now() - t0, evalCount: j.eval_count };
}

// Warm the model before a batch. On this machine that converts a 17.4s first call into a 2.9s
// one, and it is the difference between a batch finishing and a batch timing out.
async function warm(model) {
  if (isCloud(model)) return { ok: true, skipped: 'cloud models need no warming' };
  return ask({ model, user: 'ready', timeoutMs: 240000 });
}

async function available() {
  try {
    const r = await fetch(`${LOCAL}/api/tags`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return {
      up: true,
      local: (j.models || []).map((m) => m.name),
      // Cloud models are NOT listed by /api/tags — it reports what has been pulled locally.
      // So their availability cannot be discovered, only tested, and this states that rather
      // than presenting a hard-coded list as a live one.
      cloudTested: CLOUD_MODELS,
      cloudNote: 'verified reachable 19 Aug 2026; /api/tags does not list cloud models, so this is a tested list rather than a discovered one',
    };
  } catch (e) {
    return { up: false, why: String(e.message).slice(0, 90) };
  }
}

module.exports = {
  ask, warm, available, isCloud, SENSITIVE, CLOUD_MODELS, CLOUD_DEFAULT, LOCAL_MODELS, LOCAL_DEFAULT, SCHEMA_HONOURED, Refused,
};
