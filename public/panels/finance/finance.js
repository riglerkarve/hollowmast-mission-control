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

    <section class="card">
      <h2 class="fin-h2">Services still charging you</h2>
      <div id="finRecurring"></div>
    </section>

    <section class="card">
      <h2 class="fin-h2">What comes in</h2>
      <div id="finForecast"></div>
    </section>

    <section class="card">
      <h2 class="fin-h2">What you have</h2>
      <div id="finWorth"></div>
      <details class="fin-nw-add">
        <summary>Add something the bank cannot see</summary>
        <form class="fin-nw-form" id="finAssetForm">
          <div class="fin-nw-row">
            <input id="finAssetLabel" class="fin-in" placeholder="What is it?" required maxlength="60">
            <select id="finAssetKind" class="fin-select" aria-label="Kind"></select>
          </div>
          <div class="fin-nw-row">
            <input id="finAssetAmount" class="fin-in" type="number" step="0.01" placeholder="£ amount" required>
            <input id="finAssetDate" class="fin-in" type="date" required
                   aria-label="True as of which date">
          </div>
          <p class="fin-nw-hint">The date is required and is not decoration: a figure you
            typed is true on the day you typed it, and the total is only as current as its
            oldest part.</p>
          <button class="btn primary" type="submit">Add</button>
        </form>
        <div id="finAssetResult"></div>
      </details>
    </section>

    <section class="card">
      <h2 class="fin-h2">Who has read this ledger</h2>
      <div id="finAccess"></div>
    </section>
  </div>
