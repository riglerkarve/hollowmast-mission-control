// Where the money went. Reads only /api/finance.
//
// Three things this panel must never do, because each would make it lie quietly:
//   - include Own transfer in any total (with two accounts each transfer appears twice)
//   - present Cash withdrawn as a category of spending (the ledger does not know)
//   - compare a partial month against a whole one

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Money</h1>
      <div class="badge"><span class="badge-icon">£</span><span id="finLedger">—</span></div>
    </div>

    <section class="card">
      <div class="fin-toolbar">
        <select id="finMonth" class="fin-select"></select>
        <div class="mode-tabs" id="finAccounts">
          <button class="mode-tab active" data-account="all">Both accounts</button>
          <button class="mode-tab" data-account="starling-personal">Personal</button>
          <button class="mode-tab" data-account="starling-business">Business</button>
        </div>
      </div>
      <div id="finNotice"></div>
      <div class="stats-summary" id="finTotals"></div>
    </section>

    <section class="card">
      <h2 class="fin-h2">Where it went</h2>
      <div id="finCats"></div>
    </section>

    <section class="card" id="finCash"></section>
  </div>
`;

let root = null;
let account = 'all';
let month = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gbp = (p) => `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function api(p) {
  const res = await fetch(`/api/finance${p}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function renderTotals(d) {
  const net = d.incomePence - d.totalPence;
  const prevNet = d.prevIncomePence - d.prevTotalPence;
  const arrow = (now, was) => {
    if (!was) return '';
    const pct = Math.round(((now - was) / was) * 100);
    if (!pct) return '<span class="fin-flat">level</span>';
    return `<span class="fin-${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '+' : ''}${pct}%</span>`;
  };

  root.querySelector('#finTotals').innerHTML = `
    <div class="stat-block">
      <span class="stat-value">${gbp(d.totalPence)}</span>
      <span class="stat-label">out ${arrow(d.totalPence, d.prevTotalPence)}</span>
    </div>
    <div class="stat-block">
      <span class="stat-value">${gbp(d.incomePence)}</span>
      <span class="stat-label">in ${arrow(d.incomePence, d.prevIncomePence)}</span>
    </div>
    <div class="stat-block">
      <span class="stat-value ${net < 0 ? 'fin-neg' : ''}">${net < 0 ? '−' : ''}${gbp(net)}</span>
      <span class="stat-label">net ${prevNet ? `<span class="fin-flat">was ${prevNet < 0 ? '−' : ''}${gbp(prevNet)}</span>` : ''}</span>
    </div>
  `;
}

function renderCategories(d) {
  const el = root.querySelector('#finCats');
  const live = d.categories.filter((c) => c.pence > 0 || c.wasPence > 0);

  if (!live.length) {
    // Three different facts, three different sentences. A failed load is handled in
    // load(); the other two are "this account has no statements covering this month" and
    // "it does, and nothing was spent" — which mean opposite things.
    const past = d.accountEnd && d.month > d.accountEnd.slice(0, 7);
    el.innerHTML = past
      ? `<p class="empty-hint">This account's statements end ${esc(d.accountEnd)}, so there is
         nothing imported for ${esc(d.month)}. That is missing data, not a month without spending.</p>`
      : `<p class="empty-hint">Nothing was spent in ${esc(d.month)} on this account. The statements
         do cover it — ${esc(d.accountEnd)} is the last day imported.</p>`;
    return;
  }

  const max = Math.max(...live.map((c) => Math.max(c.pence, c.wasPence)), 1);

  el.innerHTML = `
    <p class="fin-note">Compared with ${esc(d.prev)}${d.partial ? ` (both to day ${d.throughDay})` : ''}.
    Transfers between your own accounts are excluded — each one appears twice, once per side.</p>
    <ul class="fin-bars">
      ${live.map((c) => {
        const w = (c.pence / max) * 100;
        const wPrev = (c.wasPence / max) * 100;
        const gone = c.pence === 0 && c.wasPence > 0;
        return `
          <li class="fin-bar-row">
            <span class="fin-bar-label">${esc(c.category)}</span>
            <span class="fin-bar-track">
              <span class="fin-bar-now" style="width:${w}%"></span>
              ${c.wasPence > 0
                // Positioned, not sized: it marks where last month reached. Clamped so a
                // tick at 100% is not half-clipped by the track's overflow:hidden.
                ? `<span class="fin-bar-prev" style="left:calc(${Math.min(wPrev, 99.5)}% - 1px)"
                         title="${esc(d.prev)}: ${gbp(c.wasPence)}"></span>`
                : ''}
            </span>
            <span class="fin-bar-value">
              ${gbp(c.pence)}
              <span class="fin-bar-delta ${gone ? 'fin-gone' : c.deltaPence > 0 ? 'fin-up' : c.deltaPence < 0 ? 'fin-down' : 'fin-flat'}">
                ${gone ? 'none this month' : c.deltaPence === 0 ? '—' : `${c.deltaPence > 0 ? '+' : '−'}${gbp(c.deltaPence)}`}
              </span>
            </span>
          </li>`;
      }).join('')}
    </ul>
    <p class="fin-note fin-dim">The bar is ${esc(d.month)}. The tick marks where ${esc(d.prev)} reached.</p>
  `;
}

