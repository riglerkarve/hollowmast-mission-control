//
// decision-radar — decisions whose revisit date is approaching — not just the ones
// already overdue. A decision that states what would change it and never gets looked
// at again is the failure the field exists to prevent.
//
// THREE SECTIONS, ONE FETCH.
//   'Approaching' — decisions whose recheckAt is within the next 30 days but not yet
//   due. The radar: not the alarm, the early warning. Shows text, decidedBy, recheckAt,
//   and a countdown (days until recheck). Sorted by recheckAt ascending.
//   'Overdue now' — decisions where due=true (recheckAt has passed). Highlighted with
//   the accent so it cannot be missed. Same fields plus the revisitWhen condition.
//   'No recheck date' — decisions with no recheckAt. A compact list of text + decidedBy.
//   Conditions without a date — still visible, not time-sensitive.
//
// NOTHING HERE DERIVES DUE. The due flag comes from the route, which uses the same
// calendar-date check as team.js's dueDecisions(). Approaching is a display
// classification (today to today+30d), not a due recompute — a panel that recomputed
// "is this due" would agree with the route until one was edited, and then disagree
// without either erroring.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Decision prose is escaped, not parsed. A half-implemented markdown renderer that
// swallows a `**` is worse than plain text, because it silently changes what was recorded.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

const day = (s) => String(s || '').slice(0, 10);

const DAY_MS = 24 * 60 * 60 * 1000;

// Days from today (local) to the date portion of an ISO string.
// Positive = future, negative = past, 0 = today. Returns null if no date.
function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY_MS);
}

let root = null;
let state = null;

// Split the decision list into the three radar bands. Does not mutate the source
// objects except for attaching _days (a transient display value).
function classify(decisions) {
  const approaching = [];
  const overdue = [];
  const noDate = [];
  for (const d of decisions) {
    if (d.due) {
      overdue.push(d);
    } else if (d.recheckAt) {
      const days = daysUntil(d.recheckAt);
      if (days != null && days >= 0 && days <= 30) {
        d._days = days;
        approaching.push(d);
      } else if (days != null && days < 0) {
        // recheckAt passed but the route did not flag it due — treat as overdue
        // defensively, the same way a human reading the date would.
        overdue.push(d);
      }
      // days > 30: not on the radar yet; stays in the log, not here.
    } else {
      noDate.push(d);
    }
  }
  approaching.sort((a, b) => String(a.recheckAt).localeCompare(String(b.recheckAt)));
  overdue.sort((a, b) => String(a.recheckAt || '').localeCompare(String(b.recheckAt || '')));
  return { approaching, overdue, noDate };
}

function countdownHTML(d) {
  const days = d._days != null ? d._days : daysUntil(d.recheckAt);
  if (days == null) return '';
  let label;
  if (days === 0) label = 'today';
  else if (days === 1) label = 'in 1 day';
  else label = 'in ' + days + ' days';
  return '<span class="dr-countdown">' + esc(label) + '</span>';
}

function approachingCardHTML(d) {
  const who = d.decidedBy || 'unknown';
  return '<article class="dr-card dr-approaching">'
    + '<h3 class="dr-text">' + prose(d.text) + '</h3>'
    + '<p class="dr-attr"><span class="dr-who">' + esc(who) + '</span>'
    + '<span class="dr-when">recheck ' + esc(day(d.recheckAt)) + '</span>'
    + countdownHTML(d) + '</p>'
    + '</article>';
}

function overdueCardHTML(d) {
  const who = d.decidedBy || 'unknown';
  const revisit = d.revisitWhen
    ? '<div class="dr-field"><h5>Revisit when</h5><p>' + prose(d.revisitWhen) + '</p></div>'
    : '';
  return '<article class="dr-card dr-overdue">'
    + '<span class="dr-badge">overdue</span>'
    + '<h3 class="dr-text">' + prose(d.text) + '</h3>'
    + '<p class="dr-attr"><span class="dr-who">' + esc(who) + '</span>'
    + '<span class="dr-when">recheck ' + esc(day(d.recheckAt)) + '</span></p>'
    + revisit
    + '</article>';
}

function noDateItemHTML(d) {
  const who = d.decidedBy || 'unknown';
  return '<li class="dr-compact"><span class="dr-text-compact">' + prose(d.text) + '</span>'
    + '<span class="dr-who-compact">' + esc(who) + '</span></li>';
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = '<section class="panel dr-panel">'
      + '<h1>Decision radar</h1>'
      + '<p class="dr-alarm">Could not read decisions — ' + esc(state.error) + '. '
      + 'That is a failure to look, not an empty radar.</p>'
      + '</section>';
    return;
  }

  if (!state.data) {
    root.innerHTML = '<section class="panel dr-panel"><h1>Decision radar</h1>'
      + '<p class="dr-loading">Scanning the radar\u2026</p></section>';
    return;
  }

  const decisions = (state.data.decisions || []).filter((d) => !d.superseded);
  const { approaching, overdue, noDate } = classify(decisions);

  const isEmpty = approaching.length === 0 && overdue.length === 0;

  const sections = [];

  if (isEmpty) {
    sections.push('<p class="dr-empty">No decisions with approaching revisit dates. '
      + 'Either nothing has a recheck date, or nothing is near it.</p>');
  } else {
    if (approaching.length) {
      sections.push('<h2 class="dr-h2">Approaching <span class="dr-n">' + approaching.length + '</span></h2>');
      sections.push(approaching.map(approachingCardHTML).join(''));
    }
    if (overdue.length) {
      sections.push('<h2 class="dr-h2">Overdue now <span class="dr-n dr-n-overdue">' + overdue.length + '</span></h2>');
      sections.push(overdue.map(overdueCardHTML).join(''));
    }
  }

  if (noDate.length) {
    sections.push('<h2 class="dr-h2">No recheck date <span class="dr-n">' + noDate.length + '</span></h2>');
    sections.push('<ul class="dr-compact-list">' + noDate.map(noDateItemHTML).join('') + '</ul>');
  }

  root.innerHTML = '<section class="panel dr-panel">'
    + '<h1>Decision radar</h1>'
    + '<p class="dr-lede">Decisions whose revisit date is approaching \u2014 not just the ones '
    + 'already overdue. A decision that states what would change it and never gets looked at '
    + 'again is the failure the field exists to prevent.</p>'
    + sections.join('\n')
    + '</section>';
}

async function load() {
  try {
    state.data = await (await fetch('/api/decisions')).json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { data: null, error: null };
    render();
    load();
    renderLede('decision-radar', el);
  },
  unmount() { root = null; state = null; },
};