// Income. Reads only /api/income.
//
// It records what the small streams ALREADY PAID — Honeygain, PacketStream, SerpClix,
// Coinbase, PayPal and anything else you add. Nothing here logs in to a service, and
// nothing here automates the earning; you read the figure off the service's own dashboard
// and this remembers it.
//
// What it puts on screen that you did not type: the rate per month, the rate per hour where
// you logged the time, how long each stream has been silent, and each stream's share of the
// total. Where a figure cannot be computed the cell says why — it is never left blank and
// never filled with a guess.

import { renderLede } from '/panels/lede/lede.js';
const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Income</h1>
      <div class="badge"><span class="badge-icon">◷</span><span id="incMonth">—</span></div>
    </div>

    <section class="card">
      <div id="incState"></div>
      <div class="stats-summary" id="incTotals"></div>
      <div id="incAwaiting"></div>
      <div id="incProjection"></div>
    </section>

    <section class="card">
      <h2 class="inc-h2">Record what a stream paid</h2>
      <form class="inc-add" id="incRecord">
        <select id="incStream" class="inc-in inc-sel" aria-label="Stream"></select>
        <input id="incPeriod" class="inc-in inc-period" type="month" aria-label="Month" required>
        <input id="incAmount" class="inc-in inc-amount" type="number" step="0.01" min="0" placeholder="amount" aria-label="Amount" required>
        <input id="incMinutes" class="inc-in inc-minutes" type="number" step="1" min="0" placeholder="mins" aria-label="Minutes spent" title="Optional. Without it there is no hourly rate — and none is invented.">
        <button class="btn primary" type="submit">Record</button>
      </form>
      <p class="inc-note inc-dim">One entry per stream per month; recording the same month again replaces it,
      and the panel tells you what it replaced. Minutes are optional — leave it blank and the hourly column
      says so rather than showing a number.</p>
      <p id="incRecordMsg" class="inc-note"></p>
    </section>

    <section class="card">
      <h2 class="inc-h2">Per stream</h2>
      <div id="incStreams"></div>
    </section>

    <section class="card">
      <h2 class="inc-h2">Recent entries</h2>
      <div id="incEntries"></div>
    </section>

    <section class="card">
      <h2 class="inc-h2">Add a stream</h2>
      <form class="inc-add" id="incNewStream">
        <input id="incNewLabel" class="inc-in" placeholder="Name of the service" required>
        <select id="incNewKind" class="inc-in inc-sel" aria-label="Kind"></select>
        <button class="btn" type="submit">Add</button>
      </form>
      <p id="incStreamMsg" class="inc-note"></p>
      <p class="inc-note inc-dim" id="incScope"></p>
    </section>
  </div>
`;

let root = null;
let onVisible = null;
// Incremented on every mount and unmount. A fetch that lands after you switched panels
// writes into a dead DOM, or worse, into the next panel's — so every response checks that
// the world it was asked in is still the current one.
let token = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Currency-aware, because this ledger can hold USD next to GBP and a "£" in front of a USD
// figure is a wrong number, not a formatting slip.
function money(pence, currency = 'GBP') {
  const v = (pence ?? 0) / 100;
  try {
    return v.toLocaleString('en-GB', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

async function api(path, opts) {
  const res = await fetch(`/api/income${path}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// A failed fetch and an empty table must never render the same, or a broken parser reads as
// good news and nobody investigates it. Everything that can fail comes through here.
function fail(el, what, err) {
  el.innerHTML = `<p class="inc-error"><b>Could not load ${esc(what)}.</b> ${esc(err.message)}<br>
    <span class="inc-dim">This is a failure, not an empty list — the figures below may be missing rather than zero.</span></p>`;
}

