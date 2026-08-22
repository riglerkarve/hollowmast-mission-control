//
// api-explorer — lists every dashboard GET endpoint, grouped by route module, with a
// 'Try' button that fetches the endpoint and shows the response inline.
//
// The inventory is hardcoded from `grep -rn "router\.get" server/routes/*.js` and the
// mount prefixes in server/index.js (`app.use('/api/...', router)`). There is no server
// endpoint that lists all routes, so the panel does not fetch a manifest — it carries the
// list. If a route is added on the server and this list is not updated, the new route is
// invisible here, not broken. That is the safer direction: an explorer that lies about what
// exists is worse than one that is incomplete.
//
// Routes with path params (:id, :date) and SSE streams (/stream) are excluded — they
// cannot be tried without a value, and a button that always errors is noise.
//
// The response is pretty-printed JSON, truncated to 500 chars. A fetch that fails shows
// the error inline so absence (no response yet) and failure (a red error) look different.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Route inventory — 130 GET endpoints across 47 modules, derived from the actual server
// source at build time. Each entry is { module, paths: [fullPath, ...] }.
const ROUTES = [
  { module: 'agents', paths: ['/api/agents'] },
  { module: 'alerts', paths: ['/api/alerts', '/api/alerts/events'] },
  { module: 'analytics', paths: ['/api/analytics', '/api/analytics/traffic'] },
  { module: 'atlas', paths: ['/api/atlas'] },
  { module: 'board', paths: ['/api/board', '/api/board/items'] },
  { module: 'brain', paths: ['/api/brain/flag', '/api/brain/notes'] },
  { module: 'briefing', paths: ['/api/briefing', '/api/briefing/latest', '/api/briefing/morning', '/api/briefing/speak', '/api/briefing/text'] },
  { module: 'browsing', paths: ['/api/browsing'] },
  { module: 'budget', paths: ['/api/budget', '/api/budget/wishlist'] },
  { module: 'cash', paths: ['/api/cash', '/api/cash/counts'] },
  { module: 'changes', paths: ['/api/changes', '/api/changes/unsigned'] },
  { module: 'command', paths: ['/api/voice/command/status', '/api/voice/status/command'] },
  { module: 'creative', paths: ['/api/creative/ideas', '/api/creative/spark'] },
  { module: 'crm', paths: ['/api/crm/candidates', '/api/crm/clients', '/api/crm/followups', '/api/crm/lapsed'] },
  { module: 'decisions', paths: ['/api/decisions'] },
  { module: 'digest', paths: ['/api/digest'] },
  { module: 'drive', paths: ['/api/drive', '/api/drive/files', '/api/drive/shared'] },
  { module: 'exercise', paths: ['/api/exercise'] },
  { module: 'finance', paths: ['/api/finance/access-log', '/api/finance/accounts', '/api/finance/exposure', '/api/finance/forecast', '/api/finance/income-outlook', '/api/finance/months', '/api/finance/net-worth', '/api/finance/own-transfer-suspects', '/api/finance/pnl', '/api/finance/recurring', '/api/finance/review', '/api/finance/rules', '/api/finance/spending', '/api/finance/summary', '/api/finance/transactions'] },
  { module: 'goals', paths: ['/api/goals'] },
  { module: 'health', paths: ['/api/health/metrics', '/api/health/series', '/api/health/summary'] },
  { module: 'health-check', paths: ['/api/health-check'] },
  { module: 'inbox', paths: ['/api/inbox/thread', '/api/inbox/threads'] },
  { module: 'income', paths: ['/api/income', '/api/income/entries', '/api/income/streams'] },
  { module: 'inventory', paths: ['/api/inventory/candidates', '/api/inventory/capital', '/api/inventory/food', '/api/inventory/items', '/api/inventory/reorder', '/api/inventory/value'] },
  { module: 'journal', paths: ['/api/journal/entries', '/api/journal/stats'] },
  { module: 'lifestyle', paths: ['/api/lifestyle', '/api/lifestyle/chores', '/api/lifestyle/foods/lookup', '/api/lifestyle/intake', '/api/lifestyle/meals', '/api/lifestyle/targets'] },
  { module: 'machine', paths: ['/api/machine', '/api/machine/history'] },
  { module: 'mail', paths: ['/api/mail', '/api/mail/attention', '/api/mail/messages', '/api/mail/senders', '/api/mail/senders/classes', '/api/mail/vs-ledger'] },
  { module: 'prioritize', paths: ['/api/prioritize'] },
  { module: 'projects', paths: ['/api/projects'] },
  { module: 'safety', paths: ['/api/safety'] },
  { module: 'schedule', paths: ['/api/schedule', '/api/schedule/events'] },
  { module: 'serendipity', paths: ['/api/serendipity'] },
  { module: 'sessions', paths: ['/api/sessions/active', '/api/sessions/by-item', '/api/sessions/claude', '/api/sessions/ledger', '/api/sessions/ledger/report.csv', '/api/sessions/ledger/sessions', '/api/sessions/ledger/targets'] },
  { module: 'stale', paths: ['/api/stale'] },
  { module: 'stats', paths: ['/api/stats/activity', '/api/stats/all-time', '/api/stats/daily', '/api/stats/export', '/api/stats/monthly', '/api/stats/standing', '/api/stats/summary'] },
  { module: 'tasks', paths: ['/api/tasks'] },
  { module: 'team', paths: ['/api/team/assignments', '/api/team/decisions', '/api/team/plan', '/api/team/report', '/api/team/responses', '/api/team/roster', '/api/team/scribe', '/api/team/scribe/proposals', '/api/team/shift', '/api/team/shifts', '/api/team/steering'] },
  { module: 'timeallocation', paths: ['/api/time-allocation'] },
  { module: 'todo', paths: ['/api/todo', '/api/todo/clusters', '/api/todo/export.csv', '/api/todo/items'] },
  { module: 'uptime', paths: ['/api/status'] },
  { module: 'ventures', paths: ['/api/ventures'] },
  { module: 'voice', paths: ['/api/voice/status'] },
  { module: 'wellbeing', paths: ['/api/wellbeing/entries', '/api/wellbeing/patterns', '/api/wellbeing/quiet', '/api/wellbeing/support'] },
  { module: 'work', paths: ['/api/work/items'] },
  { module: 'workspace', paths: ['/api/workspace'] },
];

