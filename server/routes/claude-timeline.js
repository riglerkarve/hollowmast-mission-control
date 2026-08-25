'use strict';
//
// claude-timeline.js — reads CLAUDE.md and extracts dated entries as a timeline.
//
// GET /api/claude-timeline — returns { entries: [{ date, text, section }],
//   totalEntries, skipped: { noYearContext, unparseable, generatedByLine,
//   tableRow, htmlComment, total }, fileExists }
//
// The workspace's architecture memory (CLAUDE.md) carries dated decisions,
// settled sections, and inline dated notes. This route reads the file and
// extracts every entry with a recognizable date, so the panel can render
// them as a browsable timeline sorted newest-first.
//
// Absence and failure must look different (law 4): a missing file returns
// fileExists: false, not an empty parse.
//
// CLAUDE.md's dating convention (law 3 — a filter must report its residue,
// and what it does not key on): the year is stated once, usually at a
// section heading ("Settled — 17 August 2026"), and later inline references
// within the same year drop it ("confirmed 17 Aug", "18 Aug"). The parser
// tracks the most recently stated explicit year as it reads down the file
// and applies it to bare "DD Mon"/"DD Month" matches that carry no year of
// their own. This is a single-year-at-a-time inference: it does NOT key on
// anything that would let a bare date resolve against a year stated further
// down the file, and it cannot resolve a bare date appearing before any
// explicit year has been seen — those are counted as skipped, not guessed.
const express = require('express');
const fs = require('node:fs');

const router = express.Router();

const CLAUDE_MD = 'C:/Users/jcwhi/Claude Outputs/CLAUDE.md';

// Month names for "DD Month YYYY" parsing.
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_MAP = {};
MONTHS.forEach((m, i) => { MONTH_MAP[m.toLowerCase()] = i + 1; });

// Also match short month forms like "Aug", "Sep".
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
SHORT_MONTHS.forEach((m, i) => { MONTH_MAP[m.toLowerCase()] = i + 1; });

// Convert "DD Month YYYY" to ISO "YYYY-MM-DD". Returns null if the month
// text isn't a recognized month name (the "unparseable" case).
function toISO(day, monthName, year) {
  const mo = MONTH_MAP[String(monthName).toLowerCase()];
  if (!mo) return null;
  const d = String(day).padStart(2, '0');
  const m = String(mo).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

// Match an explicit date that carries its own 4-digit year. Returns
// { iso, year } or null.
function matchExplicitDate(text) {
  // YYYY-MM-DD
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, year: m[1] };

  // DD Month(YYYY) / DD Mon YYYY — e.g. "17 August 2026" or "17 Aug 2026"
  m = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const iso = toISO(m[1], m[2], m[3]);
    if (iso) return { iso, year: m[3] };
    // Matched the shape (day + word + year) but the word isn't a month —
    // unparseable, not absent. Caller distinguishes this from "no match".
    return { iso: null, year: null, unparseable: true };
  }

  return null;
}

// Alternation of every recognized month name/abbreviation, longest-first so
// "August" isn't cut short by "Aug". Anchors the bare-date match on an
// actual month word — this is what keeps the parser from treating any
// "<number> <word>" pair (e.g. "20 tok/s", "93 recorded", "3000 Mission")
// as a date candidate. Only text that names a real month is a date; matching
// on "any capitalized word" would manufacture false residue, not report it.
const MONTH_ALTERNATION = Object.keys(MONTH_MAP)
  .sort((a, b) => b.length - a.length)
  .join('|');
const BARE_DATE_RE = new RegExp(
  `(\\d{1,2})\\s+(${MONTH_ALTERNATION})\\b(?!\\s+\\d{4})`,
  'i'
);

// Match a bare date with no year — e.g. "17 Aug" or "18 August". Requires
// that no 4-digit year immediately follows (that shape is handled by
// matchExplicitDate). Returns { day, month } or null.
function matchBareDate(text) {
  const m = text.match(BARE_DATE_RE);
  if (!m) return null;
  return { day: m[1], month: m[2] };
}

// Extract the text content of a line, stripped of markdown emphasis markers
// and the date portion, so the timeline shows the substance not the markup.
function cleanText(line) {
  return line
    .replace(/^#+\s*/, '')          // heading markers
    .replace(/^\s*[-*]\s+/, '')     // list bullets
    .replace(/^\s*\|.*\|\s*$/, '')  // skip table rows
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/\*(.+?)\*/g, '$1')     // italic
    .replace(/`(.+?)`/g, '$1')       // code
    .trim();
}

