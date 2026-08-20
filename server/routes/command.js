'use strict';
//
// command.js — voice command intent classifier.
//
// Sits between STT (voice.js) and action. Takes a natural-language transcript and
// returns a structured action: which panel to navigate to, which API to query, or
// what to do. The classification is done by a small local Ollama model; if Ollama is
// down or returns garbage, a keyword-matching fallback keeps the feature working.
//
// PRIVACY: this route only classifies intent. It sends the transcript text to the
// model — never finance, wellbeing, or any panel data. The Scribe holds custody of
// those, and a voice command like "show me finance" is an instruction, not the data
// itself. The model returns only the intent label and parameters it was asked for.
// The workspace rule says never call Ollama directly — always through the tool. This
// route uses server/ollama.js's ask(), which is the one place the privacy gate lives,
// the same path every other Ollama caller in this workspace goes through.
//
// ENDPOINTS
//   POST /command          body: { text: '...' }  ->  { intent, ... }
//   GET  /command/status                          ->  { ollama, model }
//
// Mount under /api/voice so the full paths are /api/voice/command and
// /api/voice/command/status — alongside the existing voice STT/TTS routes.

const express = require('express');
const ollama = require('../ollama');

const router = express.Router();

// The smallest model that honours a JSON schema on this machine (see ollama.js's
// measured table). qwen2.5:3b was the task's suggestion but is not installed; qwen3.5:4b
// is the LOCAL_DEFAULT and the fastest model that fits entirely on the GPU. If the
// preferred model is not among those pulled, fall back to any local model available.
const PREFERRED_MODEL = ollama.LOCAL_DEFAULT || 'qwen3.5:4b';
const FALLBACK_MODELS = ['qwen3.5:4b', 'qwen3:8b', 'qwen3.5:9b'];

// 10-second hard ceiling on the Ollama call. Voice commands are interactive — a
// classification that takes longer than the user would wait to just click the panel
// is a regression, not a convenience.
const TIMEOUT_MS = 10000;

// The panels the dashboard's nav can actually mount today. `money`, `life`, and `system`
// replaced nine standalone nav items when the panels consolidated (finance/budget/income ->
// money, lifestyle/exercise/wellbeing -> life, machine/analytics -> system) -- index.html has
// no nav-item left for any of the nine, so navigating straight to one of the old names lands
// on bare panel content with no tab bar and no nav button lit, not a broken page but a
// confusing one. PANEL_ALIASES below is what keeps a command still spoken in those old,
// natural words ("go to finance") resolving to a panel that actually exists.
const PANELS = [
  'board', 'money', 'life', 'system', 'team', 'mail', 'browsing', 'safety', 'atlas',
  'goals', 'schedule', 'projects', 'brain', 'work',
  'garage', 'sessions', 'alerts', 'todo', 'stats', 'voice',
];

// Old standalone panel name -> the consolidated panel that now hosts it. 'cash' and
// 'health' were never real panel names (no loader in shell.js ever existed for either) --
// kept here as aliases into the nearest real destination rather than left to resolve to
// nothing, same reasoning as every other entry.
const PANEL_ALIASES = {
  finance: 'money', budget: 'money', income: 'money', cash: 'money',
  lifestyle: 'life', exercise: 'life', wellbeing: 'life', health: 'life',
  machine: 'system', analytics: 'system',
};

