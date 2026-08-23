//
// trackers.js — read each project's own bug and request tracker, without owning it.
//
// These files belong to the projects they live in. Nothing here writes to them, ever. The
// board mirrors them so there is one place to look; the files stay the place to WRITE, so a
// session logging a bug needs no server and no network.
//
// EVERY PARSER HERE REPORTS ITS RESIDUE. A tracker parser that silently drops what it cannot
// read produces a short, tidy list and a false sense of control — and it fails flatteringly,
// because a smaller list of bugs looks like good news. So each returns what it skipped and
// why, and the board records that count against the run.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------- HOLLOWMAST — BUGS.md

// The file's own header states the vocabulary: "P1 breaks a run · P2 wrong behaviour, run
// survives · P3 cosmetic" and "OPEN · FIXED · WONTFIX · NOTABUG". Measured against the 76
// entries actually present, that vocabulary is aspirational: the severity slot holds
// "NOT A BUG (verification record)", "NOTABUG (harness)" and "OPEN QUESTION" as often as it
// holds a P-number, and 21 entries carry no meta line at all. The parser reads what is there.
const SECTION_STATUS = {
  open: 'open',
  fixed: 'fixed',
  "won't fix": 'wontfix',
  'wont fix': 'wontfix',
  'not a bug': 'notabug',
  findings: 'note',
};

// Prefix carries the kind, and it is the tracker's own distinction rather than mine: B is a
// bug, N a note recorded after looking and finding nothing wrong, F a finding about the world
// rather than a defect. Collapsing N and F into "bug" would inflate every count on the board.
const PREFIX_KIND = { B: 'bug', N: 'note', F: 'finding' };