router.get('/', (req, res) => {
  let raw;
  try {
    raw = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch {
    return res.json({
      fileExists: false,
      entries: [],
      state: 'CLAUDE.md not found. That is a missing file, not a failed parse.',
    });
  }

  const lines = raw.split(/\r?\n/);
  const entries = [];
  let currentSection = '';
  let settledDate = null;

  // The most recently seen explicit 4-digit year, read top-to-bottom. Bare
  // "DD Mon" matches inherit this. Starts unset: a bare date above the
  // first explicit year in the file has no context to infer from.
  let currentYear = null;

  const skipped = {
    noYearContext: 0,   // bare "DD Mon" seen before any explicit year
    unparseable: 0,     // date-shaped text whose month word didn't resolve
    generatedByLine: 0, // the stamp-tool comment line, excluded on purpose
    tableRow: 0,        // a table row carrying a date, excluded by design
    htmlComment: 0,     // an HTML comment line carrying a date, excluded by design
  };

  // Cheap pre-check: does this line contain anything date-shaped at all
  // (explicit or bare)? Used only to decide whether a structurally-excluded
  // line (table row, HTML comment) should count toward residue — so those
  // exclusions are visible too, not just the convention-parsing ones.
  function looksDated(text) {
    return /\d{4}-\d{2}-\d{2}/.test(text) || BARE_DATE_RE.test(text);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track ## headings as the current section.
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      const headingText = headingMatch[1].trim();

      // "## Settled — 17 August 2026" — capture the date and use as section.
      const settledMatch = headingText.match(/Settled.*?(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
      if (settledMatch) {
        const explicit = matchExplicitDate(settledMatch[1]);
        const iso = explicit && explicit.iso;
        if (explicit && explicit.year) currentYear = explicit.year;
        settledDate = iso;
        currentSection = 'Settled';
        // The heading itself is an entry: the settled date.
        if (iso) {
          entries.push({
            date: iso,
            text: 'Settled decisions — architecture, not preference.',
            section: 'Settled',
          });
        }
        continue;
      }

      currentSection = headingText.replace(/\s*[—–-]\s*.*/, '').trim();
      continue;
    }

    // Skip sub-headings (###), tables, empty lines, horizontal rules.
    if (/^###\s+/.test(line)) {
      // Sub-heading may carry a date too — e.g. "### Working on this machine"
      // but we only track it as context, not an entry.
      continue;
    }
    if (/^\s*$/.test(line)) continue;
    if (/^---/.test(line)) continue;
    if (/^\s*\|/.test(line)) {
      if (looksDated(line)) skipped.tableRow++;
      continue;
    }
    if (/^<!--/.test(line)) {
      if (looksDated(line)) skipped.htmlComment++;
      continue;
    }
    if (/^```/.test(line)) continue;

    // The generated-counts comment line carries a date (the "Last:" stamp)
    // but is tool output, not a workspace event — excluded on purpose, and
    // counted so the exclusion is visible rather than silent.
    if (/Generated by/.test(line) && /\d{4}-\d{2}-\d{2}/.test(line)) {
      skipped.generatedByLine++;
      continue;
    }

    // Look for a date in the line: explicit (own year) first, else a bare
    // date inheriting the current section's year.
    let dateISO = null;
    const explicit = matchExplicitDate(line);
    if (explicit) {
      if (explicit.unparseable) {
        skipped.unparseable++;
        continue;
      }
      dateISO = explicit.iso;
      currentYear = explicit.year;
    } else {
      const bare = matchBareDate(line);
      if (bare) {
        if (!currentYear) {
          skipped.noYearContext++;
          continue;
        }
        const iso = toISO(bare.day, bare.month, currentYear);
        if (!iso) {
          skipped.unparseable++;
          continue;
        }
        dateISO = iso;
      }
    }
    if (!dateISO) continue;

    const text = cleanText(line);
    if (!text) continue;

    // Determine the section label.
    let section = currentSection || 'Notes';

    // If the line itself names a section before a dash (e.g. "The sessions are a
    // team — 19 Aug 2026"), the text before the dash is the topic label.
    const beforeDate = line.split(/\d{1,2}\s+[A-Za-z]+(?:\s+\d{4})?/)[0];
    const dashMatch = beforeDate.match(/^(.+?)[\s]*[—–-][\s]*$/);
    if (dashMatch) {
      const label = dashMatch[1]
        .replace(/\*+/g, '')
        .replace(/^[-*]\s*/, '')
        .trim();
      if (label) section = label;
    }

    // For lines within the Settled section, use "Settled" as section.
    if (currentSection === 'Settled') {
      section = 'Settled';
    }

    entries.push({
      date: dateISO,
      text,
      section,
    });
  }

  // Deduplicate entries with identical date + text.
  const seen = new Set();
  const deduped = entries.filter((e) => {
    const key = `${e.date}|${e.text}|${e.section}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  skipped.total = skipped.noYearContext + skipped.unparseable
    + skipped.generatedByLine + skipped.tableRow + skipped.htmlComment;

  res.json({
    entries: deduped,
    totalEntries: deduped.length,
    skipped,
    fileExists: true,
  });
});

module.exports = router;