// Few-shot system prompt. Six examples covering every intent type, asking for JSON
// only. The schema (below) makes out-of-vocabulary intents structurally impossible
// rather than merely unlikely — see ollama.js for why that distinction matters here.
const SYSTEM_PROMPT = [
  'You are a voice command classifier for a dashboard called Mission Control.',
  'Given a spoken command, return ONLY a JSON object classifying the intent.',
  'Do not include any text before or after the JSON.',
  '',
  'Intent types and their fields:',
  '  navigate  — user wants to switch to a panel.  Fields: { "intent":"navigate", "panel":"<name>" }',
  '  query     — user wants information about sessions or work.  Fields: { "intent":"query", "api":"/api/sessions/active", "speak":true }',
  '  briefing  — user wants a morning briefing or summary.  Fields: { "intent":"briefing", "api":"/api/briefing/morning", "speak":true }',
  '  status    — user wants overall status.  Fields: { "intent":"status", "api":"/api/board", "speak":true }',
  '  act       — user wants to perform an action.  Fields: { "intent":"act", "action":"start_focus" } or { "intent":"act", "action":"pause_timer" }',
  '  unknown   — anything you cannot classify.  Fields: { "intent":"unknown" }',
  '',
  'Known panels: ' + PANELS.join(', ') + '.',
  '"money" holds finance, budget and income. "life" holds lifestyle, exercise and',
  'wellbeing. "system" holds machine and analytics. Map a request for any of those',
  'six to its holder, not to a panel name that does not exist.',
  '',
  'Examples:',
  '"show me the board"        -> {"intent":"navigate","panel":"board"}',
  '"go to finance"            -> {"intent":"navigate","panel":"money"}',
  '"open wellbeing"           -> {"intent":"navigate","panel":"life"}',
  '"what did claude do"       -> {"intent":"query","api":"/api/sessions/active","speak":true}',
  '"what is the briefing"     -> {"intent":"briefing","api":"/api/briefing/morning","speak":true}',
  '"what is the status"       -> {"intent":"status","api":"/api/board","speak":true}',
  '"start a focus session"    -> {"intent":"act","action":"start_focus"}',
  '"hello there"              -> {"intent":"unknown"}',
].join('\n');

// A JSON schema with an enum on `intent` — the load-bearing constraint. qwen3.5:4b
// honours schemas (SCHEMA_HONOURED in ollama.js), so an out-of-vocabulary intent is
// structurally impossible. Optional fields are omitted from `required` so the model
// can return just { "intent":"unknown" } without inventing a panel that does not exist.
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['navigate', 'query', 'briefing', 'status', 'act', 'unknown'] },
    panel: { type: 'string' },
    api: { type: 'string' },
    action: { type: 'string' },
    speak: { type: 'boolean' },
  },
  required: ['intent'],
};

// -- helpers ---------------------------------------------------------------------------

// Normalise a panel name: lowercase, strip leading "the ", strip trailing punctuation.
function normalisePanel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let p = raw.toLowerCase().trim().replace(/^the\s+/, '').replace(/[.!?,]+$/, '').trim();
  if (PANEL_ALIASES[p]) return PANEL_ALIASES[p];
  if (PANELS.includes(p)) return p;
  // Fuzzy: "finances" -> "finance" -> "money", "sessions" -> "sessions"
  if (p.endsWith('s') && PANEL_ALIASES[p.slice(0, -1)]) return PANEL_ALIASES[p.slice(0, -1)];
  if (p.endsWith('s') && PANELS.includes(p.slice(0, -1))) return p.slice(0, -1);
  if (p === 'bugs') return 'board';
  if (p === 'tasks') return 'todo';
  return null;
}

// Pick the first available model from the preference list. Returns null if none are
// pulled. Called once at require-time so the status endpoint can report the model
// without a round-trip, and re-checked on each classify for liveness.
function pickModel(availableLocal) {
  const models = availableLocal || [];
  for (const m of FALLBACK_MODELS) {
    if (models.includes(m)) return m;
  }
  return models[0] || PREFERRED_MODEL;
}