// Flatten to a searchable list: { module, path, method }
const ALL = ROUTES.flatMap(g => g.paths.map(p => ({ module: g.module, path: p, method: 'GET' })));

let root = null;
let filter = '';

// Each route row gets a stable id derived from its path so we can find it later
// to inject the response without a full re-render.
const rowId = (path) => 'ae-' + path.replace(/[^a-z0-9]/gi, '-');

function routeRowHTML(r) {
  const id = rowId(r.path);
  return `<div class="ae-row" id="${id}" data-path="${esc(r.path)}">
    <span class="ae-method">${esc(r.method)}</span>
    <span class="ae-path">${esc(r.path)}</span>
    <button class="ae-try" data-href="${esc(r.path)}">Try</button>
    <div class="ae-resp" hidden></div>
  </div>`;
}

function moduleHTML(g) {
  const rows = g.paths.map(p => routeRowHTML({ module: g.module, path: p, method: 'GET' })).join('');
  return `<section class="ae-module">
    <h2 class="ae-mod-name">${esc(g.module)} <span class="ae-mod-n">${g.paths.length}</span></h2>
    ${rows}
  </section>`;
}

function render() {
  if (!root) return;

  const q = filter.trim().toLowerCase();
  const groups = ROUTES.map(g => {
    const paths = g.paths.filter(p => !q || p.toLowerCase().includes(q) || g.module.toLowerCase().includes(q));
    return { module: g.module, paths };
  }).filter(g => g.paths.length > 0);

  if (groups.length === 0) {
    root.innerHTML = `<section class="panel ae-panel">
      <h1>API Explorer</h1>
      <p class="ae-lede">Every dashboard API endpoint, grouped by route module. Click 'Try' to fetch
        the endpoint and see the response inline.</p>
      <input class="ae-search" type="search" placeholder="Filter by path or module…" value="${esc(filter)}">
      <p class="ae-empty">No routes match "${esc(filter)}".</p>
    </section>`;
    return;
  }

  const total = groups.reduce((n, g) => n + g.paths.length, 0);
  root.innerHTML = `<section class="panel ae-panel">
    <h1>API Explorer</h1>
    <p class="ae-lede">Every dashboard API endpoint, grouped by route module. Click 'Try' to fetch
      the endpoint and see the response inline. The inventory is hardcoded from the server source —
      there is no route manifest endpoint — so a route added on the server but not in this list is
      invisible here, not broken.</p>
    <input class="ae-search" type="search" placeholder="Filter by path or module…" value="${esc(filter)}">
    <p class="ae-count">${total} endpoint${total === 1 ? '' : 's'} in ${groups.length} module${groups.length === 1 ? '' : 's'}</p>
    ${groups.map(moduleHTML).join('')}
  </section>`;
}

// Fetch the endpoint and show the pretty-printed JSON response (or error) inline below the
// route row. A 500-char truncation keeps the panel readable; a full response can be hundreds
// of KB. The truncation marker is visible so it is not mistaken for the complete body.
async function tryEndpoint(btn, href) {
  const row = btn.closest('.ae-row');
  if (!row) return;
  const resp = row.querySelector('.ae-resp');
  if (!resp) return;

  btn.disabled = true;
  btn.textContent = '…';
  resp.hidden = false;
  resp.className = 'ae-resp ae-loading';
  resp.textContent = 'Fetching…';

  try {
  const res = await fetch(href);
    const text = await res.text();
    // Try to pretty-print JSON; fall back to raw text for non-JSON (e.g. CSV endpoints).
    let body;
    try {
      const json = JSON.parse(text);
      body = JSON.stringify(json, null, 2);
    } catch {
      body = text;
    }
    const truncated = body.length > 500;
    const display = truncated ? body.slice(0, 500) + '\n…' : body;
    const status = res.ok ? '' : ` (HTTP ${res.status})`;
    resp.className = 'ae-resp ae-ok' + (res.ok ? '' : ' ae-err');
    resp.innerHTML = `<span class="ae-resp-status">${esc(res.status)}${status}</span><pre class="ae-resp-body">${esc(display)}</pre>${truncated ? '<span class="ae-resp-trunc">truncated</span>' : ''}`;
  } catch (e) {
    resp.className = 'ae-resp ae-err';
    resp.innerHTML = `<span class="ae-resp-status">error</span><pre class="ae-resp-body">${esc(e.message)}</pre>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Try';
  }
}

function onClick(e) {
  const btn = e.target.closest('.ae-try');
  if (!btn || btn.disabled) return;
  const href = btn.getAttribute('data-href');
  if (href) tryEndpoint(btn, href);
}

function onInput(e) {
  if (!e.target.classList.contains('ae-search')) return;
  filter = e.target.value;
  render();
}

export default {
  mount(el, opts) {
    root = el;
    filter = '';
    render();
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    renderLede('api-explorer', el);
  },
  unmount() {
    if (root) {
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
    }
    root = null;
    filter = '';
  },
};