// ------------------------------------------------------------------ summary + streams
function renderSummary(d) {
  root.querySelector('#incMonth').textContent = d.month;

  const state = root.querySelector('#incState');
  if (d.state === 'no-streams') {
    state.innerHTML = '<p class="empty-hint">No streams defined. Add one below.</p>';
  } else if (d.state === 'no-entries') {
    state.innerHTML = `<p class="empty-hint">${d.streams.length} streams are set up and <b>nothing has been recorded yet</b>.
      That is an empty ledger, not a broken one — record a month above and every figure here starts working.</p>`;
  } else {
    state.innerHTML = '';
  }

  const cur = d.grandTotalCurrency || 'GBP';
  const perMonth = d.monthsRecorded ? Math.round((d.grandTotalPence ?? 0) / d.monthsRecorded) : null;

  root.querySelector('#incTotals').innerHTML = d.mixedCurrency
    ? `${d.totals.map((t) => `
        <div class="stat-block"><span class="stat-value">${money(t.pence, t.currency)}</span>
        <span class="stat-label">${esc(t.currency)} total</span></div>`).join('')}
       <div class="stat-block"><span class="stat-value">${d.monthsRecorded}</span><span class="stat-label">months recorded</span></div>`
    : `
      <div class="stat-block"><span class="stat-value">${money(d.grandTotalPence, cur)}</span><span class="stat-label">recorded in total</span></div>
      <div class="stat-block"><span class="stat-value">${d.monthsRecorded}</span><span class="stat-label">months recorded</span></div>
      <div class="stat-block"><span class="stat-value">${perMonth == null ? '—' : money(perMonth, cur)}</span><span class="stat-label">per recorded month</span></div>
      <div class="stat-block"><span class="stat-value">${d.streams.filter((s) => s.state === 'ok').length}<span class="inc-of">/${d.streams.length}</span></span><span class="stat-label">streams with entries</span></div>`;

  const awaiting = root.querySelector('#incAwaiting');
  if (d.mixedCurrency) {
    awaiting.innerHTML = `<p class="inc-warn">${esc(d.grandTotalNote)}</p>`;
  } else {
    awaiting.innerHTML = '';
  }
  if (d.awaitingThisMonth.length && d.state !== 'no-streams') {
    awaiting.innerHTML += `<p class="inc-note">Nothing recorded for <b>${esc(d.month)}</b> yet:
      ${d.awaitingThisMonth.map((s) => `<span class="inc-chip">${esc(s.label)}</span>`).join(' ')}
      <span class="inc-dim">— these are the dashboards still worth opening.</span></p>`;
  }

  // A projection is withheld on thin data rather than shown with a caveat. A number on the
  // page is read as a number on the page.
  const proj = root.querySelector('#incProjection');
  proj.innerHTML = d.projection.state === 'ok'
    ? `<p class="inc-note"><b>${money(d.projection.medianMonthlyPence, d.projection.currency || cur)}</b> a month,
        <b>${money(d.projection.annualisedPence, d.projection.currency || cur)}</b> a year — <span class="inc-dim">${esc(d.projection.basis)}</span></p>`
    : `<p class="inc-note inc-dim">No run rate shown. ${esc(d.projection.message)}</p>`;
}

function streamRow(s, cur) {
  const dead = s.state === 'ok' && s.monthsSinceLast >= 2;
  const never = s.state === 'never-recorded';
  const c = s.currency && s.currency !== 'mixed' ? s.currency : cur;

  const hourly = s.worthIt.state === 'computed'
    ? `<b>${money(s.hourlyPence, c)}</b>/hr<span class="inc-sub">${esc(s.worthIt.coverage)}</span>`
    : `<span class="inc-dim">not computed</span>`;

  // The "worth it?" cell. It never contains a verdict — it contains the inputs, or the
  // reason there is no answer.
  let worth;
  if (s.worthIt.state === 'no-entries') {
    worth = '<span class="inc-dim">nothing recorded</span>';
  } else if (s.worthIt.state === 'no-effort') {
    worth = `<span class="inc-dim">no time logged — add minutes to an entry</span>`;
  } else {
    const rank = s.hourlyRank && s.hourlyRank.of > 1
      ? (s.hourlyRank.position === 1
        ? `<span class="inc-good">best rate of the ${s.hourlyRank.of} you time</span>`
        : `<span class="inc-sub">${esc(s.hourlyRank.bestIs.label)} paid ${money(s.hourlyRank.bestIs.hourlyPence, c)}/hr for the same hour</span>`)
      : '<span class="inc-sub">the only stream you time, so nothing to compare it with</span>';
    worth = `${esc(s.worthIt.text)}<br>${rank}`;
  }

  return `
    <tr class="${never ? 'inc-never' : ''}${dead ? ' inc-quiet' : ''}">
      <td>
        <span class="inc-name">${esc(s.label)}</span>
        <span class="inc-sub">${esc(s.kind)}${s.active ? '' : ' · inactive'}</span>
      </td>
      <td class="inc-num">${never ? '<span class="inc-dim">—</span>' : money(s.totalPence, c)}</td>
      <td class="inc-num">${s.sharePct == null ? '<span class="inc-dim">—</span>' : `${s.sharePct}%`}</td>
      <td class="inc-num">${never ? '<span class="inc-dim">—</span>' : `${s.monthsRecorded}${s.monthsMissing ? `<span class="inc-sub">${s.monthsMissing} month${s.monthsMissing === 1 ? '' : 's'} missing</span>` : ''}`}</td>
      <td class="inc-num">${never ? '<span class="inc-dim">—</span>' : money(s.perRecordedMonthPence, c)}</td>
      <td class="inc-num">${hourly}</td>
      <td class="inc-when ${dead ? 'inc-warn-text' : ''}">${esc(s.staleness)}${s.lastPeriod ? `<span class="inc-sub">${esc(s.lastPeriod)}</span>` : ''}</td>
      <td class="inc-worth">${worth}</td>
    </tr>`;
}

