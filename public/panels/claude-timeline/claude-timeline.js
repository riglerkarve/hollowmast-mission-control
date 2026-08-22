//
// claude-timeline — the workspace's own dated history rendered as a browsable
// timeline. Reads CLAUDE.md through /api/claude-timeline and shows every dated
// entry sorted newest-first, grouped by month.
//
// The file is the architecture memory — settled decisions, inline dated notes,
// and working-principle updates. This panel does not interpret them; it lays
// them out by date so the owner can browse when things were settled and how
// the thinking evolved.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// CLAUDE.md prose is escaped, not parsed — same discipline as decisions.js.
// A half-rendered markdown renderer that swallows a ** changes what was recorded.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

// Format an ISO date as "DD Mon YYYY" for display.
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return esc(iso);
  return `${parseInt(m[3], 10)} ${MONTH_ABBR[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

// Month key for grouping: "YYYY-MM" → "Month YYYY" header.
const MONTH_FULL = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];
function monthHeader(key) {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return esc(key);
  return `${MONTH_FULL[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

function monthKey(iso) {
  return String(iso).slice(0, 7);
}

let root = null;
let state = null;

function entryHTML(e) {
  return `<article class="ct-item">
    <div class="ct-marker"></div>
    <div class="ct-content">
      <p class="ct-date">${fmtDate(e.date)}</p>
      <span class="ct-badge">${esc(e.section)}</span>
      <p class="ct-text">${prose(e.text)}</p>
    </div>
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel ct-panel">
      <h1 class="panel-header">CLAUDE.md timeline</h1>
      <p class="ct-alarm">Could not read CLAUDE.md — ${esc(state.error)}.
      That is a failure to look, not an empty file.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel ct-panel">
      <h1 class="panel-header">CLAUDE.md timeline</h1>
      <p class="ct-loading">Reading CLAUDE.md…</p>
    </section>`;
    return;
  }

  const { entries, totalEntries, fileExists } = state.data;

  if (!fileExists) {
    root.innerHTML = `<section class="panel ct-panel">
      <h1 class="panel-header">CLAUDE.md timeline</h1>
      <p class="ct-empty">${esc(state.data.state || 'CLAUDE.md was not found.')}</p>
    </section>`;
    return;
  }

  if (!entries || entries.length === 0) {
    root.innerHTML = `<section class="panel ct-panel">
      <h1 class="panel-header">CLAUDE.md timeline</h1>
      <p class="ct-empty">No dated entries found in CLAUDE.md. The file exists but
      contains no recognizable dates — that is a parse gap, not an empty history.</p>
    </section>`;
    return;
  }

  // Sort entries by date descending.
  const sorted = [...entries].sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    return db < da ? -1 : db > da ? 1 : 0;
  });

  // Group by month.
  const groups = [];
  let currentKey = null;
  let currentGroup = [];
  for (const e of sorted) {
    const key = monthKey(e.date);
    if (key !== currentKey) {
      if (currentGroup.length) groups.push({ key: currentKey, items: currentGroup });
      currentKey = key;
      currentGroup = [];
    }
    currentGroup.push(e);
  }
  if (currentGroup.length) groups.push({ key: currentKey, items: currentGroup });

  const timelineHTML = groups.map((g) => {
    return `<div class="ct-month-group">
      <h2 class="ct-month">${monthHeader(g.key)}</h2>
      ${g.items.map(entryHTML).join('')}
    </div>`;
  }).join('');

  root.innerHTML = `<section class="panel ct-panel">
    <h1 class="panel-header">CLAUDE.md timeline</h1>
    <p class="ct-count">${totalEntries} dated entr${totalEntries === 1 ? 'y' : 'ies'}</p>
    ${timelineHTML}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/claude-timeline')).json();
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
    renderLede('claude-timeline', el);
  },
  unmount() { root = null; state = null; },
};