//
// changes — a log of what shipped, with the unsigned ones highlighted so they cannot hide
// inside the larger feed.
//
// The activity stream shows everything that happened; this panel narrows to the changes
// (commits and handover filings) and asks the one question that matters about each: was it
// signed off, or did it ship without an explicit decision behind it? Unsigned changes are
// flagged with a border so a reader scanning the list sees them first, without having to
// filter — though the filter bar (All | Signed | Unsigned) is there when they do want to
// narrow.
//
// STALE ITEMS ARE MUTED, NOT HIDDEN — the same rule the activity panel follows: a change
// from five days ago is still real, it is just not recent, and equal visual weight makes
// the list harder to scan. The 3-day cutoff is display, not data.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Agent badge colours — same mapping as the activity panel.
function badgeClass(who) {
  const name = String(who || '').toLowerCase();
  if (name.includes('claude') || name.includes('hermes')) return 'ch-badge-accent';
  if (name.includes('codex')) return 'ch-badge-blue';
  if (name.includes('ollama')) return 'ch-badge-green';
  if (name === 'you') return 'ch-badge-ink';
  return 'ch-badge-ink';
}

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '?';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return `${Math.floor(secs / 604800)}w ago`;
}

function isStale(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return false;
  return Date.now() - then > 3 * 86400 * 1000;
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'signed', label: 'Signed' },
  { id: 'unsigned', label: 'Unsigned' },
];

let root = null;
let state = { filter: 'all', items: [], notes: null, error: null };
let timer = null;
let loadToken = 0;

function filterBar() {
  const counts = { all: state.items.length, signed: 0, unsigned: 0 };
  for (const item of state.items) {
    if (item.signedOff) counts.signed += 1;
    else counts.unsigned += 1;
  }
  return FILTERS.map((f) => {
    const on = state.filter === f.id ? ' on' : '';
    return `<button class="ch-tab${on}" data-f="${f.id}">${esc(f.label)}<span>${counts[f.id] || 0}</span></button>`;
  }).join('');
}

function itemRow(item) {
  const stale = isStale(item.when) ? ' ch-stale' : '';
  const unsigned = !item.signedOff ? ' ch-unsigned' : '';
  const badge = badgeClass(item.who);
  const where = item.project ? `<span class="ch-where">${esc(item.project)}</span>` : '';
  const flag = item.signedOff
    ? `<span class="ch-flag ch-flag-signed" title="Signed off">✓</span>`
    : `<span class="ch-flag ch-flag-unsigned" title="Shipped without explicit sign-off">!</span>`;
  return `<div class="ch-item${stale}${unsigned}" data-signed="${item.signedOff ? '1' : '0'}">
    ${flag}
    <span class="ch-kind">${esc(item.kind)}</span>
    <span class="ch-time">${esc(relTime(item.when))}</span>
    <span class="ch-badge ${badge}">${esc(item.who)}</span>
    <span class="ch-what">${esc(item.title)}</span>
    <span class="ch-ref">${esc(item.ref)}</span>
    ${where}
  </div>`;
}

function render() {
  if (!root) return;
  let filtered = state.items;
  if (state.filter === 'signed') filtered = state.items.filter((i) => i.signedOff);
  else if (state.filter === 'unsigned') filtered = state.items.filter((i) => !i.signedOff);

  const unsignedCount = state.items.filter((i) => !i.signedOff).length;

  const notesHtml = state.notes && state.notes.length
    ? `<div class="ch-notes">${state.notes.map((n) =>
        `<div class="ch-note">Could not read ${esc(n.source)}: ${esc(n.error)}</div>`
      ).join('')}</div>`
    : '';

  const alertHtml = unsignedCount > 0 && state.filter !== 'unsigned'
    ? `<div class="ch-alert">${unsignedCount} change${unsignedCount === 1 ? '' : 's'} shipped without explicit sign-off. <button class="ch-alert-link" data-jump="unsigned">Show them</button></div>`
    : '';

  const itemsHtml = filtered.length
    ? filtered.map(itemRow).join('')
    : `<div class="ch-empty">${
        state.filter === 'unsigned'
          ? 'No unsigned changes in this window. That is a statement about the record, not about whether anything shipped — each source records only when something calls it.'
          : 'No changes in this window. That is a statement about the record, not about whether anything happened — each source records only when something calls it.'
      }</div>`;

  root.innerHTML = `<section class="panel ch-panel">
    <div class="ch-header">
      <h1>Changes shipped</h1>
      <span class="ch-count">${filtered.length} of ${state.items.length}</span>
    </div>
    <div class="ch-filters">${filterBar()}</div>
    ${notesHtml}
    ${alertHtml}
    <div class="ch-list">${itemsHtml}</div>
  </section>`;

  root.querySelectorAll('.ch-tab').forEach((b) => {
    b.addEventListener('click', () => { state.filter = b.dataset.f; render(); });
  });
  const jump = root.querySelector('.ch-alert-link');
  if (jump) jump.addEventListener('click', () => { state.filter = 'unsigned'; render(); });
}

async function load() {
  const token = ++loadToken;
  try {
    const r = await fetch('/api/changes', { headers: { 'x-mc-by': 'you' } });
    if (!r.ok) throw new Error(`/api/changes answered ${r.status}`);
    const data = await r.json();
    if (!root || token !== loadToken) return;
    state = {
      filter: state.filter,
      items: data.items || [],
      notes: data.notes,
      error: null,
    };
    render();
  } catch (e) {
    if (!root || token !== loadToken) return;
    state = { ...state, error: e.message };
    if (root) {
      root.innerHTML = `<section class="panel ch-panel"><h1>Changes shipped</h1>
        <p class="ch-alarm">COULD NOT LOAD — ${esc(e.message)}. This is a failure to look, not an
        empty list: do not read it as "nothing shipped".</p></section>`;
    }
  }
}

export default {
  mount(el, opts) {
    root = el;
    state = { filter: 'all', items: [], notes: null, error: null };
    load();
    // 60 seconds matches the cadence of the activity and handover sources.
    timer = setInterval(load, 60000);
  },
  unmount() {
    loadToken++;
    if (timer) { clearInterval(timer); timer = null; }
    root = null;
    state = { filter: 'all', items: [], notes: null, error: null };
  },
};