`;

let root = null;
let account = 'all';
let month = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gbp = (p) => `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function api(p) {
  // The header goes on READS too, not just writes. Provenance was built to answer "who
  // wrote this row", so panels send x-mc-by only on POST/PATCH — measured 18 Aug: 13 panels
  // define their own api() wrapper and NOT ONE sends it on a GET. That was harmless while
  // only writes were attributed. The access log (#14) reads it as well, and without this
  // every time you opened this panel it was recorded as `unknown` — which is precisely the
  // actor the log exists to isolate. A browser read looking identical to an unidentified
  // caller makes the whole log unreadable.
  //
  // Fixed here only. The other twelve panels still under-attribute their reads, and that
  // stays true until either a shared fetch helper exists or the watched-table list grows
  // past finance_. Recorded rather than silently half-fixed.
  const res = await fetch(`/api/finance${p}`, { headers: { 'x-mc-by': 'you' } });
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

// The services audit. Backlog #39, and it is an INVENTORY, not a verdict — nothing here
// comments on what anything is for. What it can honestly answer is which services are
// still taking money and which quietly stopped.
async function loadRecurring() {
  const box = root.querySelector('#finRecurring');
  let d;
  try {
    d = await api('/recurring');
  } catch (err) {
    box.innerHTML = `<p class="fin-error">Could not read the services audit: ${esc(err.message)}</p>`;
    return;
  }
  if (d.state !== 'ok') { box.innerHTML = '<p class="empty-hint">No ledger to read yet.</p>'; return; }

  const live = d.services.filter((s) => s.status === 'still charging');
  const stopped = d.services.filter((s) => s.status === 'stopped charging');
  const unclear = d.services.filter((s) => s.status === 'unclear');

  const row = (s) => `
    <li>
      <span class="fin-r-name">${esc(s.name)}</span>
      <span class="fin-r-when">last charged ${s.daysSinceLast} day${s.daysSinceLast === 1 ? '' : 's'} before the ledger ends${
        s.medianGapDays > 0 ? ` · usually every ~${s.medianGapDays}d` : ''}${
        s.medianGapDays > 0 && !s.gapsAreRegular
          // The median is shown and then undermined, because a wide spread means it is not
          // a billing cycle. Hiding the spread would make a noisy figure look authoritative.
          ? ` <b class="fin-r-warn">(irregular: ${s.gapRange.min}–${s.gapRange.max}d, so that is an average, not a cycle)</b>`
          : ''}</span>
      <span class="fin-r-sum">${s.charges} charges · ${gbp(s.totalPence)} total · last ${gbp(s.lastPence)}</span>
    </li>`;

  box.innerHTML = `
    <p class="fin-note">Measured to <b>${esc(d.asOf)}</b>, where the ledger ends — not to today.
      Counting from today would add the ${d.ledgerStaleDays}-day import lag to every row.</p>

    <h3 class="fin-h3">Still charging (${live.length})</h3>
    ${live.length ? `<ul class="fin-recur">${live.map(row).join('')}</ul>`
    : '<p class="empty-hint">Nothing in these categories has charged within twice its own typical gap.</p>'}

    ${d.notEnoughHistory.length ? `
      <h3 class="fin-h3">Too few charges to judge (${d.notEnoughHistory.length})</h3>
      <p class="fin-note">Shown rather than filtered away: a subscription that started recently
        is indistinguishable from one that never recurred, and dropping it would hide the newest thing here.</p>
      <ul class="fin-recur">${d.notEnoughHistory.slice(0, 6).map((s) => `
        <li><span class="fin-r-name">${esc(s.name)}</span>
          <span class="fin-r-when">${s.charges} charge${s.charges === 1 ? '' : 's'} · last ${gbp(s.lastPence)}, ${s.daysSinceLast} days before the ledger ends</span></li>`).join('')}</ul>` : ''}

    <details class="fin-more">
      <summary>Stopped charging (${stopped.length})${unclear.length ? ` · unclear (${unclear.length})` : ''}</summary>
      ${stopped.length ? `<ul class="fin-recur">${stopped.map(row).join('')}</ul>` : ''}
      ${unclear.length ? `<p class="fin-note">Unclear, kept separate rather than guessed:
        ${unclear.map((s) => esc(s.name)).join(', ')} — most of their charges land on the same day as
        the one before, so there is no gap to measure and neither answer would be honest.</p>` : ''}
    </details>

    <p class="fin-note fin-dim">${esc(d.basis)}</p>`;
}

// Backlog #36. The route has existed and returned 200 since it was written, and was shown
// NOWHERE — the sixth built-and-unconnected capability found in this project. The work here
// is displaying it.
//
// The item's own rationale set the constraint: "forecast only what is regular, and show the
// residual." So the projection and the residual are rendered at the SAME visual weight. A
// projection shown large with its residual in small print is the failure mode — it invites
// reading the projection as income, which is exactly what it is not.
async function loadForecast() {
  const box = root.querySelector('#finForecast');
  let d;
  try {
    d = await api('/forecast');
  } catch (err) {
    box.innerHTML = `<p class="fin-error">Could not compute the forecast: ${esc(err.message)}
      — a failure to compute, not a report that nothing comes in.</p>`;
    return;
  }

  if (d.state && d.state !== 'ok') {
    box.innerHTML = `<p class="empty-hint">Not enough complete months to say anything yet.</p>`;
    return;
  }

  // A VARIABILITY FIGURE IS SUPPRESSED BELOW THE MONTH MINIMUM, not just noted elsewhere.
  // Gambling has one observation, so its coefficient of variation is 0.000 — mathematically
  // correct and read as "±0%, perfectly predictable", which made it look like the steadiest
  // income on the card. One point cannot vary. The count is the honest thing to show, and
  // the reason it is held back belongs in the row rather than only in the basis text below.
  const MIN_MONTHS = 6;
  const vary = (r) => {
    if (r.months < MIN_MONTHS) return `too few months to judge how much it varies`;
    if (r.cv === null) return 'variability unmeasurable';
    return `varies ±${Math.round(r.cv * 100)}%`;
  };

  const row = (r, kind) => `
    <li class="fin-fc-${kind}">
      <span class="fin-fc-cat">${esc(r.category)}</span>
      <span class="fin-fc-amt">${gbp(r.mean)}<span class="fin-fc-per">/mo</span></span>
      <span class="fin-fc-var">${r.months} month${r.months === 1 ? '' : 's'} · ${esc(vary(r))}</span>
    </li>`;

  box.innerHTML = `
    <div class="fin-fc-heads">
      <div class="fin-fc-head">
        <span class="fin-fc-label">Regular enough to project</span>
        <b class="fin-fc-big">${gbp(d.projectedMonthlyPence)}<span class="fin-fc-per">/mo</span></b>
      </div>
      <div class="fin-fc-head">
        <span class="fin-fc-label">Arrives, but not predictably</span>
        <b class="fin-fc-big fin-fc-residual">${gbp(d.residualMonthlyPence)}<span class="fin-fc-per">/mo</span></b>
      </div>
    </div>

    <ul class="fin-fc-list">
      ${d.projected.map((r) => row(r, 'proj')).join('')}
      ${d.residual.map((r) => row(r, 'res')).join('')}
    </ul>

    ${d.warning ? `<p class="fin-fc-warn"><b>${esc(d.warning)}</b></p>` : ''}
    <p class="fin-note">${esc(d.basis)}</p>
    <p class="fin-note fin-dim">${esc(d.excludedNote)}</p>`;
}

// Backlog #77. Two halves that are never merged into one undated figure: cash derived from
// the ledger, and holdings you typed. The staleness of each is shown, because a total
// assembled from figures dated across three months is not a figure about today.
async function loadWorth() {
  const box = root.querySelector('#finWorth');
  let d;
  try {
    d = await api('/net-worth');
  } catch (err) {
    box.innerHTML = `<p class="fin-error">Could not read holdings: ${esc(err.message)}
      — a failure to look, not a report that you have nothing.</p>`;
    return;
  }

  const kindSel = root.querySelector('#finAssetKind');
  if (kindSel && !kindSel.options.length) {
    kindSel.innerHTML = d.kinds.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  }

  const age = (n) => (n <= 1 ? 'today' : `${n}d old`);
  // delId is passed only for rows YOU entered. A ledger-derived balance has no delete,
  // because removing it would mean hiding a figure the bank reports rather than editing one.
  const row = (label, sub, pence, days, cls = '', delId = null) => `
    <li class="${cls}">
      <span class="fin-nw-what">${esc(label)}<span class="fin-nw-sub">${esc(sub)}</span></span>
      <span class="fin-nw-amt${pence < 0 ? ' fin-neg' : ''}">${pence < 0 ? '−' : ''}${gbp(pence)}</span>
      <span class="fin-nw-age${days > 30 ? ' fin-nw-stale' : ''}">${esc(age(days))}</span>
      ${delId ? `<button class="fin-nw-del" data-del="${delId}" aria-label="Remove ${esc(label)}">×</button>` : '<span></span>'}
    </li>`;

  // The headline is deliberately NOT called net worth when nothing but the bank is known.
  // Calling a £0.03 cash balance "net worth" would be a claim about what you own.
  const isNetWorth = d.assetsRecorded > 0;

  box.innerHTML = `
    <div class="fin-nw-total">
      <span class="fin-nw-label">${isNetWorth ? 'Net worth' : 'Cash in the bank'}</span>
      <b class="fin-nw-big${d.totalPence < 0 ? ' fin-neg' : ''}">${d.totalPence < 0 ? '−' : ''}${gbp(d.totalPence)}</b>
      <span class="fin-nw-asof">as of ${esc(d.asOf || '—')}${
  d.stalestDays != null ? ` · oldest input ${d.stalestDays}d old` : ''}</span>
    </div>

    <ul class="fin-nw-list">
      ${d.cash.map((c) => row(c.label, ' · from the ledger', c.pence, c.staleDays)).join('')}
      ${d.assets.map((a) => row(a.label, ` · ${a.kind}, you told me`, a.amount_pence, a.staleDays, 'fin-nw-mine', a.id)).join('')}
    </ul>

    ${d.assetsRecorded
    ? `<p class="fin-nw-split">Bank ${gbp(d.cashTotalPence)} · yours ${d.assetTotalPence < 0 ? '−' : ''}${gbp(d.assetTotalPence)}</p>`
    : ''}

    <div class="fin-nw-caveat">
      <b>${isNetWorth ? 'The date shown is the oldest input, not the newest.' : 'This is not a net worth.'}</b>
      ${esc(d.caveat)} ${esc(d.derivedNote)}
    </div>`;

  box.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/assets/${b.dataset.del}`, { method: 'DELETE', headers: { 'x-mc-by': 'you' } });
      loadWorth();
    });
  });
}

// Backlog #14 — the "kept under review" half of allowing finance data to a frontier model.
// The panel's job here is NOT to reassure. A reader who takes this as a complete record of
// exposure has been misled, so the floor caveat is rendered at full size next to the
// numbers rather than tucked under them.
async function loadAccessLog() {
  const box = root.querySelector('#finAccess');
  let d;
  try {
    d = await api('/access-log');
  } catch (err) {
    // Could-not-look must not read like nothing-happened.
    box.innerHTML = `<p class="fin-error">Could not read the access log: ${esc(err.message)}
      — that is a failure to look, not a report that nothing read the ledger.</p>`;
    return;
  }

  const total = d.actors.reduce((n, a) => n + a.reads + a.writes, 0);

  // Three distinguishable states, not two. "Logging has not started" and "logging is on and
  // saw nothing" are different facts and only one of them is reassuring.
  const body = !d.startedAt
    ? `<p class="empty-hint">Access logging has not recorded anything yet. It began with the
         server it is running under — this is not a statement that the ledger was never read.</p>`
    : !total
      ? `<p class="empty-hint">Logging active since ${esc(d.startedAt)} and no reads of the
           finance tables recorded in the last ${d.days} days.</p>`
      : `<ul class="fin-access-list">${d.actors.map((a) => `
          <li>
            <span class="fin-a-who">${esc(a.actor)}</span>
            <span class="fin-a-counts">${a.reads} read${a.reads === 1 ? '' : 's'}${
              a.writes ? ` · ${a.writes} write${a.writes === 1 ? '' : 's'}` : ''}</span>
            <span class="fin-a-tables">${esc(a.tables.join(', '))}</span>
          </li>`).join('')}</ul>
         <p class="fin-a-since">Since ${esc(d.startedAt)}, last ${d.days} days.
           <b>unknown</b> means a caller that did not say who it was — never assumed to be you.</p>`;

  box.innerHTML = `
    ${body}
    <div class="fin-a-floor">
      <b>This is a floor, not a total.</b> Real access is at least this and cannot be less.
      It counts every read that goes through the shared database module — the server and
      every tool in this project — and it cannot see:
      <ul>${d.blindTo.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`;
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

  // The services audit does not depend on the month or account selectors — it reads the
  // whole ledger — but it is loaded here so it can never be defined and left uncalled.
  loadRecurring();
  // Same reason, same place. `loadRecurring` was itself shipped once defined-and-uncalled,
  // which is a bug with no error message and no visible symptom beyond an empty box.
  loadAccessLog();
  loadWorth();
  loadForecast();
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

    el.querySelector('#finAssetForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const out = el.querySelector('#finAssetResult');
      out.innerHTML = '';
      try {
        await api('/assets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({
            label: el.querySelector('#finAssetLabel').value.trim(),
            kind: el.querySelector('#finAssetKind').value,
            amount: Number(el.querySelector('#finAssetAmount').value),
            asOf: el.querySelector('#finAssetDate').value,
          }),
        });
        el.querySelector('#finAssetLabel').value = '';
        el.querySelector('#finAssetAmount').value = '';
        loadWorth();
      } catch (err) {
        out.innerHTML = `<p class="fin-error">${esc(err.message)}</p>`;
      }
    });

    // Defaults to today, because the commonest case is entering a figure you just checked
    // — and an empty date field invites leaving it empty, which the route refuses anyway.
    el.querySelector('#finAssetDate').value = new Date().toLocaleDateString('en-CA');

    load();
  },

  unmount() {
    root = null;
    account = 'all';
    month = null;
  },
};
