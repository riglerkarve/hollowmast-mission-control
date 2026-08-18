// parse-session.cjs — Claude Code JSONL transcripts -> sessions.json
//
//   node parse-session.cjs --projects <dir> --config <config.json> --out <sessions.json>
//
// Emits one record per transcript file (see sessions.json contract), including
// milestone buckets derived from mcp__ccd_session__mark_chapter tool calls.
//
// Transcripts are large (tens of MB) — every file is streamed line by line.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { areaOf, AREA_TELEMETRY, AREA_PROJECT } = require('./areas.cjs');

const MARK_CHAPTER_TOOL = 'mcp__ccd_session__mark_chapter';
const LEADING_MILESTONE_TITLE = '(before first marker)';
const CHURN_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const MAX_GAPS = 15;

// Reads are tracked per path the same way edits are, so the two can be joined:
// a file read many times and never edited is context bought and never used.
// Grep/Glob are deliberately excluded — they are searches, and their result size
// is not the file's size.
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

// Tools whose target is genuinely a file path. Grep and Glob are excluded on
// purpose: their target is a pattern, and Bash's is a command line — running
// either through a path classifier would file work under whichever area the
// string happened to resemble.
const PATH_TOOLS = new Set([...CHURN_TOOLS, ...READ_TOOLS]);

// Prompt buckets. A prompt is what the user actually controls, so the cost of
// everything that followed one is the number worth showing them. Sub-agent
// "user" records are orchestration, not a human typing, and never open a bucket.
const LEADING_PROMPT_TITLE = '(before first prompt)';
const MAX_PROMPT_TEXT = 180;
const MAX_PROMPTS = 200;      // carried per session, dearest first

// Cache time-to-live, by the ephemeral class the API reports. A write whose next
// turn falls beyond its own TTL was paid for and expired before anything read it.
const CACHE_TTL_MS = { cc5m: 300000, cc1h: 3600000 };

// A tool result stops being re-read once compaction drops it, so "turns after"
// is capped at the next context reset rather than running to the end of the
// session. Same shape of test the dashboard uses on the context series.
const CTX_RESET_FRACTION = 0.7;   // a drop below this share of the peak
const CTX_RESET_MIN_GAP = 5;      // turns, so one dip is not counted twice

const MAX_RESULT_ROWS = 40;   // priciest individual tool results carried
const MAX_STREAK_ROWS = 25;   // longest retry streaks carried
const MAX_READ_ROWS = 120;    // most-read paths carried
const MIN_STREAK = 2;         // a single failure is not a streak

// Edit-family tools, for the `edit-no-match` error kind. Superset of CHURN_TOOLS:
// MultiEdit never appears in these transcripts but fails the same way.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput']);

// Error text is only ever pattern-matched, never stored, so a prefix is enough.
// Build logs run to hundreds of KB; keeping them whole would cost more memory
// than the rest of the parse put together.
// Context bands for the cost-per-turn breakdown. Upper bounds, ascending; the
// last is open-ended. Chosen to straddle the range real sessions actually walk
// through rather than to be round — the interesting contrast is the first band
// against the last.
const CTX_BANDS = [
  { lo: 0, hi: 100e3, label: 'under 100k' },
  { lo: 100e3, hi: 200e3, label: '100–200k' },
  { lo: 200e3, hi: 300e3, label: '200–300k' },
  { lo: 300e3, hi: 400e3, label: '300–400k' },
  { lo: 400e3, hi: 500e3, label: '400–500k' },
  { lo: 500e3, hi: 750e3, label: '500–750k' },
  { lo: 750e3, hi: Infinity, label: 'over 750k' },
];

const MAX_ERR_TEXT = 4000;
const MAX_TARGET = 120;      // hard cap from the churn/rework contract
const CMD_TARGET_CHARS = 60; // fallback: leading slice of the command

// ---------------------------------------------------------------- CLI

function usage() {
  console.error('usage: node parse-session.cjs --transcripts <dir> --config <config.json> --out <sessions.json>');
  console.error('       (--projects is accepted as a synonym for --transcripts)');
}

function parseArgs(argv) {
  const args = { projects: null, config: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    // scripts/telemetry.ps1 calls this --transcripts; the original port called it
    // --projects. Both are accepted so neither caller has to know which it is.
    if (k === '--transcripts' || k === '--projects') args.projects = argv[++i];
    else if (k === '--config') args.config = argv[++i];
    else if (k === '--out') args.out = argv[++i];
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else { console.error('parse-session: unknown argument ' + k); usage(); process.exit(2); }
  }
  const missing = ['projects', 'config', 'out'].filter((k) => !args[k]);
  if (missing.length) {
    console.error('parse-session: missing required argument(s): '
      + missing.map((m) => '--' + (m === 'projects' ? 'transcripts' : m)).join(', '));
    usage();
    process.exit(2);
  }
  return args;
}

function loadConfig(fp) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    console.error('parse-session: cannot read config ' + fp + ': ' + e.message);
    process.exit(1);
  }
  // Defensive defaults — a malformed or partial config must not crash the run.
  cfg.prices = cfg.prices || {};
  const cm = cfg.cacheMultipliers || {};
  cfg.cacheMultipliers = {
    write1h: num(cm.write1h, 2),
    write5m: num(cm.write5m, 1.25),
    read: num(cm.read, 0.1),
  };
  cfg.idleGapMs = num(cfg.idleGapMs, 300000);
  return cfg;
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------- cost

// Unknown models (including the literal "<synthetic>") cost 0 and must not throw.
function makeCostFn(cfg) {
  const mult = cfg.cacheMultipliers;
  return function costOf(model, u) {
    const p = cfg.prices[model];
    if (!p) return 0;
    const pin = num(p.input, 0);
    const pout = num(p.output, 0);
    return (
      u.in * pin +
      u.cc1h * pin * mult.write1h +
      u.cc5m * pin * mult.write5m +
      u.cr * pin * mult.read +
      u.out * pout
    ) / 1e6;
  };
}

// ---------------------------------------------------------------- helpers

const normPath = (p) => String(p).replace(/\\/g, '/');

// Source/<Module>/... -> <Module>
function moduleOf(normalisedPath) {
  const m = /(?:^|\/)Source\/([^/]+)\//.exec(normalisedPath);
  return m ? m[1] : null;
}

const bump = (obj, key, by) => { obj[key] = (obj[key] || 0) + (by === undefined ? 1 : by); };

const hourKey = (ts) => new Date(ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)

// ---------------------------------------------------------------- project root

