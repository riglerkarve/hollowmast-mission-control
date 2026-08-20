// crm — who pays you, who has gone quiet, and what you owe them.
//
// The client list is DERIVED: /api/crm/candidates is everyone the ledger already knows
// pays you, minus your own transfers. You promote the real ones; you never type a name.
//
// NO NEW CSS CLASSES. Codex owns every stylesheet (owner decision #18), so this uses only
// what public/shared.css already defines: panel, panel-header, card, btn, badge,
// stat-block, stat-label, stat-value, stats-summary, empty-hint, failure-hint, mode-tabs,
// mode-tab. A class invented here would need a rule appended to a sheet I do not own.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const gbp = (pence) => '£' + (Number(pence || 0) / 100).toLocaleString('en-GB', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

let root = null;
let view = 'clients';
let loadToken = 0;

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Clients</h1></div>
    <div class="mode-tabs" id="crmTabs">
      <button class="mode-tab" data-view="clients">Tracked</button>
      <button class="mode-tab" data-view="candidates">From the ledger</button>
      <button class="mode-tab" data-view="followups">Follow-ups</button>
    </div>
    <div id="crmBody"></div>
  </div>`;

// ABSENCE AND FAILURE RENDER DIFFERENTLY, and the API is explicit about which it is
// returning: every list endpoint sends a `state` string when a count is genuinely zero, and
// a non-200 when it could not look. A fetch failure rendered as an empty state is good news
// nobody investigates.
async function get(url) {
  const r = await fetch(url, { headers: { 'x-mc-by': 'you' } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && (body.why || body.error)) || ('HTTP ' + r.status));
  return body;
}

function failure(msg) {
  return `<div class="card"><p class="failure-hint">Could not load: ${esc(msg)}</p></div>`;
}

function empty(msg) {
  return `<div class="card"><p class="empty-hint">${esc(msg)}</p></div>`;
}

function clientRow(c) {
  const h = c.history;
  const name = c.display_name || c.counterparty;
  const money = h ? gbp(h.total_pence) + ' over ' + h.payments + ' payment' + (h.payments === 1 ? '' : 's') : null;
  return `
    <div class="card">
      <strong>${esc(name)}</strong>
      <span class="badge">${esc(c.stage)}</span>
      ${c.open_followups ? `<span class="badge">${c.open_followups} open</span>` : ''}
      ${h && h.lapsed === true ? '<span class="badge">lapsed</span>' : ''}
      <div class="stats-summary">
        ${h ? `
          <div class="stat-block"><div class="stat-label">Paid</div><div class="stat-value">${esc(money)}</div></div>
          <div class="stat-block"><div class="stat-label">Last</div><div class="stat-value">${esc(h.last_at)}</div></div>
          <div class="stat-block"><div class="stat-label">Usually every</div><div class="stat-value">${h.avg_gap_days == null ? '—' : h.avg_gap_days + 'd'}</div></div>
        ` : `<p class="empty-hint">${esc(c.history_state)}</p>`}
      </div>
      ${c.note ? `<p>${esc(c.note)}</p>` : ''}
    </div>`;
}

async function renderClients(body) {
  const d = await get('/api/crm/clients');
  if (!d.clients.length) {
    body.innerHTML = empty(d.state || 'No clients tracked yet.')
      + `<div class="card"><button class="btn" data-go="candidates">See who the ledger says pays you</button></div>`;
    body.querySelector('[data-go]').addEventListener('click', () => switchView('candidates'));
    return;
  }
  const lapsed = d.clients.filter((c) => c.history && c.history.lapsed === true).length;
  body.innerHTML = `
    <div class="stats-summary">
      <div class="stat-block"><div class="stat-label">Tracked</div><div class="stat-value">${d.count}</div></div>
      <div class="stat-block"><div class="stat-label">Lapsed</div><div class="stat-value">${lapsed}</div></div>
    </div>
    ${d.clients.map(clientRow).join('')}`;
}

async function renderCandidates(body) {
  const d = await get('/api/crm/candidates');
  const r = d.residue || {};
  // The residue is PRINTED. A filtered list always looks cleaner than the data behind it,
  // and the own-transfer exclusion has already failed silently once here.
  const note = `<p class="empty-hint">
      ${d.count} shown. Excluded: ${r.already_tracked || 0} already tracked,
      ${r.own_transfers || 0} own transfers, ${r.below_min || 0} under ${gbp(r.min_pence)}.
      ${esc(r.own_transfer_state || '')}
    </p>`;
  if (!d.count) { body.innerHTML = empty('No untracked counterparties above the threshold.') + note; return; }
  body.innerHTML = note + d.candidates.slice(0, 40).map((c) => `
    <div class="card">
      <strong>${esc(c.counterparty)}</strong>
      ${c.lapsed === true ? '<span class="badge">lapsed</span>' : ''}
      <div class="stats-summary">
        <div class="stat-block"><div class="stat-label">Paid</div><div class="stat-value">${gbp(c.total_pence)}</div></div>
        <div class="stat-block"><div class="stat-label">Payments</div><div class="stat-value">${c.payments}</div></div>
        <div class="stat-block"><div class="stat-label">Last</div><div class="stat-value">${esc(c.last_at)}</div></div>
      </div>
      <button class="btn" data-track="${esc(c.counterparty)}">Track as client</button>
    </div>`).join('');

  body.querySelectorAll('[data-track]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await fetch('/api/crm/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ counterparty: b.dataset.track }),
      });
      await switchView('candidates');
    } catch (e) {
      b.disabled = false;
      b.insertAdjacentHTML('afterend', `<p class="failure-hint">${esc(e.message)}</p>`);
    }
  }));
}

async function renderFollowups(body) {
  const d = await get('/api/crm/followups');
  if (!d.count) { body.innerHTML = empty(d.state || 'Nothing outstanding.'); return; }
  body.innerHTML = `
    <div class="stats-summary">
      <div class="stat-block"><div class="stat-label">Open</div><div class="stat-value">${d.count}</div></div>
      <div class="stat-block"><div class="stat-label">Overdue</div><div class="stat-value">${d.overdue}</div></div>
    </div>
    ${d.followups.map((f) => `
      <div class="card">
        <strong>${esc(f.display_name || f.counterparty)}</strong>
        ${f.overdue ? '<span class="badge">overdue</span>' : ''}
        <p>${esc(f.what)}${f.due_on ? ' — due ' + esc(f.due_on) : ''}</p>
        <button class="btn" data-done="${f.id}">Done</button>
      </div>`).join('')}`;

  body.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await fetch('/api/crm/followups/' + b.dataset.done + '/done', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you' }, body: '{}',
    });
    await switchView('followups');
  }));
}

async function switchView(name) {
  if (!root) return;
  view = name;
  const token = ++loadToken;
  root.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  const body = root.querySelector('#crmBody');
  body.innerHTML = '<p class="empty-hint">Loading…</p>';
  try {
    if (name === 'clients') await renderClients(body);
    else if (name === 'candidates') await renderCandidates(body);
    else await renderFollowups(body);
  } catch (e) {
    // An in-flight response from a tab you have already left must not paint over the
    // current one. Same guard the other panels use.
    if (token !== loadToken || !root) return;
    body.innerHTML = failure(e.message);
    return;
  }
  if (token !== loadToken) return;
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    el.querySelectorAll('.mode-tab').forEach((t) => {
      t.addEventListener('click', () => switchView(t.dataset.view));
    });
    switchView(view);
  },
  unmount() {
    // No timers or intervals here, but loadToken is bumped so any in-flight fetch that
    // resolves after unmount finds a stale token and writes nothing to a dead DOM.
    loadToken++;
    root = null;
  },
};