function renderStreams(d) {
  const el = root.querySelector('#incStreams');
  if (!d.streams.length) {
    el.innerHTML = '<p class="empty-hint">No streams yet.</p>';
    return;
  }
  const cur = d.grandTotalCurrency || 'GBP';
  const anyTimed = d.streams.some((s) => s.worthIt.state === 'computed');

  el.innerHTML = `
    <div class="inc-scroll">
      <table class="inc-table">
        <thead>
          <tr>
            <th>Stream</th><th class="inc-num">Total</th><th class="inc-num">Share</th>
            <th class="inc-num">Months</th><th class="inc-num">Per month</th><th class="inc-num">Per hour</th>
            <th>Last paid</th><th>Worth it?</th>
          </tr>
        </thead>
        <tbody>${d.streams.map((s) => streamRow(s, cur)).join('')}</tbody>
      </table>
    </div>
    <p class="inc-note">"Per month" is the total divided by the months you <i>recorded</i>, not by the calendar —
    the missing-month count beside it is the difference, and it is the reason the two are not reconciled into one figure.</p>
    ${anyTimed ? '' : `<p class="inc-note inc-dim">No hourly rate anywhere yet: no entry carries a time.
      The rate appears for a stream the first time you record minutes with an amount, and only the months
      carrying both are used — otherwise one logged afternoon would set the rate for a whole year of money.</p>`}
    <p class="inc-note inc-dim">${esc(d.method)}</p>`;
}