// -- voice shortcuts ------------------------------------------------------------------
// One-word triggers that bypass the Ollama classifier entirely. These are the
// most common commands, and waiting for a model round-trip to recognise "morning"
// is slower than the keyword match that already knows the answer.
function voiceShortcut(text) {
  const t = String(text || '').trim().toLowerCase();
  // Exact one-word matches only — no false positives on longer sentences.
  const SHORTCUTS = {
    'morning':   { intent: 'briefing', api: '/api/briefing/morning', speak: true, shortcut: true },
    'briefing':  { intent: 'briefing', api: '/api/briefing/morning', speak: true, shortcut: true },
    'status':    { intent: 'status', api: '/api/board', speak: true, shortcut: true },
    'stuck':     { intent: 'query', api: '/api/stale?days=7', speak: true, shortcut: true },
    'go':        { intent: 'act', action: 'start_focus', shortcut: true },
    'stop':      { intent: 'act', action: 'stop_focus', shortcut: true },
    'who':       { intent: 'query', api: '/api/sessions/active', speak: true, shortcut: true },
    'who\'s working': { intent: 'query', api: '/api/sessions/active', speak: true, shortcut: true },
    'activity':  { intent: 'query', api: '/api/activity/stream?hours=24', speak: true, shortcut: true },
    'inbox':     { intent: 'query', api: '/api/inbox/thread?threadId=general', speak: true, shortcut: true },
    'agents':    { intent: 'query', api: '/api/agents', speak: true, shortcut: true },
    'today':     { intent: 'query', api: '/api/prioritize', speak: true, shortcut: true },
    'priorities':{ intent: 'query', api: '/api/prioritize', speak: true, shortcut: true },
    'next':      { intent: 'query', api: '/api/prioritize', speak: true, shortcut: true },
    'spark':     { intent: 'query', api: '/api/creative/spark', speak: true, shortcut: true },
    'ideas':     { intent: 'query', api: '/api/creative/ideas?limit=5', speak: true, shortcut: true },
    'serendipity': { intent: 'query', api: '/api/serendipity', speak: true, shortcut: true },
    'connect':   { intent: 'query', api: '/api/serendipity', speak: true, shortcut: true },
  };
  return SHORTCUTS[t] || null;
}

// -- fallback classifier ---------------------------------------------------------------
// Simple keyword matching. Used when Ollama is down, times out, or returns something
// that is not valid JSON. This is deliberately conservative — it only fires on
// unambiguous keywords, and everything it cannot match falls through to unknown.
function keywordFallback(text) {
  const t = String(text || '').toLowerCase();

  // Navigate — check the old constituent names first (via PANEL_ALIASES) so "show me
  // finance" resolves to the panel that actually exists (money) rather than falling
  // through to "unknown" because 'finance' itself is no longer a valid target.
  const aliasMatch = Object.keys(PANEL_ALIASES).find((p) => new RegExp(`\\b${p}\\b`, 'i').test(t));
  const panelMatch = aliasMatch ? PANEL_ALIASES[aliasMatch] : PANELS.find((p) => {
    const re = new RegExp(`\\b${p === 'board' ? 'board|bugs?' : p}\\b`, 'i');
    return re.test(t);
  });
  if (/\b(show|go to|open|switch to|take me to|navigate to)\b/.test(t) && panelMatch) {
    return { intent: 'navigate', panel: panelMatch, fallback: true };
  }
  if (/\b(show|open|go to|switch to|take me to)\b/.test(t) && /\b(board|bugs?)\b/i.test(t)) {
    return { intent: 'navigate', panel: 'board', fallback: true };
  }
  if (/\b(show|open|go to|switch to|take me to)\b/.test(t) && /\bfinanc(e|ial|es)\b/i.test(t)) {
    return { intent: 'navigate', panel: 'money', fallback: true };
  }
  if (/\b(show|open|go to|switch to|take me to)\b/.test(t) && /\bteam\b/i.test(t)) {
    return { intent: 'navigate', panel: 'team', fallback: true };
  }
  if (/\b(show|open|go to|switch to|take me to)\b/.test(t) && /\bmail\b/i.test(t)) {
    return { intent: 'navigate', panel: 'mail', fallback: true };
  }

  // Briefing
  if (/\b(briefing|morning report|what do i need to do|what should i do|daily report)\b/i.test(t)) {
    return { intent: 'briefing', api: '/api/briefing/morning', speak: true, fallback: true };
  }

  // Status
  if (/\b(status|how are things|how.s it going|how are we doing|overall)\b/i.test(t)) {
    return { intent: 'status', api: '/api/board', speak: true, fallback: true };
  }

  // Query
  if (/\b(what did|what.*do|how many|what.s stuck|stuck|sessions?|claude|agent)\b/i.test(t)) {
    return { intent: 'query', api: '/api/sessions/active', speak: true, fallback: true };
  }

  // Act
  if (/\b(focus|start.*session|begin.*session|concentrate)\b/i.test(t)) {
    return { intent: 'act', action: 'start_focus', fallback: true };
  }
  if (/\b(pause|stop|halt|resume)\b/i.test(t) && /\b(timer|session|focus)\b/i.test(t)) {
    return { intent: 'act', action: 'pause_timer', fallback: true };
  }

  return { intent: 'unknown', text: String(text || ''), fallback: true };
}

// -- model classifier ------------------------------------------------------------------