// The churn block reports paths relative to the repo. telemetry.ps1 exports the
// root; standalone runs fall back to this file's own location (<root>/scripts/
// telemetry/parse-session.cjs), so both callers agree without a new CLI flag.
function resolveProjectRoot() {
  const env = process.env.OA_TELEMETRY_ROOT;
  const raw = env && env.trim() ? env.trim() : path.resolve(__dirname, '..', '..');
  return normPath(raw).replace(/\/+$/, '');
}

const PROJECT_ROOT = resolveProjectRoot();
const PROJECT_ROOT_LC = PROJECT_ROOT.toLowerCase();

// normPath'd form: drive-letter, POSIX absolute, or UNC (//server/share).
const isAbsPath = (p) => /^[a-zA-Z]:\//.test(p) || p.startsWith('/');

// Path relative to the project root, or null when it lives outside it.
// Comparison is case-insensitive because Windows paths reach us in whatever
// case the caller happened to type. A non-absolute path is resolved against the
// session cwd, which is always the project root.
function relIfInside(normalised) {
  if (!isAbsPath(normalised)) return normalised.replace(/^\.\//, '');
  const lc = normalised.toLowerCase();
  if (lc === PROJECT_ROOT_LC) return '';
  if (lc.startsWith(PROJECT_ROOT_LC + '/')) return normalised.slice(PROJECT_ROOT.length + 1);
  return null;
}

const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pull the file a shell command is actually about out of the command line, so a
// build failure reads "scripts/build.ps1" rather than 60 characters of pipeline.
// Absolute paths under the root win; otherwise the first relative script token.
const ROOT_PATH_RE = new RegExp(
  escapeRe(PROJECT_ROOT) + '/([^"\'`|<>\\n]*?\\.[A-Za-z0-9]{1,6})(?=["\'`\\s;|)&]|$)', 'i');
const REL_SCRIPT_RE =
  /(?:^|[\s"'`&(])((?:[\w.\-]+\/)*[\w.\-]+\.(?:ps1|cjs|js|mjs|sh|bat|cmd|py|cpp|h|json|md|html|jsonl))(?=["'`\s;|)&]|$)/;

function pathFromCommand(cmd) {
  const n = normPath(cmd);
  const m = ROOT_PATH_RE.exec(n);
  if (m) return m[1];
  const m2 = REL_SCRIPT_RE.exec(n);
  if (m2) return m2[1];
  return null;
}

// What the errored call was aimed at. A real path becomes root-relative; a shell
// command degrades to its leading slice; anything with no addressable subject
// (an MCP screenshot, say) is honestly null rather than invented.
function reworkTarget(input) {
  if (!input || typeof input !== 'object') return null;
  const direct = input.file_path || input.path || input.notebook_path || null;
  if (typeof direct === 'string' && direct.trim()) {
    const rel = relIfInside(normPath(direct.trim()));
    return cap(rel !== null ? rel : direct.trim(), MAX_TARGET);
  }
  if (typeof input.command === 'string' && input.command.trim()) {
    const extracted = pathFromCommand(input.command);
    if (extracted) return cap(extracted, MAX_TARGET);
    return cap(input.command.replace(/\s+/g, ' ').trim().slice(0, CMD_TARGET_CHARS), MAX_TARGET);
  }
  const other = input.pattern || input.skill || input.subagent_type || input.url || null;
  if (typeof other === 'string' && other.trim()) {
    const rel = relIfInside(normPath(other.trim()));
    if (rel !== null && rel !== other.trim()) return cap(rel, MAX_TARGET);
    return cap(other.replace(/\s+/g, ' ').trim().slice(0, CMD_TARGET_CHARS), MAX_TARGET);
  }
  return null;
}

// ---------------------------------------------------------------- error kinds

// Denied before the tool ever ran — a rejected build is not a build failure.
const RE_PERMISSION =
  /the user doesn't want to proceed|tool use was rejected|user rejected|requested permissions|haven't granted it|permission denied|operation not permitted|\bEACCES\b|access is denied|(?:^|<tool_use_error>)\s*blocked:/i;
const RE_TIMEOUT =
  /timed out|timeout after|exceeded the timeout|\bETIMEDOUT\b/i;
const RE_EDIT_NOMATCH =
  /string to replace not found|string not found|old_string not found|has not been read yet|file has not been read|must (?:first )?read the file|no changes to make|no changes were made|found \d+ matches of the string|is not unique|did not match/i;

// Command names the caller used, vs. diagnostics the tool emitted. Text
// evidence is stronger: a "build.ps1; test.ps1" chain that prints a passing
// build and a failing test is a test failure.
const RE_CMD_BUILD =
  /build\.(?:ps1|bat|sh|cmd)|\bmsbuild\b|\bcl\.exe\b|unrealbuildtool|\bubt\b|dotnet build|cargo build|go build|cmake --build|\bninja\b|\bmake\b(?!\w)/i;
const RE_TXT_BUILD =
  /\berror C\d{4}\b|\berror LNK\d+\b|\bfatal error C\d+|\berror CS\d{4}\b|\bMSB\d{4}\b|Result:\s*Failed\s*\([A-Za-z]*Compil|compilation (?:failed|error)|Unable to build/i;
const RE_CMD_TEST =
  /(?:^|[\s"'`&(\/\\])(?:test|tests|check|verify|lint|spec)[\w.\-]*\.(?:ps1|cjs|js|mjs|sh|bat|cmd|py)\b|\bnpm (?:run )?test\b|\bpytest\b|\bjest\b|\bvitest\b|\bctest\b|\bgo test\b|\bcargo test\b|\bdotnet test\b|\brunuat\b|\bautomation\b/i;
const RE_TXT_TEST =
  /automation results:[^\n]*?[1-9]\d* failed|\b[1-9]\d* (?:tests? )?failed\b|test completed\.\s*result=\{?fail|\bassertion failed\b|\d+ passed,\s*[1-9]\d* failed/i;

const RE_NOT_FOUND =
  /file does not exist|path does not exist|no such file or directory|\bENOENT\b|was not found|not found;|command not found|is not recognized as|cannot find (?:the )?(?:path|file)|could not find (?:the )?file|does not exist/i;

// Precedence is deliberate and first-match-wins. Rationale in order:
//   1 permission — the tool never ran, so nothing downstream can be diagnosed.
//   2 timeout    — a build that timed out is a timeout; that is the cause.
//   3 edit-no-match — only for edit-family tools, the single most common
//                     mechanical failure and the one the panel most wants split
//                     out from genuine build breakage.
//   4/5 build vs test — text diagnostics beat command names (see above).
//   6 not-found  — checked AFTER build/test so "No such file or directory"
//                  inside a compiler log stays a build failure.
//   7 command-error — any other non-zero shell exit.
//   8 other      — the fallback, never the default.
function classifyError(tool, text, command) {
  const t = text || '';
  const cmd = command || '';
  if (RE_PERMISSION.test(t)) return 'permission';
  if (RE_TIMEOUT.test(t)) return 'timeout';
  if (EDIT_TOOLS.has(tool) && RE_EDIT_NOMATCH.test(t)) return 'edit-no-match';

  if (SHELL_TOOLS.has(tool)) {
    if (RE_TXT_TEST.test(t)) return 'test-failure';
    if (RE_TXT_BUILD.test(t)) return 'build-failure';
    if (RE_CMD_TEST.test(cmd)) return 'test-failure';
    if (RE_CMD_BUILD.test(cmd)) return 'build-failure';
  }

  if (RE_NOT_FOUND.test(t)) return 'not-found';
  if (SHELL_TOOLS.has(tool)) return 'command-error';
  return 'other';
}

// Read only as far as the first timestamped record. Used to order files
// chronologically so cross-file message-id de-duplication is deterministic
// (the earliest session owns a shared id).
function firstTimestampOf(fp) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(fp);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      resolve(v);
    };
    rl.on('line', (line) => {
      if (settled || !line.trim()) return;
      let o;
      try { o = JSON.parse(line); } catch (e) { return; }
      if (o && o.timestamp) {
        const t = Date.parse(o.timestamp);
        if (!Number.isNaN(t)) finish(t);
      }
    });
    rl.on('close', () => finish(null));
    stream.on('error', () => finish(null));
  });
}

// ---------------------------------------------------------------- parse one transcript

// `seenMsgIds` is shared across the whole run: an assistant message.id counted
// in one file is never counted again in another.
//
// NOTE on the de-duplication: Claude Code writes one JSONL record per assistant
// *content block*, and every record for the same logical message repeats the
// same `usage` object. So usage must be counted once per message.id (otherwise
// cost inflates ~2.3x), while tool_use blocks must be collected from EVERY
// record because they are disjoint across those records. Do not "simplify".
// `sources` is [{ abs, nested }] — the session's own transcript plus every
// sub-agent and workflow transcript Claude Code wrote under <sessionId>/.
// Nested work is real work: it burns real tokens and edits real files, so it
// folds into the owning session rather than being dropped. What does NOT fold:
//
//   * userTurns  — a sub-agent's "user" records are its orchestration prompt,
//                  not a human typing. Counting them would inflate "prompts".
//   * markers    — milestone structure comes from the main thread only, so a
//                  stray mark_chapter in a sub-agent cannot reshape the buckets.
//   * contextSeries — a sub-agent has its own context window. Mixing them would
//                  make "peak context" describe two different conversations.
//
// Everything else (tokens, cost, tool calls, errors, file edits, timestamps)
// is the same work by a different worker and counts.
async function parseFile(sessionId, sources, seenMsgIds, costOf, cfg) {
  const events = [];       // every timestamp seen, for wall/active/gap maths
  const messages = [];     // deduped assistant messages
  const toolCalls = [];    // { ts, name, target, id, nested }
  const toolErrors = [];   // { ts, useId, text }
  const markers = [];      // { ts, title }
  const prompts = [];      // { ts, text } — main thread only
  const results = [];      // { ts, useId, bytes, nested } — every tool_result
  // tool_use_id -> { name, command, target }, so an errored tool_result can be
  // attributed back to the call that produced it. Populated from EVERY assistant
  // record (see the note above): tool_use blocks are disjoint across records.
  const useById = new Map();
  let userTurns = 0;
  let toolResultBytes = 0;
  let nestedFiles = 0, nestedMsgs = 0, nestedCost = 0;
  // One row per source transcript, so a sub-agent can be judged on what it cost
  // against what it handed back rather than only in aggregate.
  const srcStats = [];

  let srcIndex = -1;
  for (const src of sources) {
  const nested = src.nested;
  srcIndex++;
  srcStats.push({
    name: path.basename(src.abs).replace(/\.jsonl$/i, ''),
    nested, msgs: 0, cost: 0, toolCalls: 0, toolErrors: 0, returnedChars: 0,
    firstTs: null, lastTs: null,
  });
  if (nested) nestedFiles++;
  const rl = readline.createInterface({
    input: fs.createReadStream(src.abs), crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; } // skip unparseable lines silently

    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    const goodTs = ts !== null && !Number.isNaN(ts) ? ts : null;
    if (goodTs !== null) events.push(goodTs);

    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      const u = m.usage;

      if (u && m.id && !seenMsgIds.has(m.id)) {
        seenMsgIds.add(m.id);
        const cc = u.cache_creation || {};
        messages.push({
          ts: goodTs,
          model: m.model || 'unknown',
          in: u.input_tokens || 0,
          cc: u.cache_creation_input_tokens || 0,
          cc1h: cc.ephemeral_1h_input_tokens || 0,
          cc5m: cc.ephemeral_5m_input_tokens || 0,
          cr: u.cache_read_input_tokens || 0,
          out: u.output_tokens || 0,
          side: !!o.isSidechain,
          nested,               // came from a sub-agent / workflow transcript
          src: srcIndex,
        });
        if (nested) nestedMsgs++;
      }

      const content = Array.isArray(m.content) ? m.content : [];

      // What this transcript last handed back. For a sub-agent that IS its return
      // value, which is the only half of the delegation trade not already counted.
      const said = content.filter((b) => b && b.type === 'text')
        .map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
      if (said.trim()) srcStats[srcIndex].returnedChars = said.length;

      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        const inp = b.input || {};
        let target = inp.file_path || inp.path || inp.pattern || inp.command || inp.skill || inp.subagent_type || null;
        if (typeof target === 'string' && target.length > 160) target = target.slice(0, 160);
        toolCalls.push({ ts: goodTs, name: b.name, target, id: b.id || null, nested, src: srcIndex });

        if (b.id) {
          // `file` is taken from the RAW input, before reworkTarget's 120-char cap.
          // The cap trims from the front of a long path, which is exactly where the
          // filename is — so a deep path would otherwise display as a truncated
          // fragment of some parent directory.
          const rawPath = inp.file_path || inp.path || inp.notebook_path || null;
          useById.set(b.id, {
            name: b.name,
            command: typeof inp.command === 'string' ? inp.command : '',
            target: reworkTarget(inp),
            file: typeof rawPath === 'string' && rawPath.trim()
              ? normPath(rawPath.trim()).split('/').filter(Boolean).pop() || null
              : null,
          });
        }

        // Milestone structure comes from the main thread only — see the note on
        // parseFile. A sub-agent marker must not reshape the buckets.
        if (b.name === MARK_CHAPTER_TOOL && !nested) {
          const title = inp && typeof inp.title === 'string' && inp.title.trim()
            ? inp.title.trim()
            : '(untitled chapter)';
          markers.push({ ts: goodTs, title });
        }
      }
    }

    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') {
        if (!o.isMeta && !nested && c.trim()) { userTurns++; prompts.push({ ts: goodTs, text: c }); }
      } else if (Array.isArray(c)) {
        let isToolResult = false;
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          isToolResult = true;
          let bytes = 0;
          if (typeof b.content === 'string') bytes = b.content.length;
          else if (Array.isArray(b.content)) bytes = b.content.reduce((a, x) => a + (x && x.text ? x.text.length : 0), 0);
          toolResultBytes += bytes;
          results.push({ ts: goodTs, useId: b.tool_use_id || null, bytes, nested });
          if (b.is_error) {
            let text = '';
            if (typeof b.content === 'string') text = b.content;
            else if (Array.isArray(b.content)) {
              text = b.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
            }
            toolErrors.push({ ts: goodTs, useId: b.tool_use_id || null, text: cap(text, MAX_ERR_TEXT) });
          }
        }
        if (!isToolResult && !o.isMeta && !nested) {
          const text = c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
          if (text.trim()) { userTurns++; prompts.push({ ts: goodTs, text }); }
        }
      }
    }
  }

  } // end per-source loop

  if (!events.length) return null; // nothing timestamped — nothing to say about it

  events.sort((a, b) => a - b);
  const firstTs = events[0];
  const lastTs = events[events.length - 1];

  // Messages/tools may legitimately arrive out of file order; sort by time and
  // clamp anything untimestamped to firstTs so it still lands in a milestone.
  const at = (x) => (x.ts === null ? firstTs : x.ts);
  messages.sort((a, b) => at(a) - at(b));
  toolCalls.sort((a, b) => at(a) - at(b));
  markers.sort((a, b) => at(a) - at(b));
  prompts.sort((a, b) => at(a) - at(b));
  results.sort((a, b) => at(a) - at(b));

  // ---- wall / active / idle gaps ----
  let activeMs = 0;
  const gaps = [];
  for (let i = 1; i < events.length; i++) {
    const d = events[i] - events[i - 1];
    if (d <= cfg.idleGapMs) activeMs += d;
    else gaps.push({ start: events[i - 1], end: events[i], d });
  }
  gaps.sort((a, b) => b.d - a.d);

  // ---- milestone bounds ----
  // Each marker OPENS a milestone that runs to the next marker (or lastTs).
  // Activity before the first marker goes to a synthetic leading milestone.
  const bounds = [];
  if (!markers.length) {
    bounds.push({ title: LEADING_MILESTONE_TITLE, startTs: firstTs, endTs: lastTs, synthetic: true });
  } else {
    if (at(markers[0]) > firstTs) {
      bounds.push({ title: LEADING_MILESTONE_TITLE, startTs: firstTs, endTs: at(markers[0]), synthetic: true });
    }
    for (let i = 0; i < markers.length; i++) {
      bounds.push({
        title: markers[i].title,
        startTs: at(markers[i]),
        endTs: i + 1 < markers.length ? at(markers[i + 1]) : lastTs,
        synthetic: false,
      });
    }
  }
  const buckets = bounds.map((b) => ({
    title: b.title,
    startTs: b.startTs,
    endTs: b.endTs,
    synthetic: b.synthetic,
    cost: 0, out: 0, msgs: 0, toolCalls: 0, toolErrors: 0,
    fileChurn: {}, moduleChurn: {}, byModel: {},
  }));

  // Assignment is by startTs only (last bucket whose startTs <= ts). Because
  // bounds[0].startTs === firstTs and every event is >= firstTs, this is total:
  // each item lands in exactly one bucket, so milestone costs sum to totals.cost.
  const bucketIndexFor = (ts) => {
    let lo = 0, hi = buckets.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (buckets[mid].startTs <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  const bucketFor = (ts) => buckets[bucketIndexFor(ts)];

  // ---- prompt buckets ----
  // Same construction as milestones, against a different boundary set: each
  // prompt opens a bucket that runs to the next prompt. Sub-agent work started by
  // a prompt lands in it automatically, because it happens before the next one.
  //
  // Anything before the first prompt (session bootstrap, a resumed conversation's
  // replayed tail) goes to a synthetic leading bucket so the per-prompt costs
  // still sum to the session total.
  const pBounds = [];
  if (!prompts.length) {
    pBounds.push({ text: LEADING_PROMPT_TITLE, ts: firstTs, synthetic: true });
  } else {
    if (at(prompts[0]) > firstTs) pBounds.push({ text: LEADING_PROMPT_TITLE, ts: firstTs, synthetic: true });
    for (const p of prompts) {
      pBounds.push({
        text: cap(p.text.replace(/\s+/g, ' ').trim(), MAX_PROMPT_TEXT),
        ts: at(p),
        synthetic: false,
      });
    }
  }
  const pBuckets = pBounds.map((b, i) => ({
    text: b.text,
    ts: b.ts,
    endTs: i + 1 < pBounds.length ? pBounds[i + 1].ts : lastTs,
    synthetic: b.synthetic,
    cost: 0, out: 0, msgs: 0, toolCalls: 0, toolErrors: 0, ctxPeak: 0,
    // Path-bearing tool calls in this prompt's window, by area. What the prompt
    // TOUCHED is the only evidence available of what it was about — the text
    // itself is not classifiable and guessing from it would be worse.
    hits: { [AREA_TELEMETRY]: 0, [AREA_PROJECT]: 0 },
  }));
  const pIndexFor = (ts) => {
    let lo = 0, hi = pBuckets.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pBuckets[mid].ts <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

  // ---- aggregate ----
  const totals = { in: 0, cc: 0, cc1h: 0, cc5m: 0, cr: 0, out: 0, cost: 0 };
  const byModel = {};
  const byHour = {};
  const contextSeries = [];
  // Main-thread turns in order, with the fields the context-derived panels need.
  // The single conversation whose window actually grows — sub-agent turns fill
  // their own, so they belong to none of the calculations built on this.
  const mainTurns = [];

  // What a turn costs, grouped by how much context it had to re-read. Every turn
  // re-sends the whole conversation, so this is the mechanism behind the bill:
  // the same question asked late in a session costs several times what it cost
  // early. Bounded to CTX_BANDS.length rows, so it stays cheap to carry.
  const bandTotals = CTX_BANDS.map(() => ({ turns: 0, ctx: 0, cost: 0, out: 0 }));
  const bandIndex = (ctx) => {
    for (let i = 0; i < CTX_BANDS.length; i++) if (ctx < CTX_BANDS[i].hi) return i;
    return CTX_BANDS.length - 1;
  };

  for (const m of messages) {
    const t = at(m);
    const cost = costOf(m.model, m);

    totals.in += m.in; totals.cc += m.cc; totals.cc1h += m.cc1h;
    totals.cc5m += m.cc5m; totals.cr += m.cr; totals.out += m.out; totals.cost += cost;
    if (m.nested) nestedCost += cost;

    const bm = byModel[m.model] || (byModel[m.model] =
      { in: 0, cc: 0, cc1h: 0, cc5m: 0, cr: 0, out: 0, cost: 0, msgs: 0 });
    bm.in += m.in; bm.cc += m.cc; bm.cc1h += m.cc1h; bm.cc5m += m.cc5m;
    bm.cr += m.cr; bm.out += m.out; bm.cost += cost; bm.msgs++;

    const hk = hourKey(t);
    const bh = byHour[hk] || (byHour[hk] =
      { in: 0, cc: 0, cr: 0, out: 0, cost: 0, msgs: 0, tools: 0 });
    bh.in += m.in; bh.cc += m.cc; bh.cr += m.cr; bh.out += m.out; bh.cost += cost; bh.msgs++;

    // A sub-agent runs in its own context window, so folding its prompt sizes in
    // would make "peak context" describe two different conversations at once.
    const ctx = m.in + m.cc + m.cr;
    if (!m.side && !m.nested) {
      contextSeries.push(ctx);
      mainTurns.push({ ts: t, ctx, model: m.model, cc1h: m.cc1h, cc5m: m.cc5m, cost });
      const b = bandTotals[bandIndex(ctx)];
      b.turns++; b.ctx += ctx; b.cost += cost; b.out += m.out;
    }

    const b = bucketFor(t);
    b.cost += cost; b.out += m.out; b.msgs++;
    const bmm = b.byModel[m.model] || (b.byModel[m.model] = { cost: 0, msgs: 0, out: 0 });
    bmm.cost += cost; bmm.msgs++; bmm.out += m.out;

    const pb = pBuckets[pIndexFor(t)];
    pb.cost += cost; pb.out += m.out; pb.msgs++;
    if (!m.side && !m.nested && ctx > pb.ctxPeak) pb.ctxPeak = ctx;

    const ss = srcStats[m.src];
    if (ss) {
      ss.msgs++; ss.cost += cost;
      if (ss.firstTs === null || t < ss.firstTs) ss.firstTs = t;
      if (ss.lastTs === null || t > ss.lastTs) ss.lastTs = t;
    }
  }

  const toolCounts = {};
  const fileTouch = {};
  // Per-path churn detail, keyed by the same normalised path as fileTouch (which
  // stays a flat absolute-path count — other stages read it and must not change).
  const churnByPath = new Map();
  // Reads, keyed the same way, so the two maps can be joined on path.
  const readByPath = new Map();
  for (const tc of toolCalls) {
    const t = at(tc);
    bump(toolCounts, tc.name);
    const pbi = pBuckets[pIndexFor(t)];
    pbi.toolCalls++;
    if (srcStats[tc.src]) srcStats[tc.src].toolCalls++;

    // Attribute the call to the game or to the tool that measures it. Only paths
    // inside the project count — a scratch file belongs to neither.
    if (PATH_TOOLS.has(tc.name) && tc.target) {
      const rel = relIfInside(normPath(tc.target));
      if (rel !== null && rel !== '') pbi.hits[areaOf(rel)]++;
    }

    if (READ_TOOLS.has(tc.name) && tc.target) {
      const p = normPath(tc.target);
      let r = readByPath.get(p);
      if (!r) { r = { reads: 0, firstTs: t, lastTs: t }; readByPath.set(p, r); }
      r.reads++;
      if (t < r.firstTs) r.firstTs = t;
      if (t > r.lastTs) r.lastTs = t;
    }

    const hk = hourKey(t);
    const bh = byHour[hk] || (byHour[hk] =
      { in: 0, cc: 0, cr: 0, out: 0, cost: 0, msgs: 0, tools: 0 });
    bh.tools++;

    const bi = bucketIndexFor(t);
    const b = buckets[bi];
    b.toolCalls++;

    if (CHURN_TOOLS.has(tc.name) && tc.target) {
      const p = normPath(tc.target);
      bump(fileTouch, p);
      bump(b.fileChurn, p);
      const mod = moduleOf(p);
      if (mod) bump(b.moduleChurn, mod);

      let c = churnByPath.get(p);
      if (!c) {
        c = { edits: 0, writes: 0, firstTs: t, lastTs: t, perBucket: new Array(buckets.length).fill(0) };
        churnByPath.set(p, c);
      }
      c.edits++;
      if (tc.name === 'Write') c.writes++;
      if (t < c.firstTs) c.firstTs = t;
      if (t > c.lastTs) c.lastTs = t;
      c.perBucket[bi]++;
    }
  }

  // Which calls failed, by tool_use_id. Needed in three places below (per-source
  // error counts, retry streaks, and skipping failed calls when pricing results),
  // so it is built once here rather than re-derived each time.
  const errIds = new Set();
  for (const e of toolErrors) if (e.useId) errIds.add(e.useId);

  const errorBuckets = new Array(buckets.length).fill(0);
  for (const e of toolErrors) {
    const bi = bucketIndexFor(at(e));
    buckets[bi].toolErrors++;
    errorBuckets[bi]++;
    pBuckets[pIndexFor(at(e))].toolErrors++;
  }
  // Attributed through the CALL, not the result: a result carries no source, but
  // the call that produced it does.
  for (const tc of toolCalls) {
    if (tc.id && errIds.has(tc.id) && srcStats[tc.src]) srcStats[tc.src].toolErrors++;
  }

  // Drop a synthetic leading milestone that caught nothing (cost-neutral).
  // keptBuckets records which bucket index each surviving milestone came from:
  // churn.byMilestone and rework.byMilestone are indexed against the FILTERED
  // list, so they have to be projected through the same filter. A dropped bucket
  // has no tool calls by definition, so no edit or error can be lost here.
  const keptBuckets = [];
  buckets.forEach((b, i) => {
    if (!(b.synthetic && b.msgs === 0 && b.toolCalls === 0 && b.toolErrors === 0 && markers.length)) {
      keptBuckets.push(i);
    }
  });

  const milestones = buckets
    .filter((b) => !(b.synthetic && b.msgs === 0 && b.toolCalls === 0 && b.toolErrors === 0 && markers.length))
    .map((b) => ({
      title: b.title,
      startTs: b.startTs,
      endTs: b.endTs,
      cost: b.cost,
      out: b.out,
      msgs: b.msgs,
      toolCalls: b.toolCalls,
      toolErrors: b.toolErrors,
      fileChurn: b.fileChurn,
      moduleChurn: b.moduleChurn,
      byModel: b.byModel,
    }));

  // ---- churn ----
  // A file edited 20 times inside one milestone is one hard problem solved; the
  // same 20 edits spread across six milestones is a design that never settled.
  // milestoneSpan is the number that carries that distinction.
  const churnFiles = [];
  let excludedPaths = 0;
  for (const [p, c] of churnByPath) {
    const rel = relIfInside(p);
    if (rel === null || rel === '') { excludedPaths++; continue; } // scratchpad, temp, memory
    const byMilestone = keptBuckets.map((i) => c.perBucket[i]);
    churnFiles.push({
      path: rel,
      name: rel.slice(rel.lastIndexOf('/') + 1),
      edits: c.edits,
      writes: c.writes,
      firstTs: c.firstTs,
      lastTs: c.lastTs,
      milestoneSpan: byMilestone.reduce((a, n) => a + (n > 0 ? 1 : 0), 0),
      byMilestone,
    });
  }
  churnFiles.sort((a, b) => (b.edits - a.edits) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // ---- rework ----
  // How much of the work was fixing rather than building, and what broke.
  const reworkErrors = toolErrors
    .slice()
    .sort((a, b) => at(a) - at(b))
    .map((e) => {
      const use = e.useId ? useById.get(e.useId) : null;
      const tool = use ? use.name : 'unknown';
      return {
        ts: at(e),
        tool,
        kind: classifyError(tool, e.text, use ? use.command : ''),
        target: use ? use.target : null,
      };
    });
  const byToolErr = {};
  const byKindErr = {};
  for (const e of reworkErrors) { bump(byToolErr, e.tool); bump(byKindErr, e.kind); }

  // ---- context resets ----
  // Where compaction collapsed the window. Everything read into context before a
  // reset stops being re-read after it, so this bounds the re-read pricing below.
  const resetAt = [];
  {
    let peak = 0, last = -CTX_RESET_MIN_GAP - 1;
    mainTurns.forEach((m, i) => {
      if (m.ctx > peak) peak = m.ctx;
      if (peak > 0 && m.ctx < peak * CTX_RESET_FRACTION && i - last > CTX_RESET_MIN_GAP) {
        resetAt.push(i); last = i; peak = m.ctx;
      }
    });
  }

  // ---- what each tool result cost in re-reads ----
  //
  // A result's price is not its size. Every later turn re-sends the whole
  // conversation, so a result is paid for again on each one — which makes the
  // real cost (size x turns that came after it), and makes an early large read
  // dramatically worse than the same read at the end.
  //
  // Two deliberate limits keep the number honest rather than dramatic:
  //   * the horizon stops at the next context reset, because compaction drops the
  //     result and nothing re-reads it after that;
  //   * only main-thread results count. A sub-agent's result is re-read inside
  //     that agent's own, much shorter, window.
  // Tokens are estimated at 4 chars each and labelled as an estimate everywhere.
  const turnTs = mainTurns.map((m) => m.ts);
  const firstTurnAfter = (t) => {
    let lo = 0, hi = turnTs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (turnTs[mid] > t) hi = mid; else lo = mid + 1; }
    return lo;
  };
  const resultRows = [];
  let resultTokensMain = 0, resultTokensNested = 0, rereadTokens = 0;
  for (const r of results) {
    const tokens = Math.round(r.bytes / 4);
    if (r.nested) { resultTokensNested += tokens; continue; }
    resultTokensMain += tokens;
    const i0 = firstTurnAfter(at(r));
    const horizon = resetAt.find((i) => i > i0);
    const turnsAfter = Math.max(0, (horizon === undefined ? mainTurns.length : horizon) - i0);
    rereadTokens += tokens * turnsAfter;
    const use = r.useId ? useById.get(r.useId) : null;
    const target = use ? use.target : null;
    // A path outside the project (a scratchpad file, a temp render) costs exactly
    // as much to carry as a source file, so it is never excluded the way churn
    // excludes it — but it is flagged, because it reads as noise otherwise.
    const outside = !!(target && isAbsPath(normPath(target)) && relIfInside(normPath(target)) === null);
    resultRows.push({
      ts: at(r),
      tool: use ? use.name : 'unknown',
      target,
      name: (use && use.file) || (target ? target.slice(normPath(target).lastIndexOf('/') + 1) : null),
      outside,
      failed: !!(r.useId && errIds.has(r.useId)),
      tokens,
      turnsAfter,
      rereadTokens: tokens * turnsAfter,
    });
  }
  resultRows.sort((a, b) => b.rereadTokens - a.rereadTokens);

  // ---- cache writes that expired before anything read them ----
  //
  // Each turn pays a premium to cache the conversation so the next turn can read
  // it cheaply. Come back after the TTL and that premium bought nothing: the next
  // turn writes the whole prefix again. The final turn of a session is excluded —
  // its cache expiring is not waste, there was never going to be another turn.
  const expiry = { cost: 0, tokens: 0, occasions: 0, cc5m: 0, cc1h: 0 };
  for (let i = 0; i < mainTurns.length - 1; i++) {
    const m = mainTurns[i];
    const gap = mainTurns[i + 1].ts - m.ts;
    const dead = { in: 0, cc: 0, cc1h: 0, cc5m: 0, cr: 0, out: 0 };
    if (m.cc5m > 0 && gap > CACHE_TTL_MS.cc5m) dead.cc5m = m.cc5m;
    if (m.cc1h > 0 && gap > CACHE_TTL_MS.cc1h) dead.cc1h = m.cc1h;
    if (!dead.cc5m && !dead.cc1h) continue;
    expiry.cost += costOf(m.model, dead);   // exact: the model is known per turn
    expiry.tokens += dead.cc5m + dead.cc1h;
    expiry.cc5m += dead.cc5m;
    expiry.cc1h += dead.cc1h;
    expiry.occasions++;
  }

  // ---- retry streaks ----
  //
  // Six failures scattered through a session and six in a row are different
  // problems: the second means working from a stale picture and not noticing.
  // Calls issued in one message share a timestamp and are parallel, not retries,
  // so the sequence is walked in distinct-timestamp GROUPS — a group counts as a
  // failed attempt if anything in it errored.
  const streaks = [];
  {
    const groups = [];
    for (const tc of toolCalls) {
      const t = at(tc);
      const g = groups.length && groups[groups.length - 1].ts === t
        ? groups[groups.length - 1]
        : (groups.push({ ts: t, failed: false, calls: [] }), groups[groups.length - 1]);
      g.calls.push(tc);
      if (tc.id && errIds.has(tc.id)) g.failed = true;
    }
    let run = [];
    const flush = () => {
      if (run.length >= MIN_STREAK) {
        const tally = {};
        const targets = {};
        for (const g of run) for (const c of g.calls) {
          if (!c.id || !errIds.has(c.id)) continue;
          bump(tally, c.name);
          const u = useById.get(c.id);
          if (u && u.target) bump(targets, u.target);
        }
        const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
        const tt = top(tally), tg = top(targets);
        streaks.push({
          len: run.length,
          tool: tt ? tt[0] : 'unknown',
          target: tg ? tg[0] : null,
          startTs: run[0].ts,
          endTs: run[run.length - 1].ts,
          ms: run[run.length - 1].ts - run[0].ts,
        });
      }
      run = [];
    };
    for (const g of groups) { if (g.failed) run.push(g); else flush(); }
    flush();
    streaks.sort((a, b) => b.len - a.len || b.ms - a.ms);
  }

  // ---- game work vs. the tool that measures it ----
  //
  // The telemetry pipeline lives in the repository it reports on, so without this
  // split its own construction reads as the cost of building the game. It is not.
  //
  // Attribution is by what each prompt TOUCHED, which is the only evidence there
  // is — prompt text is not classifiable and guessing from it would be worse. A
  // prompt that touched both areas has its cost split in proportion to the calls,
  // rather than being assigned whole to whichever side happened to lead: a prompt
  // that edits one telemetry file and twelve game files is mostly game work.
  //
  // A prompt that touched no project file at all is UNATTRIBUTED, not silently
  // folded into either side. Planning, discussion and reading outside the tree are
  // real spend that belongs to neither column, and the pages say so.
  const areas = {
    [AREA_TELEMETRY]: { cost: 0, prompts: 0 },
    [AREA_PROJECT]: { cost: 0, prompts: 0 },
    unattributed: { cost: 0, prompts: 0 },
  };
  for (const b of pBuckets) {
    const t = b.hits[AREA_TELEMETRY], g = b.hits[AREA_PROJECT];
    const n = t + g;
    if (!n) { areas.unattributed.cost += b.cost; areas.unattributed.prompts++; continue; }
    areas[AREA_TELEMETRY].cost += b.cost * (t / n);
    areas[AREA_PROJECT].cost += b.cost * (g / n);
    // A prompt counts to whichever side it touched more of; unlike cost, a prompt
    // cannot be split in half and still mean anything as a count.
    if (t > g) areas[AREA_TELEMETRY].prompts++;
    else areas[AREA_PROJECT].prompts++;
  }

  // Files and edits split cleanly — a path is in one area or the other.
  for (const [p, c] of churnByPath) {
    const rel = relIfInside(p);
    if (rel === null || rel === '') continue;
    const a = areas[areaOf(rel)];
    a.edits = (a.edits || 0) + c.edits;
    a.files = (a.files || 0) + 1;
  }
  for (const [p, r] of readByPath) {
    const rel = relIfInside(p);
    if (rel === null || rel === '') continue;
    const a = areas[areaOf(rel)];
    a.reads = (a.reads || 0) + r.reads;
  }

  // ---- reads ----
  // Joined against the churn map on the same normalised path, so "read but never
  // edited" is a set difference rather than a guess.
  const readFiles = [];
  let readsExcluded = 0;
  for (const [p, r] of readByPath) {
    const rel = relIfInside(p);
    if (rel === null || rel === '') { readsExcluded++; continue; }
    readFiles.push({
      path: rel,
      name: rel.slice(rel.lastIndexOf('/') + 1),
      reads: r.reads,
      edited: churnByPath.has(p),
      firstTs: r.firstTs,
      lastTs: r.lastTs,
    });
  }
  readFiles.sort((a, b) => b.reads - a.reads || (a.path < b.path ? -1 : 1));

  return {
    sessionId,
    firstTs,
    lastTs,
    wallMs: lastTs - firstTs,
    activeMs,
    msgs: messages.length,
    userTurns,
    toolCalls: toolCalls.length,
    toolErrors: toolErrors.length,
    toolResultBytes,
    totals,
    byModel,
    byHour,
    toolCounts,
    fileTouch,
    contextSeries,
    gaps: gaps.slice(0, MAX_GAPS),
    milestones,

    // ---- prompts ----
    // The unit the user actually controls. Costs sum to totals.cost, so the page
    // can rank prompts without the ranking quietly excluding part of the bill.
    prompts: {
      count: pBuckets.length,
      synthetic: pBuckets.filter((b) => b.synthetic).length,
      cost: pBuckets.reduce((a, b) => a + b.cost, 0),
      rows: pBuckets
        .slice()
        .sort((a, b) => b.cost - a.cost)
        .slice(0, MAX_PROMPTS)
        .map((b) => ({
          text: b.text, ts: b.ts, ms: Math.max(0, b.endTs - b.ts),
          cost: b.cost, msgs: b.msgs, out: b.out,
          toolCalls: b.toolCalls, toolErrors: b.toolErrors, ctxPeak: b.ctxPeak,
          synthetic: b.synthetic,
        })),
    },

    // ---- the game vs. the tool that measures it ----
    areas,

    // ---- reads ----
    reads: {
      files: readFiles.slice(0, MAX_READ_ROWS),
      fileCount: readFiles.length,
      total: readFiles.reduce((a, f) => a + f.reads, 0),
      neverEdited: readFiles.filter((f) => !f.edited).length,
      neverEditedReads: readFiles.filter((f) => !f.edited).reduce((a, f) => a + f.reads, 0),
      repeated: readFiles.filter((f) => f.reads > 1).length,
      repeatedExtra: readFiles.reduce((a, f) => a + Math.max(0, f.reads - 1), 0),
      excludedPaths: readsExcluded,
    },

    // ---- what the context was spent carrying ----
    resultCost: {
      rows: resultRows.slice(0, MAX_RESULT_ROWS),
      count: resultRows.length,
      tokensMain: resultTokensMain,
      tokensNested: resultTokensNested,
      rereadTokens,
      resets: resetAt.length,
      mainTurns: mainTurns.length,
    },

    // ---- cache writes that expired unread ----
    cacheExpiry: expiry,

    // ---- retry streaks ----
    streaks: {
      rows: streaks.slice(0, MAX_STREAK_ROWS),
      count: streaks.length,
      worst: streaks.length ? streaks[0].len : 0,
      inStreak: streaks.reduce((a, s) => a + s.len, 0),
    },
    churn: {
      projectRoot: PROJECT_ROOT,
      excludedPaths,
      files: churnFiles,
    },
    rework: {
      errors: reworkErrors,
      byTool: byToolErr,
      byKind: byKindErr,
      byMilestone: keptBuckets.map((i) => errorBuckets[i]),
    },
    // How much of this session was done by sub-agents rather than the main
    // thread. Already included in every total above — this is the breakdown, so
    // the page can say so instead of quietly implying one worker did it all.
    delegated: {
      files: nestedFiles,
      msgs: nestedMsgs,
      cost: nestedCost,
      costShare: totals.cost > 0 ? nestedCost / totals.cost : 0,
      // Per agent, so the trade can be judged: what it cost against what it
      // handed back. A sub-agent that reads forty files and returns ten lines is
      // a saving; one that cost more than it returned was a cold start for
      // nothing. `returnedChars` is its final message — the part that actually
      // enters the caller's context.
      agents: srcStats
        .filter((s) => s.nested && (s.msgs > 0 || s.toolCalls > 0))
        .sort((a, b) => b.cost - a.cost)
        .map((s) => ({
          name: s.name, msgs: s.msgs, cost: s.cost,
          toolCalls: s.toolCalls, toolErrors: s.toolErrors,
          returnedChars: s.returnedChars,
          ms: s.firstTs !== null && s.lastTs !== null ? s.lastTs - s.firstTs : 0,
        })),
    },
    ctxBands: CTX_BANDS.map((b, i) => ({
      label: b.label,
      lo: b.lo,
      hi: b.hi === Infinity ? null : b.hi,
      turns: bandTotals[i].turns,
      ctx: bandTotals[i].ctx,
      cost: bandTotals[i].cost,
      out: bandTotals[i].out,
    })),
  };
}

// ---------------------------------------------------------------- main

(async () => {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args.config);
  const costOf = makeCostFn(cfg);

  let entries;
  try {
    entries = fs.readdirSync(args.projects, { withFileTypes: true });
  } catch (e) {
    console.error('parse-session: cannot read projects dir ' + args.projects + ': ' + e.message);
    process.exit(1);
  }
  const files = entries
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.jsonl'))
    .map((d) => d.name);

  if (!files.length) {
    console.error('parse-session: no .jsonl transcripts in ' + args.projects);
  }

  // Claude Code writes sub-agent and workflow transcripts under <sessionId>/.
  // That work burns real tokens and edits real files, so it belongs to the
  // session that spawned it — which also keeps the ledger's one-line-per-session
  // contract intact, since the owning id is the directory name.
  const walkJsonl = (dir, acc) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walkJsonl(p, acc);
      else if (d.isFile() && d.name.toLowerCase().endsWith('.jsonl')) acc.push(p);
    }
    return acc;
  };

  // Order chronologically so message-id ownership is deterministic across files.
  const stamped = await Promise.all(
    files.map(async (f) => ({ f, t: await firstTimestampOf(path.join(args.projects, f)) }))
  );
  stamped.sort((a, b) => {
    if (a.t === null && b.t === null) return a.f < b.f ? -1 : 1;
    if (a.t === null) return 1;
    if (b.t === null) return -1;
    if (a.t !== b.t) return a.t - b.t;
    return a.f < b.f ? -1 : 1;
  });

  const seenMsgIds = new Set();
  // A transcript with no tokens on any turn and no tool calls did no work. In
  // practice these are aborted or unauthenticated launches — a lone "<synthetic>"
  // turn carrying an all-zero usage object. They are worthless on the dashboard
  // and actively harmful in docs/telemetry/ledger.jsonl, which is committed and
  // would otherwise accumulate a permanent line per failed launch.
  //
  // The test is deliberately strict: ANY real assistant turn carries non-zero
  // tokens, so this can never drop work that happened. Dropped sessions are
  // counted and reported, never silently swallowed.
  const isEmpty = (s) => {
    const t = s.totals || {};
    const tokens = (t.in || 0) + (t.cc || 0) + (t.cr || 0) + (t.out || 0);
    return tokens === 0 && (s.toolCalls || 0) === 0;
  };

  const sessions = [];
  const emptyIds = [];
  for (const { f } of stamped) {
    const sessionId = f.replace(/\.jsonl$/i, '');
    const sources = [{ abs: path.join(args.projects, f), nested: false }];
    for (const abs of walkJsonl(path.join(args.projects, sessionId), [])) {
      sources.push({ abs, nested: true });
    }
    let s;
    try {
      s = await parseFile(sessionId, sources, seenMsgIds, costOf, cfg);
    } catch (e) {
      console.error('parse-session: failed on ' + f + ': ' + e.message);
      continue;
    }
    if (!s) { console.error('parse-session: skipped ' + f + ' (no timestamped records)'); continue; }
    if (isEmpty(s)) { emptyIds.push(s.sessionId.slice(0, 8)); continue; }
    sessions.push(s);
  }

  sessions.sort((a, b) => a.firstTs - b.firstTs);

  const outDir = path.dirname(path.resolve(args.out));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({ generatedAt: Date.now(), sessions }));

  for (const s of sessions) {
    console.log(
      s.sessionId.slice(0, 8) +
      '  ' + new Date(s.firstTs).toISOString().slice(0, 16).replace('T', ' ') +
      '  msgs ' + String(s.msgs).padStart(5) +
      '  tools ' + String(s.toolCalls).padStart(5) +
      '  err ' + String(s.toolErrors).padStart(3) +
      '  active ' + (s.activeMs / 3600000).toFixed(2) + 'h' +
      '  wall ' + (s.wallMs / 3600000).toFixed(2) + 'h' +
      '  $' + s.totals.cost.toFixed(2) +
      '  milestones ' + s.milestones.length
    );
  }
  if (emptyIds.length) {
    console.log(
      'parse-session: skipped ' + emptyIds.length + ' empty session(s) ' +
      '(no tokens, no tools): ' + emptyIds.join(', ')
    );
  }
  console.log('parse-session: ' + sessions.length + ' session(s) -> ' + args.out);
})().catch((e) => {
  console.error('parse-session: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
