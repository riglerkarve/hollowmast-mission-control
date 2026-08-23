//
// purpose — assign what the opaque spending was actually for.
//
// THE PROBLEM, and why this is not a list of 310 rows. Over the last twelve complete months
// £24,228 of spending is "Cash withdrawn" or "Payments to people", and the bank cannot say
// what any of it bought. That is roughly three quarters of measured spending, so every
// affordability question is currently answered from the remaining quarter.
//
// IT DECIDES THE ORDER, which is the whole point. The money is concentrated: five
// counterparties are 88% of it. So this lists COUNTERPARTIES by size, biggest first, with a
// running cumulative share — five decisions explain most of the money, and a date-ordered
// list of 310 payments would hide that completely. One change assigns; the figure at the top
// moves immediately, which is the only reason a manual surface earns its place here.
//
// THREE STATES, NEVER TWO. Explained, "not placeable", and not yet reviewed are different
// facts. A payment looked at and genuinely not placeable is not the same as one nobody has
// opened, and collapsing them would make a reviewed ledger and an ignored one identical.
//
// IT HAS ITS OWN STYLESHEET AGAIN. Decision #48 (23 Aug 2026) returned CSS control to
// Claude sessions, superseding #18. purpose.css is scoped entirely to .pp- so it cannot
// reach another panel — the shared-working-tree risk decision 18 named is unrefuted, and a
// per-panel sheet is the version of it nobody else is standing in.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const gbp = (pence) => `£${(Math.abs(pence) / 100).toFixed(2)}`;
const pct = (f) => `${(f * 100).toFixed(1)}%`;

let root = null;
let state = null;