function renderCash(d) {
  root.querySelector('#finCash').innerHTML = `
    <h2 class="fin-h2">Cash</h2>
    <p class="fin-cash-figure">${gbp(d.cash.pence)}</p>
    <p class="fin-note">
      ${d.cash.n} withdrawal${d.cash.n === 1 ? '' : 's'} in ${esc(d.month)}.
      This is deliberately <strong>not</strong> in the breakdown above: once it leaves the
      account the ledger cannot say what it bought, and folding it into a category would
      imply it knows. Across the whole history that is about a tenth of everything spent,
      so treat every total above as covering the card and transfer spending only.
    </p>
  `;
}

async function load() {
  const notice = root.querySelector('#finNotice');
  let d;
  try {
    d = await api(`/spending?account=${encodeURIComponent(account)}${month ? `&month=${month}` : ''}`);
  } catch (err) {
    root.querySelector('#finCats').innerHTML =
      `<p class="fin-error">Could not load spending: ${esc(err.message)}</p>`;
    root.querySelector('#finTotals').innerHTML = '';
    root.querySelector('#finCash').innerHTML = '';
    return;
  }

  month = d.month;
  root.querySelector('#finMonth').value = d.month;

  notice.innerHTML = d.partial
    ? `<p class="fin-warn">${esc(d.month)} is incomplete — the ledger ends ${esc(d.ledgerEnd)}.
       Both months are therefore cut at day ${d.throughDay} so the comparison is like for like.
       This is an import, not a live feed; there is no data after that date because none has
       been imported, not because nothing was spent.</p>`
    : '';

  renderTotals(d);
  renderCategories(d);
  renderCash(d);
}

export default {
  async mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;

    let months = [];
    try { months = await api('/months'); } catch { /* handled below */ }

    if (!months.length) {
      el.querySelector('#finCats').innerHTML =
        '<p class="fin-error">The ledger is empty, or it could not be read. Run tools/import-starling.cjs.</p>';
      return;
    }

    el.querySelector('#finLedger').textContent =
      `${months.reduce((s, m) => s + m.n, 0).toLocaleString('en-GB')} transactions`;
    el.querySelector('#finMonth').innerHTML =
      months.map((m) => `<option value="${esc(m.month)}">${esc(m.month)} · ${m.n}</option>`).join('');

    el.querySelector('#finMonth').addEventListener('change', (e) => { month = e.target.value; load(); });
    el.querySelectorAll('#finAccounts .mode-tab').forEach((b) => {
      b.addEventListener('click', () => {
        account = b.dataset.account;
        el.querySelectorAll('#finAccounts .mode-tab').forEach((x) => x.classList.toggle('active', x === b));
        load();
      });
    });

    load();
  },

  unmount() {
    root = null;
    account = 'all';
    month = null;
  },
};
