//
// habit-tracker — shows which habits are being dropped and their gap pattern,
// NOT a streak counter. The backlog item's own words: "Habit tracking that
// derives which habits get dropped and when, not a streak counter."
//
// WHAT THIS PANEL IS NOT.
//   It is not a streak counter. It does not show "you did this 12 days in a row"
//   and it does not celebrate a run. A streak counter rewards consistency, which
//   is the opposite of what is useful here: the question is "which habits are
//   falling off?", and the answer is in the GAPS, not in the runs.
//
// WHAT IT IS.
//   A read-out of each habit's completion pattern: how many times done, when
//   last done, how long ago, and the longest gap between completions. Habits
//   that are being dropped (done 3+ times but not in 14+ days) are highlighted
//   with the accent and sorted to the top, because they are the section the
//   owner most needs to see. The summary is three counts: dropped, active, fresh.
//
// ABSENCE AND FAILURE LOOK DIFFERENT.
//   Empty (no chores at all) is a 200 with a message, not a blank. Error (the
//   fetch threw) is an alarm, not a quiet empty. Loading is its own state.
//   These three never share the same markup.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const day = (s) => String(s || '').slice(0, 10);

let root = null;
let state = null;

// Pluralise a noun: "1 day" vs "14 days".
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Format the gap pattern for a habit card. This is the key metric — not a
// streak, but the longest stretch between completions. Shown as a number of
// days with a label, so it reads as a measurement rather than a score.
function gapHTML(h) {
  if (h.timesDone < 2) {
    return '<span class="ht-gap ht-gap-none">No pattern yet</span>';
  }
  const gap = h.longestGap;
  const cls = gap >= 14 ? ' ht-gap-wide' : '';
  return `<span class="ht-gap${cls}">Longest gap: ${plural(gap, 'day')}</span>`;
}

// Format the "last done" line. Null is handled explicitly: never done is
// ABSENCE, not zero days.
function lastDoneHTML(h) {
  if (!h.lastDone) {
    return '<span class="ht-never">Never recorded</span>';
  }
  const d = h.daysSinceLast;
  let when = `Last done ${esc(day(h.lastDone))}`;
  if (d === 0) when += ' (today)';
  else if (d === 1) when += ' (yesterday)';
  else when += ` (${plural(d, 'day')} ago)`;
  return `<span class="ht-when">${esc(when)}</span>`;
}

// The status badge. 'dropped' is the one the owner needs to see first.
function badgeHTML(h) {
  if (h.status === 'dropped') return '<span class="ht-badge ht-badge-dropped">dropped</span>';
  if (h.status === 'fresh') return '<span class="ht-badge ht-badge-fresh">fresh</span>';
  if (h.status === 'active') return '<span class="ht-badge ht-badge-active">active</span>';
  if (h.status === 'dormant') return '<span class="ht-badge ht-badge-dormant">dormant</span>';
  return '';
}

function cardHTML(h) {
  const droppedCls = h.status === 'dropped' ? ' ht-dropped' : '';
  const times = plural(h.timesDone, 'time');

  return `<article class="ht-card${droppedCls}">
    ${badgeHTML(h)}
    <h3 class="ht-name">${esc(h.name)}</h3>
    <div class="ht-row">
      <span class="ht-count">${esc(times)} done</span>
      ${lastDoneHTML(h)}
    </div>
    <div class="ht-row ht-gap-row">
      ${gapHTML(h)}
    </div>
  </article>`;
}

function render() {
  if (!root || !state) return;

  // ERROR STATE — the fetch threw. This is a failure to look, not an empty list.
  if (state.error) {
    root.innerHTML = `<section class="panel ht-panel">
      <h1>Habits</h1>
      <p class="ht-alarm">Could not read habit data — ${esc(state.error)}.
      That is a failure to look, not an empty record.</p>
    </section>`;
    return;
  }

  // LOADING STATE — fetch in flight, no data yet.
  if (!state.data) {
    root.innerHTML = `<section class="panel ht-panel"><h1>Habits</h1>
      <p class="ht-loading">Reading the pattern…</p></section>`;
    return;
  }

  const { habits, totalHabits, droppedCount, freshCount, activeCount, state: apiState } = state.data;

  // EMPTY STATE — the API returned 'empty'. This is "no chores exist", not a
  // failure, and gets its own message rather than a blank or an alarm.
  if (apiState === 'empty') {
    root.innerHTML = `<section class="panel ht-panel">
      <h1>Habits</h1>
      <p class="ht-empty">No habits yet. Habits are derived from the chores you
      record in the lifestyle panel — add one and the pattern starts forming
      from the first time you mark it done.</p>
    </section>`;
    return;
  }

  if (!habits.length) {
    root.innerHTML = `<section class="panel ht-panel">
      <h1>Habits</h1>
      <p class="ht-empty">No habit data to show.</p>
    </section>`;
    return;
  }

  // OK STATE — render the summary and the sorted habit cards.
  const cards = habits.map(cardHTML).join('');

  root.innerHTML = `<section class="panel ht-panel">
    <h1>Habits</h1>
    <p class="ht-lede">Which habits are being dropped, derived from the gaps
      between completions — not a streak counter. A habit done three or more
      times that has not been recorded in 14 days is flagged as dropped.</p>

    <div class="ht-summary">
      <span class="ht-stat ht-stat-dropped"><span class="ht-stat-n">${droppedCount}</span> dropped</span>
      <span class="ht-stat ht-stat-active"><span class="ht-stat-n">${activeCount}</span> active</span>
      <span class="ht-stat ht-stat-fresh"><span class="ht-stat-n">${freshCount}</span> fresh</span>
    </div>

    <div class="ht-list">
      ${cards}
    </div>
  </section>`;
}

async function load() {
  try {
    const r = await fetch('/api/habit-tracker');
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `${r.status}`);
    }
    state.data = await r.json();
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
    renderLede('habit-tracker', el);
  },
  unmount() { root = null; state = null; },
};