// Where the money went. Reads only /api/finance.
//
// Three things this panel must never do, because each would make it lie quietly:
//   - include Own transfer in any total (with two accounts each transfer appears twice)
//   - present Cash withdrawn as a category of spending (the ledger does not know)
//   - compare a partial month against a whole one

import { renderLede } from '/panels/lede/lede.js';
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

    <section class="card">
      <h2 class="fin-h2">Profit &amp; loss</h2>
      <div class="fin-toolbar">
        <div class="mode-tabs" id="finPnlKind">
          <button class="mode-tab active" data-kind="business">Business</button>
          <button class="mode-tab" data-kind="personal">Personal</button>
        </div>
      </div>
      <div id="finPnl"></div>
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

    <section class="card">
      <h2 class="fin-h2">Cash — count the tin</h2>
      <div id="finCash2"></div>
    </section>

    <section class="card">
      <h2 class="fin-h2">Money in that may be your own transfer</h2>
      <div id="finSuspects"></div>
    </section>
  </div>
`;

let root = null;
let account = 'all';
let month = null;
let pnlKind = 'business';
// shell.js reuses #panelRoot between panels. A root-element check therefore cannot tell an
// old request from a new Finance mount; the generation is the mount's actual identity.
let generation = 0;
const current = (gen) => !!root && gen === generation;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gbp = (p) => `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const failureHint = (message, detail) => `<p class="empty-hint failure-hint">${esc(message)}${detail ? `<br><small>${esc(detail)}</small>` : ''}</p>`;