// ------------------------------------------------------------------ entries
async function loadEntries() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const mine = token;
  const el = root.querySelector('#incEntries');
  let d;
  try { d = await api('/entries?months=12'); } catch (err) { if (mine === token) fail(el, 'the entries', err); return; }
  if (mine !== token || !root) return;

  if (d.state === 'empty') {
    el.innerHTML = `<p class="empty-hint">${esc(d.message)} <span class="inc-dim">(the request succeeded — there is genuinely nothing in this window)</span></p>`;
    return;
  }

  el.innerHTML = `
    <ul class="inc-entries">
      ${d.entries.map((e) => `
        <li>
          <span class="inc-e-period">${esc(e.period)}</span>
          <span class="inc-e-label">${esc(e.label)}</span>
          <span class="inc-e-amount">${money(e.amount_pence, e.currency)}</span>
          <span class="inc-e-mins">${e.effort_minutes == null ? '<span class="inc-dim">no time logged</span>' : `${e.effort_minutes} min`}</span>
          <button class="inc-del" data-del="${e.id}" title="Delete this entry">×</button>
        </li>`).join('')}
    </ul>
    <p class="inc-note inc-dim">Last 12 months${d.totals.length === 1 ? `, ${money(d.totals[0].pence, d.totals[0].currency)} in the window` : ''}.</p>`;

  el.querySelectorAll('.inc-del').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/entries/${b.dataset.del}`, { method: 'DELETE' }); } catch (err) { fail(el, 'the delete', err); return; }
    load();
  }));
}

// ------------------------------------------------------------------ load
async function load() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const mine = token;
  let d;
  try {
    d = await api('/');
  } catch (err) {
    if (mine !== token || !root) return;
    fail(root.querySelector('#incState'), 'the income summary', err);
    // Every region this load owns is cleared and then SAID to be unloaded. Leaving a card
    // blank would put "no entries" and "the request failed" on screen as the same thing,
    // and stale content from a previous load would be worse still.
    root.querySelector('#incTotals').innerHTML = '';
    root.querySelector('#incAwaiting').innerHTML = '';
    root.querySelector('#incProjection').innerHTML = '';
    root.querySelector('#incStreams').innerHTML = '<p class="inc-error">Not loaded — the summary request above failed.</p>';
    root.querySelector('#incEntries').innerHTML = '<p class="inc-error">Not loaded — the summary request above failed. This is not an empty ledger.</p>';
    return;
  }
  if (mine !== token || !root) return;

  renderSummary(d);
  renderStreams(d);
  fillPickers(d);
  root.querySelector('#incScope').textContent = d.scope;
  await loadEntries();
}

function fillPickers(d) {
  const sel = root.querySelector('#incStream');
  const keep = sel.value;
  sel.innerHTML = d.streams.filter((s) => s.active || s.entries)
    .map((s) => `<option value="${esc(s.id)}"${s.active ? '' : ' data-inactive="1"'}>${esc(s.label)}${s.active ? '' : ' (inactive)'}</option>`).join('');
  if (keep) sel.value = keep;

  const kinds = root.querySelector('#incNewKind');
  if (!kinds.options.length) {
    kinds.innerHTML = d.kinds.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  }
}

export default {
  mount(el) {
    root = el;
    token += 1;
    el.innerHTML = TEMPLATE;
    renderLede('income', el);

    // Local month, not toISOString().slice(0,7) — on the 1st of the month before 01:00 BST
    // that returns the previous month and files the entry against the wrong one.
    const now = new Date();
    el.querySelector('#incPeriod').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    el.querySelector('#incRecord').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = el.querySelector('#incRecordMsg');
      const minutes = el.querySelector('#incMinutes').value;
      try {
        const r = await api('/entries', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({
            stream: el.querySelector('#incStream').value,
            period: el.querySelector('#incPeriod').value,
            amount: Number(el.querySelector('#incAmount').value),
            minutes: minutes === '' ? undefined : Number(minutes),
          }),
        });
        // An overwrite is reported, never silent. This is the only control here that can
        // destroy a figure you entered.
        msg.className = 'inc-note';
        msg.innerHTML = r.replaced
          ? `Recorded ${esc(r.period)} — <b>replaced</b> the ${money(r.replaced.amountPence, r.replaced.currency)} that was there.`
          : `Recorded ${esc(r.period)}, ${money(r.amountPence, r.currency)}.`;
        el.querySelector('#incAmount').value = '';
        el.querySelector('#incMinutes').value = '';
        load();
      } catch (err) {
        msg.className = 'inc-note inc-error';
        msg.textContent = `Not recorded: ${err.message}`;
      }
    });

    el.querySelector('#incNewStream').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = el.querySelector('#incStreamMsg');
      try {
        const r = await api('/streams', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({
            label: el.querySelector('#incNewLabel').value.trim(),
            kind: el.querySelector('#incNewKind').value,
          }),
        });
        msg.className = 'inc-note';
        msg.textContent = `Added ${r.label} (${r.id}).`;
        el.querySelector('#incNewLabel').value = '';
        load();
      } catch (err) {
        msg.className = 'inc-note inc-error';
        msg.textContent = `Not added: ${err.message}`;
      }
    });

    // Cheap freshness instead of a poll: another session or your phone can record a month
    // while this tab sits in the background. No interval is held.
    onVisible = () => { if (document.visibilityState === 'visible' && root) load(); };
    document.addEventListener('visibilitychange', onVisible);

    load();
  },

  unmount() {
    // The document-level listener outlives the DOM the shell throws away, and a fetch in
    // flight would otherwise write into the next panel. Both are cut here.
    if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    onVisible = null;
    token += 1;
    root = null;
  },
};
