//
// activity — a reverse-chronological stream of everything that happened across the workspace.
//
// Commits, focus sessions, board items, handover files and inbox messages all carry a
// timestamp and an actor. Each source has its own panel; this one shows them all in one feed
// so "what happened" has one answer instead of five. The filter bar narrows it to a kind; the
// refresh keeps it current.
//
// STALE ITEMS ARE MUTED, NOT HIDDEN. Something from five days ago is still real, but it is not
// "recent", and a feed that gives equal visual weight to now and last week is harder to scan.
// The 3-day cutoff is a display choice, not a data choice — the item stays in the list.
//
// STALE CARD: if the stream reports open board items silent for 7+ days, a card at the top of
// the list says how many, so a stall is visible without leaving this panel. It only renders
// when staleCount > 0 — an empty card would be noise.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Agent badge colours. The mapping is by name fragment so "codex-worker-batch-d" still gets
// the Codex colour. 'you' is the human surface and gets ink — the neutral, not an accent.
function badgeClass(who) {
  const name = String(who || '').toLowerCase();
  if (name.includes('claude') || name.includes('hermes')) return 'ac-badge-accent';
  if (name.includes('codex')) return 'ac-badge-blue';
  if (name.includes('ollama')) return 'ac-badge-green';
  if (name === 'you') return 'ac-badge-ink';
  return 'ac-badge-ink';
}

// Relative time — '2h ago', 'just now', '3d ago'. Compact on purpose: the badge and text carry
// the detail, the timestamp is a scan aid.
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

const KIND_LABELS = {
  commit: 'commit',
  session: 'session',
  handover: 'handover',
  board: 'board',
  message: 'message',
};

const FILTERS = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'commits', label: 'Commits', kinds: ['commit'] },
  { id: 'sessions', label: 'Sessions', kinds: ['session'] },
  { id: 'handovers', label: 'Handovers', kinds: ['handover'] },
  { id: 'board', label: 'Board', kinds: ['board'] },
  { id: 'messages', label: 'Messages', kinds: ['message'] },
];

let root = null;
let state = { filter: 'all', items: [], notes: null, error: null, staleCount: 0, staleThreshold: 7 };
let timer = null;
let loadToken = 0;

function filterBar() {
  const counts = {};
  for (const item of state.items) {
    counts[item.kind] = (counts[item.kind] || 0) + 1;
  }
  return FILTERS.map((f) => {
    let count;
    if (f.id === 'all') {
      count = state.items.length;
    } else if (f.kinds) {
      count = f.kinds.reduce((sum, k) => sum + (counts[k] || 0), 0);
    } else {
      count = state.items.length;
    }
    const on = state.filter === f.id ? ' on' : '';
    return `<button class="ac-tab${on}" data-f="${f.id}">${esc(f.label)}<span>${count}</span></button>`;
  }).join('');
}

function itemRow(item) {
  const stale = isStale(item.when) ? ' ac-stale' : '';
  const badge = badgeClass(item.who);
  const label = KIND_LABELS[item.kind] || item.kind;
  const where = item.where ? `<span class="ac-where">${esc(item.where)}</span>` : '';
  const link = item.link ? `<span class="ac-link">${esc(item.link)}</span>` : '';
  return `<div class="ac-item${stale}" data-kind="${esc(item.kind)}">
    <span class="ac-kind">${esc(label)}</span>
    <span class="ac-time">${esc(relTime(item.when))}</span>
    <span class="ac-badge ${badge}">${esc(item.who)}</span>
    <span class="ac-what">${esc(item.what)}</span>
    ${where}${link}
  </div>`;
}

// Stale card — only rendered when there is something to warn about. It is a pointer to the
// stale panel, not a duplicate of its list, so it carries the count and the threshold and
// nothing else. The wording is "silent for 7+ days" to match the stale route's vocabulary.
function staleCard() {
  if (!state.staleCount || state.staleCount <= 0) return '';
  const n = state.staleCount;
  const days = state.staleThreshold || 7;
  const noun = n === 1 ? 'item has' : 'items have';
  return `<div class="ac-stale-card" title="Open board items with no activity in ${days}+ days">
    <span class="ac-stale-icon">⚠</span>
    <span class="ac-stale-text">${n} ${noun} been silent for ${days}+ days</span>
  </div>`;
}

function render() {
  if (!root) return;
  const filtered = state.filter === 'all'
    ? state.items
    : state.items.filter((item) => {
        const f = FILTERS.find((f) => f.id === state.filter);
        return !f || !f.kinds || f.kinds.includes(item.kind);
      });

  const notesHtml = state.notes && state.notes.length
    ? `<div class="ac-notes">${state.notes.map((n) =>
        `<div class="ac-note">Could not read ${esc(n.source)}: ${esc(n.error)}</div>`
      ).join('')}</div>`
    : '';

  const itemsHtml = filtered.length
    ? filtered.map(itemRow).join('')
    : `<div class="ac-empty">No activity in this window. That is a statement about the record,
      not about whether anything happened — each source records only when something calls it.</div>`;

  root.innerHTML = `<section class="panel ac-panel">
    <div class="ac-header">
      <h1>Activity stream</h1>
      <span class="ac-count">${filtered.length} item${filtered.length === 1 ? '' : 's'}</span>
    </div>
    <div class="ac-filters">${filterBar()}</div>
    ${notesHtml}
    ${staleCard()}
    <div class="ac-list">${itemsHtml}</div>
  </section>`;

  // Wire filter tabs.
  root.querySelectorAll('.ac-tab').forEach((b) => {
    b.addEventListener('click', () => {
      state.filter = b.dataset.f;
      render();
    });
  });
}

async function load() {
  const token = ++loadToken;
  try {
    const r = await fetch('/api/activity/stream', { headers: { 'x-mc-by': 'you' } });
    if (!r.ok) throw new Error(`/api/activity/stream answered ${r.status}`);
    const data = await r.json();
    if (!root || token !== loadToken) return;
    state = {
      filter: state.filter,
      items: data.items || [],
      notes: data.notes,
      error: null,
      staleCount: Number(data.staleCount) || 0,
      staleThreshold: Number(data.staleThreshold) || 7,
    };
    render();
  } catch (e) {
    if (!root || token !== loadToken) return;
    state = { ...state, error: e.message };
    if (root) {
      root.innerHTML = `<section class="panel ac-panel"><h1>Activity stream</h1>
        <p class="ac-alarm">COULD NOT LOAD — ${esc(e.message)}. This is a failure to look, not an
        empty stream: do not read it as "nothing happened".</p></section>`;
    }
  }
}

export default {
  mount(el, opts) {
    root = el;
    state = { filter: 'all', items: [], notes: null, error: null, staleCount: 0, staleThreshold: 7 };
    load();
    // 60 seconds matches the cadence of the handover and board sources. Faster polling
    // would only re-read the same git log and show a rising age counter.
    timer = setInterval(load, 60000);
  },
  unmount() {
    loadToken++;
    if (timer) { clearInterval(timer); timer = null; }
    root = null;
    state = { filter: 'all', items: [], notes: null, error: null, staleCount: 0, staleThreshold: 7 };
  },
};