async function api(path, opts = {}) {
  const r = await fetch(`/api/finance${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-MC-By': 'owner', ...(opts.headers || {}) },
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* keep the status */ }
    throw new Error(msg);
  }
  return r.json();
}

// The window is a query parameter on every call, so the queue, the summary and the detail
// list can never describe different periods. 12 months is the default because that is what
// rent-affordability.cjs measures, and two surfaces answering the same question over
// different windows is the drift this project keeps meeting.
const WINDOWS = [
  { months: 12, label: '12 months' },
  { months: 24, label: '24 months' },
  { months: 240, label: 'all time' },
];

async function load() {
  state.error = null;
  // The default-window paths are written as plain literals so tools/verify-panel.cjs can
  // still extract and probe them. Built entirely by interpolation they became invisible to
  // it, and a panel whose endpoints no checker can reach loses the one automated check that
  // catches a route going away.
  const dflt = state.months === 12;
  try {
    const [summary, queue] = await Promise.all([
      dflt ? api('/purpose/summary') : api(`/purpose/summary?months=${state.months}`),
      dflt ? api('/purpose/queue') : api(`/purpose/queue?months=${state.months}`),
    ]);
    state.summary = summary;
    state.queue = queue;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

function windowHTML() {
  return `<div class="pp-window">
    <span>Window</span>
    ${WINDOWS.map((w) => `<button class="btn pp-win${w.months === state.months ? ' pp-win-on' : ''}"
      data-months="${w.months}"${w.months === state.months ? ' aria-current="true"' : ''}>${esc(w.label)}</button>`).join('')}
    <span>default 12 months, matching the affordability report</span>
  </div>`;
}

// The derived figure, and the reason this panel is not just storage: it shows what assigning
// actually bought. Three segments and three legend rows because there are three states.
function summaryHTML(s) {
  const share = s.pence ? s.explained_pence / s.pence : 0;
  const total = s.pence || 1;
  const seg = (v, cls) => (v > 0 ? `<div class="pp-seg ${cls}" style="width:${(v / total) * 100}%"></div>` : '');
  const block = (label, value, sub) => `<div class="stat-block">
      <span class="stat-value">${esc(value)}</span>
      <span class="stat-label">${esc(label)}${sub ? ` · ${esc(sub)}` : ''}</span>
    </div>`;
  return `<div class="card">
    ${windowHTML()}
    <div class="stats-summary">
      ${block('explained', gbp(s.explained_pence), `${pct(share)} of the opaque total`)}
      ${block('opaque total', gbp(s.pence), `${s.n} payments`)}
    </div>
    <div class="pp-bar">
      ${seg(s.explained_pence, 'pp-seg-explained')}
      ${seg(s.unknown_pence, 'pp-seg-unknown')}
      ${seg(s.unreviewed_pence, 'pp-seg-unreviewed')}
    </div>
    <ul class="pp-legend">
      <li><span class="pp-key pp-seg-explained"></span>Explained ${gbp(s.explained_pence)} · ${s.explained_n}</li>
      <li><span class="pp-key pp-seg-unknown"></span>Reviewed, not placeable ${gbp(s.unknown_pence)} · ${s.unknown_n}</li>
      <li><span class="pp-key pp-seg-unreviewed"></span>Not yet reviewed ${gbp(s.unreviewed_pence)} · ${s.unreviewed_n}</li>
    </ul>
    <p class="pp-residue">Cash withdrawals and payments to people, ${esc(s.from)} to ${esc(s.to)}.
      The bank records no purpose for any of it. <b>Not placeable</b> is a real answer and is
      kept separate from <b>not yet reviewed</b> — those are different facts, and a ledger you
      have been through should not look like one you have ignored.</p>
    ${s.byPurpose && s.byPurpose.length ? `<div class="stats-summary">${s.byPurpose
      .map((p) => block(p.purpose, gbp(p.pence), `${p.n}`)).join('')}</div>` : ''}
  </div>`;
}

function purposeSelect(scope, key, current) {
  const opts = (state.summary.purposes || [])
    .map((p) => `<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(p)}</option>`).join('');
  return `<select class="pp-select" data-scope="${esc(scope)}" data-key="${esc(key)}" aria-label="purpose">
    <option value=""${current ? '' : ' selected'}>— not set —</option>${opts}
  </select>`;
}

function rowHTML(c) {
  const open = state.open === c.counterparty;
  const done = !!c.counterparty_purpose;
  return `<div class="card pp-row${done ? ' pp-row-done' : ''}">
    <div class="pp-row-head">
      <span class="pp-name">${esc(c.counterparty)}</span>
      <span class="pp-amount">${gbp(c.pence)}</span>
    </div>
    <p class="pp-meta">${c.n} payment${c.n === 1 ? '' : 's'} · ${pct(c.shareOfOpaque)} of the opaque
      total · running ${pct(c.cumulativeShare)} · ${esc(c.first_seen)} to ${esc(c.last_seen)}${
  c.overridden_n ? ` · ${c.overridden_n} set individually` : ''}</p>
    <div class="pp-actions">
      ${purposeSelect('counterparty', c.counterparty, c.counterparty_purpose)}
      <button class="btn" data-cp="${esc(c.counterparty)}">${open ? 'Hide payments' : 'Payments…'}</button>
      ${done ? `<span class="badge"><span class="badge-label">${esc(c.counterparty_purpose)}</span></span>` : ''}
    </div>
    ${open ? detailHTML(c.counterparty) : ''}
  </div>`;
}

// The per-transaction list exists for the case a counterparty rule gets wrong — one
// withdrawal that was rent when the rest were food. Collapsed by default, because opening
// 310 rows is exactly what this panel is built to avoid.
function detailHTML(cp) {
  const d = state.detail[cp];
  if (!d) return '<p class="empty-hint">Loading payments…</p>';
  if (d.error) {
    return `<p class="failure-hint">Could not load payments — ${esc(d.error)}.
      That is a failure to look, not an empty list.</p>`;
  }
  if (!d.transactions.length) return '<p class="empty-hint">No payments found for this counterparty.</p>';
  // The rows outside the window are named rather than dropped. They are real payments that
  // contribute nothing to the totals above, and a list that quietly showed only some of them
  // would read as the whole history.
  const outside = d.outsideWindow && d.outsideWindow.n
    ? `<p class="pp-residue">Showing the ${d.transactions.length} payment(s) inside
       ${esc(d.from)} to ${esc(d.to)}. A further <b>${d.outsideWindow.n}</b> payment(s) worth
       ${gbp(d.outsideWindow.pence)} fall outside that window and are counted in no figure on
       this page. Widen the window above to include them.</p>`
    : '';
  return `${outside}<table class="pp-tx"><tbody>${d.transactions.map((t) => `<tr>
      <td>${esc(t.date)}</td>
      <td class="pp-tx-amount">${gbp(t.pence)}</td>
      <td>${purposeSelect('transaction', t.id, t.own_purpose)}</td>
      <td class="pp-tx-from">${t.own_purpose
        ? 'set here'
        : (t.resolved_purpose ? `from ${esc(cp)}` : '—')}</td>
    </tr>`).join('')}</tbody></table>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel"><h1>Purpose</h1>
      <p class="failure-hint">Could not load — ${esc(state.error)}.
      That is a failure to look, not an absence of unexplained spending.</p></section>`;
    bind();
    return;
  }
  if (!state.summary) {
    root.innerHTML = '<section class="panel"><h1>Purpose</h1><p class="empty-hint">Loading…</p></section>';
    return;
  }

  const q = state.queue || { counterparties: [] };
  const list = q.counterparties.length
    ? q.counterparties.map(rowHTML).join('')
    : `<p class="empty-hint">Nothing unexplained in this window. That is a real zero — every
       cash withdrawal and payment to a person has a purpose recorded.</p>`;

  root.innerHTML = `<section class="panel">
    <h1>Purpose</h1>
    ${summaryHTML(state.summary)}
    <h2>Biggest first · ${q.counterparties.length}</h2>
    <p class="empty-hint" style="text-align:left">Ordered by money, not by date, because the
      spending is concentrated — a handful of decisions here move most of the total. Setting a
      purpose applies it to every payment to that counterparty; open the payments to override
      a single one.</p>
    ${list}
  </section>`;
  bind();
  renderLede('purpose', root);
}

function bind() {
  root.querySelectorAll('select[data-scope]').forEach((el) => el.addEventListener('change', onSet));
  root.querySelectorAll('button[data-cp]').forEach((el) => el.addEventListener('click', onExpand));
  root.querySelectorAll('button[data-months]').forEach((el) => el.addEventListener('click', onWindow));
}

async function onSet(e) {
  const el = e.target;
  const { scope, key } = el.dataset;
  const purpose = el.value;
  el.disabled = true;
  try {
    if (!purpose) await api('/purpose', { method: 'DELETE', body: JSON.stringify({ scope, key }) });
    else await api('/purpose', { method: 'POST', body: JSON.stringify({ scope, key, purpose }) });
    // Refresh whatever detail is open BEFORE re-rendering, or an override and the counterparty
    // rule above it can disagree on screen after a write.
    if (state.open) await loadDetail(state.open);
    await load();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function loadDetail(cp) {
  try {
    // months is passed here too. The detail list is windowed server-side, so omitting it
    // would let an open payment list describe a different period from the totals above it —
    // which is the defect this panel already had once and is not getting back.
    state.detail[cp] = await api(
      `/purpose/transactions?counterparty=${encodeURIComponent(cp)}&months=${state.months}`,
    );
  } catch (e) {
    state.detail[cp] = { error: e.message, transactions: [] };
  }
}

// Changing the window invalidates every cached detail list, because those are windowed too.
// Keeping them would let an open list describe a different period from the totals above it —
// the exact defect found by opening this panel the first time.
async function onWindow(e) {
  state.months = Number(e.target.dataset.months);
  state.detail = {};
  await load();
  if (state.open) { await loadDetail(state.open); render(); }
}

async function onExpand(e) {
  const cp = e.target.dataset.cp;
  state.open = state.open === cp ? null : cp;
  render();
  if (state.open && !state.detail[cp]) { await loadDetail(cp); render(); }
}

export default {
  mount(el) {
    root = el;
    state = { summary: null, queue: null, detail: {}, open: null, error: null, months: 12 };
    render();
    load();
  },
  // No timers and no polling, so unmount only drops references — but it must still do that,
  // or an in-flight fetch resolves into a dead DOM.
  unmount() {
    root = null;
    state = null;
  },
};