async function classifyWithModel(text, model) {
  const r = await ollama.ask({
    model,
    system: SYSTEM_PROMPT,
    user: text,
    schema: CLASSIFY_SCHEMA,
    timeoutMs: TIMEOUT_MS,
    think: false,
    temperature: 0,
  });

  if (!r.ok) {
    return { ok: false, why: r.why, refused: r.refused };
  }

  // The model may return JSON directly (schema enforced) or text containing JSON.
  // Try parsing the raw text first, then strip markdown fences if present.
  let parsed = null;
  const raw = r.text.trim();
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Strip ```json ... ``` fences
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        parsed = JSON.parse(fenced[1].trim());
      } catch {}
    }
    // Last attempt: find the first { ... } substring
    if (!parsed) {
      const brace = raw.match(/\{[\s\S]*\}/);
      if (brace) {
        try {
          parsed = JSON.parse(brace[0]);
        } catch {}
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.intent) {
    return { ok: false, why: 'unparseable model response' };
  }

  // Validate the intent is one we know.
  const validIntents = ['navigate', 'query', 'briefing', 'status', 'act', 'unknown'];
  if (!validIntents.includes(parsed.intent)) {
    return { ok: false, why: `unknown intent: ${parsed.intent}` };
  }

  // Normalise and assemble the structured action.
  const action = { intent: parsed.intent };
  if (parsed.intent === 'navigate') {
    const panel = normalisePanel(parsed.panel);
    if (!panel) {
      return { ok: false, why: `unknown panel: ${parsed.panel}` };
    }
    action.panel = panel;
  } else if (parsed.intent === 'query') {
    action.api = parsed.api || '/api/sessions/active';
    action.speak = parsed.speak !== false; // default true
  } else if (parsed.intent === 'briefing') {
    action.api = parsed.api || '/api/briefing/morning';
    action.speak = parsed.speak !== false;
  } else if (parsed.intent === 'status') {
    action.api = parsed.api || '/api/board';
    action.speak = parsed.speak !== false;
  } else if (parsed.intent === 'act') {
    action.action = parsed.action || 'start_focus';
  } else if (parsed.intent === 'unknown') {
    action.text = text;
  }

  action.model = model;
  return { ok: true, action };
}

// -- routes ----------------------------------------------------------------------------

// POST /command — body: { text: '...' }
// Returns a structured action for the voice panel to execute.
router.post('/command', async (req, res) => {
  const text = req.body && req.body.text;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing "text" in body.' });
  }

  // 1. Voice shortcuts — one-word triggers bypass the model entirely.
  const shortcut = voiceShortcut(text);
  if (shortcut) {
    return res.json({ ok: true, action: { intent: shortcut.intent,
      panel: shortcut.panel, api: shortcut.api, action: shortcut.action,
      speak: shortcut.speak !== false, shortcut: true } });
  }

  // 2. Try the model classifier first. If Ollama is down, times out, or returns
  // something unparseable, fall back to keyword matching — a voice command that
  // silently does nothing is worse than one that guesses.
  try {
    const avail = await ollama.available();
    if (avail.up && avail.local && avail.local.length) {
      const model = pickModel(avail.local);
      const result = await classifyWithModel(text, model);
      if (result.ok) {
        return res.json(result.action);
      }
      // Model was reachable but the response was bad — log and fall through.
      console.log(`[command] model classification failed: ${result.why}`);
    }
  } catch (e) {
    console.log(`[command] ollama error: ${String((e && e.message) || e).slice(0, 120)}`);
  }

  // Fallback: keyword matching. Always returns something — never a 500, because
  // the voice panel needs an action to execute or a spoken "I didn't understand".
  res.json(keywordFallback(text));
});

// GET /command/status — is Ollama up, and which model would we use?
router.get('/command/status', async (req, res) => {
  try {
    const avail = await ollama.available();
    if (avail.up) {
      const model = pickModel(avail.local);
      return res.json({ ollama: 'available', model });
    }
    return res.json({ ollama: 'down', model: PREFERRED_MODEL, why: avail.why });
  } catch (e) {
    return res.json({ ollama: 'down', model: PREFERRED_MODEL, why: String((e && e.message) || e).slice(0, 120) });
  }
});

module.exports = router;