function parseBugsMd(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  const skipped = [];
  let conflicts = 0;
  let section = null;

  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^##\s+(.+?)\s*$/);
    if (head && !/^#/.test(head[1])) { section = head[1].replace(/\s+—.*$/, '').trim(); continue; }

    const m = lines[i].match(/^###\s+([A-Z]+)(\d+)\s+—\s+(.+?)\s*$/);
    if (!m) continue;
    const ref = m[1] + m[2];

    // The meta line is the next bold-opening line within three, because some entries put a
    // blank line or a quote first. Looking only at i+1 lost real entries.
    let meta = null;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      if (/^\*\*/.test(lines[j])) { meta = lines[j].replace(/\*\*/g, '').trim(); break; }
    }

    const sectionStatus = section ? SECTION_STATUS[section.toLowerCase()] || null : null;

    // Search the WHOLE meta line for a status token, not a fixed slot. "NOT A BUG
    // (verification record) · ..." puts the status where the severity is supposed to go, and
    // a positional parser reads that as a severity of "NOT A BUG" and a status of whatever
    // came next — which is how a status field ends up holding a date.
    let metaStatus = null;
    if (meta) {
      const u = meta.toUpperCase();
      if (/\bNOT ?A ?BUG\b|\bNOTABUG\b/.test(u)) metaStatus = 'notabug';
      else if (/\bWON'?T ?FIX\b|\bWONTFIX\b/.test(u)) metaStatus = 'wontfix';
      else if (/\bFIXED\b/.test(u)) metaStatus = 'fixed';
      else if (/\bOPEN\b/.test(u)) metaStatus = 'open';
    }

    const sev = meta && (meta.match(/\bP([1-4])\b/) || [])[0] ? meta.match(/\bP([1-4])\b/)[0] : null;

    // THE META LINE WINS. Of the 34 entries filed under "## Open", 29 say FIXED, 4 say
    // NOTABUG and one is genuinely open — entries get fixed and their meta line updated
    // without being moved between sections, so the heading is the stale copy. Trusting the
    // section would have put 34 open bugs on the board where there is 1.
    let status = 'unknown';
    let basis = 'none';
    if (metaStatus) { status = metaStatus; basis = 'meta'; }
    else if (sectionStatus) { status = sectionStatus; basis = 'section'; }

    if (metaStatus && sectionStatus && metaStatus !== sectionStatus) conflicts += 1;

    if (status === 'unknown') {
      skipped.push(`${ref}: no status in the meta line and section ${section ? `"${section}"` : '(none)'} is not a known status`);
    }

    items.push({
      ref,
      kind: PREFIX_KIND[m[1]] || 'bug',
      title: m[3],
      severity: sev,
      status,
      status_basis: basis,
      section,
      raw_meta: meta,
    });
  }

  return {
    items,
    skipped,
    conflicts,
    note: `${items.length} entries; ${conflicts} where the section heading and the meta line disagree`,
  };
}

// ------------------------------------------------------ HOLLOWMAST — dash/requests.jsonl

// A JSON-lines inbox other sessions append to. Keys: id, at, kind, t (title), d (detail),
// status, note.
//
// Reading the record's own `status` field alone says 9 are live (7 new + 2 doing). Reading it
// together with the audit events, and refusing events that predate their record, says ONE is.
// Both readings are defensible and they differ by nine, which is why the basis for every
// status is stored beside it in `status_basis` rather than the board asserting one number.
const REQUEST_STATUS = {
  new: 'open',
  doing: 'open',
  done: 'fixed',
  answered: 'fixed',
  blocked: 'open',
};

// THE FILE HOLDS TWO RECORD TYPES AND THE FIRST DRAFT OF THIS PARSER ONLY KNEW ABOUT ONE.
// It required an `id` and reported everything else as residue — 44 of 94 lines, which the
// residue report is the only reason anybody saw. Reading them:
//
//   39 are EVENTS (`ev` of ack | note | status, with `re` naming the request) — an append-only
//      audit trail, all 39 referencing a request that exists. Not requests, so not residue
//      either; calling them unreadable was as wrong as counting them.
//    5 are REAL REQUESTS WITH NO `id`, keyed `at/status/kind/from/text`. One of them is the
//      owner asking for an AdSense and affiliate plan. Those were being dropped outright —
//      five owner requests that would never have reached the board it exists to feed.
//
// So events are applied rather than discarded, and an id-less request gets a ref synthesised
// from its timestamp. A synthesised ref is honest as long as it is stable and looks
// synthesised, which is why it reads `at:2026-08-18T12:40:00Z` rather than a fake number.
function parseRequestsJsonl(text) {
  const items = [];
  const skipped = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  const records = [];
  const events = [];
  for (const [n, line] of lines.entries()) {
    let r;
    try { r = JSON.parse(line); } catch { skipped.push(`line ${n + 1}: not valid JSON`); continue; }
    if (!r || typeof r !== 'object') { skipped.push(`line ${n + 1}: not an object`); continue; }
    if (r.ev) { events.push(r); continue; }
    if (!r.id && !r.at) { skipped.push(`line ${n + 1}: neither an id nor a timestamp — cannot be referred to`); continue; }
    records.push(r);
  }

  // AN EVENT ONLY CLOSES A RECORD IT IS NOT OLDER THAN, and that guard is load-bearing.
  //
  // The obvious rule — "the append-only log is newer than the record, so the latest status
  // event wins" — produced ZERO open requests, which is the most flattering answer a board
  // can give and was wrong. S-1944 is timestamped 2026-08-19 15:44 UTC with status `new`, and
  // carries a `done` event stamped 14:45 UTC, an HOUR EARLIER. Whatever causes that (writers
  // with different clocks, or an id reused), an event that predates its record cannot be
  // reporting on it, and applying it closes a request that was raised afterwards.
  //
  // Two timestamp formats are in the file — `2026-08-18T17:12:58.774Z` and
  // `2026-08-19 15:44 UTC` — so they are parsed as dates rather than compared as strings.
  // An unparseable stamp on either side means the pair CANNOT BE ORDERED, and an event that
  // cannot be ordered is not applied and is counted instead.
  const when = (v) => {
    if (!v) return null;
    const t = Date.parse(String(v).replace(/\s+UTC$/i, 'Z').replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  };

  let unordered = 0;
  const latestStatus = new Map();
  for (const e of events) {
    if (e.ev !== 'status' || !e.re || !e.value) continue;
    const prev = latestStatus.get(String(e.re));
    const a = when(e.at);
    const b = prev ? when(prev.at) : null;
    if (!prev || (a !== null && b !== null && a > b)) latestStatus.set(String(e.re), e);
  }

  // TWO RECORDS CAN CARRY THE SAME `id`, AND THE RENAME BELOW HIDES WHAT THAT COSTS.
  //
  // The loop appends a `+` to a ref already taken, so the second record survives instead of
  // overwriting the first. That is the right call and it is deliberately visible. But the
  // event index is keyed on the event's own `re` field, which says the ORIGINAL id — so
  // nothing ever names `R027+`, and every event addressed to `R027` is applied to whichever
  // record happened to come first in the file. The second record then keeps its own `status`
  // field forever, with `status_basis: 'record'` as the only trace.
  //
  // Nothing here reported that, and the existing residue could not have: an event landing on
  // the wrong half of a collided pair IS applied, and a renamed record that consequently
  // receives nothing was never skipped. `applied` and `applied to the intended record` are
  // different claims and only the first was being checked. Measured 23 Aug 2026 on the live
  // file: R027 is two unrelated things -- a HOLLOWMAST bug logged 22 Aug 18:33 and a website
  // agent request logged 23 Aug 00:33 -- with four events between them. The request had been
  // marked done at 09:35 and was showing on the board as open.
  //
  // The same file read by dash/read-requests.cjs resolves the collision the OTHER way: it
  // folds with `byId.set`, so the LAST record wins. Two readers, one file, two different
  // answers about who owns an event, neither of them reporting it.
  const idCounts = new Map();
  for (const r of records) {
    if (!r.id) continue;
    const key = String(r.id);
    idCounts.set(key, (idCounts.get(key) || 0) + 1);
  }
  const idCollisions = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id).sort();
  const collided = new Set(idCollisions);
  const eventsOnCollided = events.filter((e) => e.re && collided.has(String(e.re))).length;
  const collidedRows = [];

  const seen = new Set();
  let conflicts = 0;
  let synthesised = 0;
  let fromEvent = 0;

  for (const r of records) {
    let ref = r.id ? String(r.id) : `at:${r.at}`;
    if (!r.id) synthesised += 1;
    const claimedRef = ref;
    while (seen.has(ref)) ref += '+';        // stable and visible; never silently merged
    if (ref !== claimedRef) {
      // A renamed record cannot be matched by any event, because events name the original id.
      // Said out loud rather than left to be inferred from `status_basis: 'record'`.
      collidedRows.push({
        id: claimedRef,
        renamedTo: ref,
        at: r.at || null,
        title: String(r.t || r.text || r.d || '(no title)').slice(0, 120),
      });
      skipped.push(
        `${claimedRef}: a second record carries this id and was renamed ${ref}.`
        + ` No event names ${ref}, so every event addressed to ${claimedRef} was applied to the`
        + ` FIRST record instead and this one keeps its own status field. The two records are`
        + ` not the same request.`,
      );
    }
    seen.add(ref);

    const raw = (r.status || '').toLowerCase();
    let status = REQUEST_STATUS[raw] || 'unknown';
    let basis = raw ? 'record' : 'none';

    const ev = latestStatus.get(ref);
    if (ev) {
      const evStatus = REQUEST_STATUS[String(ev.value).toLowerCase()] || 'unknown';
      const evAt = when(ev.at);
      const recAt = when(r.at);
      const ordered = evAt !== null && recAt !== null;
      if (evStatus === 'unknown') {
        // nothing to apply
      } else if (!ordered) {
        unordered += 1;
        skipped.push(`${ref}: a ${ev.value} event could not be ordered against the record (unparseable timestamp) — not applied`);
      } else if (evAt < recAt) {
        unordered += 1;
        skipped.push(`${ref}: a ${ev.value} event is stamped ${ev.at}, EARLIER than the record's ${r.at} — not applied, the request stands`);
      } else {
        if (status !== 'unknown' && status !== evStatus) conflicts += 1;
        status = evStatus;
        basis = 'event';
        fromEvent += 1;
      }
    }

    if (status === 'unknown') {
      skipped.push(`${ref}: status ${raw ? `"${raw}" not recognised` : 'absent and no status event — predates the field'}`);
    }

    items.push({
      ref,
      // The inbox's own kind vocabulary is richer than the board's and is kept as written.
      kind: (r.kind || 'unknown').toLowerCase(),
      title: String(r.t || r.text || r.d || '(no title)').slice(0, 300),
      severity: null,
      status,
      status_basis: basis,
      section: null,
      raw_meta: r.at ? `logged ${r.at}${r.from ? ` by ${r.from}` : ''}` : null,
    });
  }

  const orphanEvents = events.filter((e) => e.re && !seen.has(String(e.re))).length;
  return {
    items,
    skipped,
    conflicts,
    // Additive. Every existing caller reads items/skipped/conflicts/note and is unaffected.
    // These three can all be empty or zero -- they are on a file with no duplicate id, which
    // is what makes a non-zero answer mean something. A counter never shown returning nothing
    // is decoration.
    idCollisions,
    eventsOnCollided,
    collidedRows,
    note: `${items.length} requests from ${lines.length} lines · ${events.length} audit events`
      + ` (${fromEvent} set a status, ${orphanEvents} reference nothing)`
      + ` · ${synthesised} had no id and were keyed by timestamp`
      + (unordered ? ` · ${unordered} event(s) NOT applied because they could not be ordered after their record` : "")
      + (idCollisions.length
        ? ` · ${idCollisions.length} DUPLICATE id(s) (${idCollisions.join(', ')}) carrying ${eventsOnCollided} event(s) that cannot be attributed to a single record`
        : ""),
  };
}

// ------------------------------------------------------------------------------ sources

const SOURCES = [
  {
    id: 'hollowmast-bugs',
    project: 'HOLLOWMAST',
    file: path.join(WORKSPACE, 'Survive', 'BUGS.md'),
    parse: parseBugsMd,
  },
  {
    id: 'hollowmast-requests',
    project: 'HOLLOWMAST',
    file: path.join(WORKSPACE, 'Survive', 'dash', 'requests.jsonl'),
    parse: parseRequestsJsonl,
  },
].map((s) => ({ ...s, exists: () => fs.existsSync(s.file) }));

// ------------------------------------------------------------------------- coverage
//
// WHICH PROJECTS THIS BOARD CAN SEE, AND WHICH IT CANNOT. Added 23 Aug 2026, when the owner
// asked for sessions to work the whole workspace rather than only HOLLOWMAST.
//
// `SOURCES` above holds two entries and both are HOLLOWMAST. Nothing said so. A board built
// from it answers "11 open" and reads as the state of the workspace, when it is the state of
// one project out of thirteen — the most flattering possible failure, and the one nobody
// investigates, because a short list of open bugs looks like good news rather than like a
// missing input. The parsers in this file each report their residue for exactly that reason;
// the SOURCES LIST ITSELF had no such report, so the residue it dropped was whole projects.
//
// This does not invent trackers. Only HOLLOWMAST keeps one — verified by searching the
// workspace for BUGS/TODO/BACKLOG/TASKS/ISSUES/REQUESTS/ROADMAP files at any of the top three
// depths, which returns `Survive/BUGS.md`, `Survive/dash/requests.jsonl` and
// `Fallow/docs/ROADMAP.md` and nothing else. So the honest thing is not to fabricate a queue
// per project; it is to say which projects have one, so an empty column reads as "no tracker
// here" rather than as "nothing wrong here". Those are different facts and they must not look
// the same.
function coverage() {
  // Required lazily. `projects.js` builds an express Router at require time and this file is
  // loaded by it indirectly through the board route; taking the dependency at module scope
  // makes the two files a cycle, and the cycle resolves to an empty object rather than to an
  // error — a silent half-loaded module, which is worse than a crash.
  let PROJECTS = [];
  try { ({ PROJECTS } = require('./routes/projects')); } catch (e) { PROJECTS = []; }

  const withTracker = new Map();
  for (const s of SOURCES) {
    if (!withTracker.has(s.project)) withTracker.set(s.project, []);
    withTracker.get(s.project).push({ id: s.id, file: s.file, exists: s.exists() });
  }

  const projects = PROJECTS.map((p) => ({
    project: p.name,
    dir: p.dir,
    track: p.track || null,
    sources: withTracker.get(p.name) || [],
    tracked: withTracker.has(p.name),
  }));

  // A project label appearing in SOURCES but not in projects.js is a vocabulary break, not a
  // rounding error: it means the board is filing items under a name the workspace does not
  // recognise, so they can never be joined to anything. Reported rather than dropped.
  const declared = new Set(PROJECTS.map((p) => p.name));
  const undeclared = [...withTracker.keys()].filter((n) => !declared.has(n));

  return {
    projects,
    trackedCount: projects.filter((p) => p.tracked).length,
    totalCount: projects.length,
    untracked: projects.filter((p) => !p.tracked).map((p) => p.project),
    undeclared,
  };
}

// ------------------------------------------------------------------------------ import

function importAll(db) {
  const at = new Date().toISOString();
  const out = [];

  const ins = db.prepare(`
    INSERT INTO board_items (source, project, ref, kind, title, severity, status, status_basis,
                             section, raw_meta, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source, ref) DO UPDATE SET
      kind = excluded.kind, title = excluded.title, severity = excluded.severity,
      status = excluded.status, status_basis = excluded.status_basis,
      section = excluded.section, raw_meta = excluded.raw_meta, last_seen = excluded.last_seen`);

  const run = db.prepare('INSERT INTO board_imports (source, at, ok, parsed, skipped, conflicts, note) VALUES (?,?,?,?,?,?,?)');

  for (const s of SOURCES) {
    // COULD NOT LOOK is recorded as ok = 0 and nothing is deleted. An unreadable tracker must
    // never empty the board's copy of it — that would turn a missing file into "no open bugs",
    // which is the most flattering possible failure and the one nobody investigates.
    if (!s.exists()) {
      run.run(s.id, at, 0, 0, 0, 0, `file not found: ${s.file}`);
      out.push({ source: s.id, ok: false, note: 'file not found' });
      continue;
    }

    let text;
    try { text = fs.readFileSync(s.file, 'utf8'); }
    catch (e) {
      run.run(s.id, at, 0, 0, 0, 0, `unreadable: ${String((e && e.message) || e).slice(0, 150)}`);
      out.push({ source: s.id, ok: false, note: 'unreadable' });
      continue;
    }

    let parsed;
    try { parsed = s.parse(text); }
    catch (e) {
      run.run(s.id, at, 0, 0, 0, 0, `parser threw: ${String((e && e.message) || e).slice(0, 150)}`);
      out.push({ source: s.id, ok: false, note: 'parser threw' });
      continue;
    }

    db.withTransaction(() => {
      for (const it of parsed.items) {
        ins.run(s.id, s.project, it.ref, it.kind, it.title, it.severity, it.status,
          it.status_basis, it.section, it.raw_meta, at, at);
      }
      // Rows the file no longer contains are dropped, so the mirror stays exact — but ONLY on
      // a run that actually parsed something. A parse that returns nothing is treated as a
      // failure to look, above, and never reaches here.
      if (parsed.items.length) {
        db.prepare('DELETE FROM board_items WHERE source = ? AND last_seen <> ?').run(s.id, at);
      }
    });

    run.run(s.id, at, 1, parsed.items.length, parsed.skipped.length, parsed.conflicts, parsed.note);
    out.push({
      source: s.id,
      ok: true,
      parsed: parsed.items.length,
      skipped: parsed.skipped.length,
      conflicts: parsed.conflicts,
      note: parsed.note,
      residue: parsed.skipped.slice(0, 10),
      // Surfaced only by a parser that computes them, so a source with no id concept omits
      // them rather than reporting a zero it never measured. Absent and zero are different
      // claims here: absent means this parser does not key on ids at all, zero means it
      // looked and every id was unique.
      ...(parsed.idCollisions
        ? {
          idCollisions: parsed.idCollisions,
          eventsOnCollided: parsed.eventsOnCollided,
          collidedRows: parsed.collidedRows,
        }
        : {}),
    });
  }

  return { at, sources: out };
}

module.exports = { SOURCES, importAll, coverage, parseBugsMd, parseRequestsJsonl };