async function api(p, opts = {}) {
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
  const res = await fetch(`/api/finance${p}`, {
    ...opts,
    headers: { 'x-mc-by': 'you', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

async function cashApi(p, opts = {}) {
  const res = await fetch(`/api/cash${p}`, {
    ...opts,
    headers: { 'x-mc-by': 'you', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function renderTotals(d) {
  if (!root) return;   // called from an async path; the panel may already be torn down
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
  if (!root) return;   // called from an async path; the panel may already be torn down
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
  if (!root) return;   // called from an async path; the panel may already be torn down
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

// The bottom line, over a period rather than one month — companion to "Where it went",
// which only ever compares two months. Reads /api/finance/pnl, which is the ledger's own
// figure: the one place this money is counted, so a receipt or a screenshot can be checked
// against it but never gets its own copy of it.
async function loadPnl() {
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#finPnl');
  let d;
  try {
    d = await api(`/pnl?accountKind=${pnlKind}&months=12`);
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">Could not compute the P&amp;L: ${esc(err.message)}
      — a failure to compute, not a statement of zero profit.</p>`;
    return;
  }

  if (d.state !== 'ok') {
    box.innerHTML = `<p class="empty-hint">${esc(d.message || 'No transactions on this account yet.')}</p>`;
    return;
  }

  const t = d.totals;
  const monthRow = (m) => `
    <li class="fin-pnl-row${m.partial ? ' fin-pnl-partial' : ''}">
      <span class="fin-pnl-month">${esc(m.month)}${m.partial ? ' <b class="fin-r-warn">partial</b>' : ''}</span>
      <span class="fin-pnl-in">${gbp(m.incomePence)}</span>
      <span class="fin-pnl-out">${gbp(m.expensePence)}</span>
      <span class="fin-pnl-net${m.netPence < 0 ? ' fin-neg' : ''}">${m.netPence < 0 ? '−' : ''}${gbp(m.netPence)}</span>
    </li>`;

  const catRow = (c) => `
    <li>
      <span class="fin-fc-cat">${esc(c.category)}</span>
      <span class="fin-fc-amt">${gbp(c.pence)}</span>
    </li>`;

  box.innerHTML = `
    <p class="fin-note">${esc(d.from)} to ${esc(d.to)}
      (${d.months} month${d.months === 1 ? '' : 's'}${d.windowTruncated ? ` — the ${esc(pnlKind)} account starts here` : ''}),
      ledger ends ${esc(d.ledgerEndsOn)}.</p>

    <div class="stats-summary">
      <div class="stat-block"><span class="stat-value">${gbp(t.incomePence)}</span><span class="stat-label">income</span></div>
      <div class="stat-block"><span class="stat-value">${gbp(t.expensePence)}</span><span class="stat-label">expenses</span></div>
      <div class="stat-block"><span class="stat-value${t.netPence < 0 ? ' fin-neg' : ''}">${t.netPence < 0 ? '−' : ''}${gbp(t.netPence)}</span><span class="stat-label">net</span></div>
    </div>

    <h3 class="fin-h3">By month</h3>
    <ul class="fin-pnl-list">
      <li class="fin-pnl-row fin-pnl-head">
        <span class="fin-pnl-month">Month</span>
        <span class="fin-pnl-in">In</span>
        <span class="fin-pnl-out">Out</span>
        <span class="fin-pnl-net">Net</span>
      </li>
      ${d.monthly.map(monthRow).join('')}
    </ul>

    ${t.expenseByCategory.length ? `
      <h3 class="fin-h3">Expenses by category</h3>
      <ul class="fin-fc-list">${t.expenseByCategory.map(catRow).join('')}</ul>` : ''}

    ${t.incomeByCategory.length ? `
      <h3 class="fin-h3">Income by category</h3>
      <ul class="fin-fc-list">${t.incomeByCategory.map(catRow).join('')}</ul>` : ''}

    ${t.cashPence ? `<p class="fin-note">${gbp(t.cashPence)} withdrawn as cash in this window
      — not counted as an expense above. See "Cash" for why.</p>` : ''}

    ${d.uncategorisedPence ? `<p class="fin-warn">${gbp(d.uncategorisedPence)} across
      ${d.uncategorisedCount} transaction${d.uncategorisedCount === 1 ? '' : 's'} in this window
      ${d.uncategorisedCount === 1 ? 'has' : 'have'} no category yet, so ${d.uncategorisedCount === 1 ? "it isn't" : "they aren't"}
      in the totals above.</p>` : ''}

    <p class="fin-note fin-dim">${esc(d.excludedNote)}</p>
    <p class="fin-note fin-dim">${esc(d.caveat)}</p>`;
}

// The services audit. Backlog #39, and it is an INVENTORY, not a verdict — nothing here
// comments on what anything is for. What it can honestly answer is which services are
// still taking money and which quietly stopped.
async function loadRecurring() {
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#finRecurring');
  let d;
  try {
    d = await api('/recurring');
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">Could not read the services audit: ${esc(err.message)}</p>`;
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
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#finForecast');
  let d;
  try {
    d = await api('/forecast');
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">Could not compute the forecast: ${esc(err.message)}
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
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#finWorth');
  let d;
  try {
    d = await api('/net-worth');
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">Could not read holdings: ${esc(err.message)}
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
      if (!root) return;   // the panel was torn down mid-await; root is null now
      loadWorth();
    });
  });
}

// Backlog #14 — the "kept under review" half of allowing finance data to a frontier model.
// The panel's job here is NOT to reassure. A reader who takes this as a complete record of
// exposure has been misled, so the floor caveat is rendered at full size next to the
// numbers rather than tucked under them.
async function loadAccessLog() {
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#finAccess');
  let d;
  try {
    d = await api('/access-log');
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    // Could-not-look must not read like nothing-happened.
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">Could not read the access log: ${esc(err.message)}
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

// Backlog #M11. Money into the business account is TURNOVER unless it is categorised
// 'Own transfer', and turnover feeds the self-assessment report and the MTD threshold
// test. This names credits whose counterparty resembles a name the ledger already calls
// the owner, and it CHANGES NOTHING — there is no write path in the route or here.
async function loadSuspects() {
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#finSuspects');
  let d;
  try {
    d = await api('/own-transfer-suspects');
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">Could not run the check: ${esc(err.message)}
      — that is a failure to look, not a report that nothing is mislabelled.</p>`;
    return;
  }

  // ok:false is "could not look" and must never render as an all-clear.
  if (!d.ok) {
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">${esc(d.message)}</p>`;
    return;
  }

  const money = (p) => `£${(p / 100).toFixed(2)}`;
  const strong = d.candidates.filter((c) => !c.onlyTradingName);
  const trade = d.candidates.filter((c) => c.onlyTradingName);

  const row = (c) => `
    <li class="fin-s-row${c.inCurrentTaxYear ? ' fin-s-live' : ''}">
      <span class="fin-s-who">${esc(c.counterparty)}</span>
      <span class="fin-s-amt">${money(c.amountPence)}</span>
      <span class="fin-s-meta">${c.transactions} payment${c.transactions === 1 ? '' : 's'}
        · last ${esc(c.lastSeen)} · currently <b>${esc(c.category)}</b>${
          c.inCurrentTaxYear ? ' · <b>this tax year</b>' : ''}</span>
      <span class="fin-s-why">${c.matches.map((m) =>
        `shares “${esc(m.token)}” with ${esc(m.via[0])}${m.via.length > 1
          ? ` (+${m.via.length - 1} more spelling${m.via.length === 2 ? '' : 's'})` : ''
        } — that word is in ${m.alsoIn} of the ledger’s counterparties`).join('; ')}</span>
    </li>`;

  // Three states, not two: nothing to look at, looked and found nothing, and found something.
  const strongBlock = !strong.length
    ? `<p class="empty-hint">No business-account credit is under a name resembling yours,
         across the ${d.counts.creditTransactionsExamined} credits examined. That is a
         name-similarity check having found nothing — not a guarantee the turnover figure
         is right.</p>`
    : `<ul class="fin-s-list">${strong.map(row).join('')}</ul>`;

  box.innerHTML = `
    <p class="fin-note">Money in is <b>turnover</b> unless it is “Own transfer”, and turnover
      feeds the tax report and the Making Tax Digital threshold. These are credits under a
      name that <i>resembles</i> one the ledger already calls you. <b>It is a guess about a
      string and it changes nothing</b> — recategorising is your decision, in the ledger.</p>

    <h3 class="fin-h3">Resembles your name — worth a look</h3>
    ${strongBlock}

    ${trade.length ? `
      <h3 class="fin-h3">Matches the trading name, not a person</h3>
      <p class="fin-note">These share a word with <b>${esc(d.ownTransferStrings.find((s) =>
        d.tradingNameTokens.some((t) => s.toLowerCase().includes(t))) || 'the account name')}</b>
        — the account’s own trading name, taken from the account label. Anyone in the same
        trade matches it, so this is expected rather than suspicious. Shown rather than
        filtered out, because a check that hides its weak matches looks cleaner than it is.</p>
      <ul class="fin-s-list">${trade.map(row).join('')}</ul>` : ''}

    <div class="fin-s-residue">
      <b>What this looked at, and what it did not.</b>
      Examined ${d.counts.creditRowsExamined} distinct counterparties over
      ${d.counts.creditTransactionsExamined} credits into the business account,
      ledger ending ${esc(d.ledgerEndsOn)}.
      ${esc(d.residue.note)}
      It compares against ${d.ownTransferStrings.length} spellings the ledger already calls you.
      <ul>${d.blindTo.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`;
}

// Cash reconciliation — #M36. One number in, a whole category out of the dark.
//
// Lives inside Money rather than as its own nav entry: it is a fact about the ledger, and a
// fifteenth tab for one input box would be the surface-you-must-feed the workspace gate
// rejects. The capture is one field and the derivation returns in the same response.
async function loadCash() {
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#finCash2');
  let d;
  try {
    d = await cashApi('/');
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="fin-error empty-hint failure-hint">Could not read the cash state: ${esc(err.message)}
      — that is a failure to look, not a report that no cash was spent.</p>`;
    return;
  }

  const money = (p) => `£${(p / 100).toFixed(2)}`;
  const form = `
    <form id="cashForm" class="fin-c2-form">
      <label class="fin-c2-lab">Count the tin
        <input id="cashAmt" class="fin-select" type="number" step="0.01" min="0"
               inputmode="decimal" placeholder="e.g. 42.50" required>
      </label>
      <button class="btn primary" type="submit">Record</button>
      <span id="cashEcho" class="fin-c2-echo"></span>
    </form>`;

  // Three states, and none of them is a zero standing in for "do not know".
  let body;
  if (d.state === 'never counted' || d.state === 'baseline only') {
    body = `<p class="fin-note">${esc(d.why)}</p>`;
  } else if (d.state === 'error') {
    body = `<p class="fin-error empty-hint failure-hint">${esc(d.why)}</p>`;
  } else {
    const negative = d.spentInWindow < 0;
    body = `
      <p class="fin-c2-big ${negative ? 'fin-c2-in' : ''}">${money(Math.abs(d.spentInWindow))}
        <span class="fin-c2-cap">${negative ? 'arrived from outside the ledger' : 'spent in cash'}</span></p>
      <p class="fin-note">${esc(d.window.from)} to ${esc(d.window.to)}, ${d.window.days} days.
        ${money(d.previousCount.pence)} in the tin, ${money(d.withdrawnInWindow)} withdrawn across
        ${d.withdrawalsInWindow} withdrawal${d.withdrawalsInWindow === 1 ? '' : 's'},
        ${money(d.lastCount.pence)} left.
        ${d.perDay !== null && !negative ? `That is ${money(d.perDay)} a day.` : ''}</p>
      <p class="fin-note">${esc(d.why)}</p>`;
  }

  const stale = d.ledger && d.ledger.staleByDays > 0;
  box.innerHTML = `
    <p class="fin-note">Cash is the biggest thing the ledger cannot see. This does not track
      purchases — it counts the tin, and the difference against what you withdrew is the
      answer. <b>One number, whenever you happen to look.</b></p>
    ${body}
    ${form}
    ${d.lastCount ? `<p class="fin-note">Last counted ${esc(d.lastCount.on)}
        (${d.lastCount.daysAgo} day${d.lastCount.daysAgo === 1 ? '' : 's'} ago) at
        ${money(d.lastCount.pence)}. Since then ${money(d.ledger.penceSinceLastCount)} has been
        withdrawn across ${d.ledger.withdrawalsSinceLastCount} withdrawal${d.ledger.withdrawalsSinceLastCount === 1 ? '' : 's'}
        — the next count closes that window.</p>` : ''}
    ${d.blindTo ? `<div class="fin-s-residue"><b>What this cannot see.</b>
        <ul>${d.blindTo.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
    ${stale ? `<p class="fin-warn">The ledger is ${d.ledger.staleByDays} days behind today, so
        cash taken out since is missing from this. Import a statement before trusting the window.</p>` : ''}`;

  const f = box.querySelector('#cashForm');
  const echo = box.querySelector('#cashEcho');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = box.querySelector('#cashAmt').value;
    echo.textContent = 'recording…';
    try {
      const r = await fetch('/api/cash/counts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ pounds: Number(v) }),
      });
      const out = await r.json();
      if (!root) return;   // the panel was torn down mid-await; root is null now
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
      // The value comes straight back rather than after a reload — that is the rule for the
      // manual capture that is genuinely unavoidable.
      await loadCash();
      if (!root) return;   // the panel was torn down mid-await; root is null now
    } catch (err) {
      if (!root) return;   // the panel was torn down mid-await; root is null now
      echo.textContent = `Not recorded: ${err.message}`;
      echo.className = 'fin-c2-echo fin-error';
    }
  });
}

async function load() {
  const gen = generation;
  if (!current(gen)) return;   // may be CALLED after teardown, not only resumed after it
  const notice = root.querySelector('#finNotice');
  let d;
  try {
    d = await api(`/spending?account=${encodeURIComponent(account)}${month ? `&month=${month}` : ''}`);
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!current(gen)) return;   // this mount was superseded mid-await
    if (!root) return;   // the panel was torn down mid-await; root is null now
    root.querySelector('#finCats').innerHTML =
      `<p class="fin-error empty-hint failure-hint">Could not load spending: ${esc(err.message)}<br><small>That is a failure to look, not a report that nothing was spent.</small></p>`;
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

  // Neither depends on the month/account selectors above — the P&L has its own toolbar,
  // the services audit reads the whole ledger — but both are loaded here so neither can be
  // defined and left uncalled.
  loadPnl();
  loadRecurring();
  // Same reason, same place. `loadRecurring` was itself shipped once defined-and-uncalled,
  // which is a bug with no error message and no visible symptom beyond an empty box.
  loadAccessLog();
  loadWorth();
  loadForecast();
  loadSuspects();
  loadCash();
}

export default {
  async mount(el) {
    root = el;
    const gen = ++generation;
    el.innerHTML = TEMPLATE;
    renderLede('finance', el);

    let months;
    let monthsError;
    try { months = await api('/months'); } catch (err) { monthsError = err; }
    if (!current(gen)) return;

    if (monthsError) {
      el.querySelector('#finCats').innerHTML =
        failureHint(`Could not read the ledger: ${monthsError.message}`,
          'That is a failure to look, not a report that the ledger is empty.');
      return;
    }

    if (!months.length) {
      el.querySelector('#finCats').innerHTML =
        '<p class="empty-hint">There are no imported ledger months yet. Run tools/import-starling.cjs after an export is available.</p>';
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

    el.querySelectorAll('#finPnlKind .mode-tab').forEach((b) => {
      b.addEventListener('click', () => {
        pnlKind = b.dataset.kind;
        el.querySelectorAll('#finPnlKind .mode-tab').forEach((x) => x.classList.toggle('active', x === b));
        loadPnl();
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
    generation += 1;
    root = null;
    account = 'all';
    month = null;
    pnlKind = 'business';
  },
};
