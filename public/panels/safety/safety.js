// Safety — the hard limits. Reads only /api/safety.
//
// The panel's job is to make the guard's state impossible to misread. Two things it does
// deliberately:
//
//   - UNCONFIGURED IS SHOWN AS A STATE, not as an empty form. A guard with no ceilings
//     refuses everything, which is safe but is easy to mistake for "not working". The
//     banner says which of the two it is.
//   - THE LOG DISTINGUISHES three cases: never asked, asked and allowed, asked and
//     refused. An empty log is captioned rather than left blank, because a blank list
//     reads as "nothing was refused" when it may mean "nothing ever asked".

let root = null;

const REASONS = {
  no_limits_set: 'No ceilings set — the guard fails closed',
  over_transaction_ceiling: 'Over the per-transaction ceiling',
  over_monthly_ceiling: 'Over the monthly ceiling',
  payee_not_allowed: 'Payee is not on the allowlist',
  no_payee: 'No payee given',
  invalid_amount: 'Amount was not a valid figure',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const gbp = (p) => `£${((p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header">
      <h1>Safety</h1>
      <div class="badge"><span class="badge-icon">⛔</span><span id="sfBadge">—</span></div>
    </div>

    <section class="card" id="sfStateCard">
      <div id="sfState"></div>
    </section>

    <div class="sf-split">
      <section class="card">
        <h2 class="sf-h2">Ceilings</h2>
        <p class="sf-note">Both must be set before anything can pass. The per-transaction
          ceiling cannot exceed the monthly one.</p>
        <form class="sf-form" id="sfLimits">
          <label class="sf-label">Per transaction
            <input id="sfTxn" class="sf-in" type="number" step="0.01" min="0" placeholder="£">
          </label>
          <label class="sf-label">Per month
            <input id="sfMonth" class="sf-in" type="number" step="0.01" min="0" placeholder="£">
          </label>
          <button class="btn primary" type="submit">Set ceilings</button>
        </form>
        <div id="sfLimitState"></div>
      </section>

      <section class="card">
        <h2 class="sf-h2">Who may be paid</h2>
        <p class="sf-note">An empty allowlist refuses everyone. Names are matched
          case-insensitively with whitespace collapsed.</p>
        <form class="sf-form sf-form-row" id="sfPayeeAdd">
          <input id="sfPayee" class="sf-in" placeholder="Name of the payee" required>
          <button class="btn primary" type="submit">Add</button>
        </form>
        <div id="sfPayees"></div>
      </section>
    </div>

    <section class="card">
      <h2 class="sf-h2">Every decision, allowed or refused</h2>
      <div id="sfLog"></div>
    </section>
  </div>
`;

async function api(path, opts) {
  const r = await fetch(`/api/safety${path}`, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function renderState(d) {
  const el = root.querySelector('#sfState');
  root.querySelector('#sfBadge').textContent = d.configured ? 'armed' : 'fails closed';

  if (!d.configured) {
    el.innerHTML = `
      <p class="sf-banner"><b>Nothing can pass this guard.</b> Neither ceiling is set, so
        every request is refused. That is the intended state for a guard nobody has
        configured — zero is the absence of permission, not a budget of nothing.</p>
      <p class="sf-note">Set both ceilings and add at least one payee to arm it. Until then
        the refusal reason will read <em>${esc(REASONS.no_limits_set)}</em>.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="sf-stats">
      <div class="stat-block"><span class="stat-value">${gbp(d.limits.per_transaction_pence.pence)}</span><span class="stat-label">per transaction</span></div>
      <div class="stat-block"><span class="stat-value">${gbp(d.limits.per_month_pence.pence)}</span><span class="stat-label">per month</span></div>
      <div class="stat-block"><span class="stat-value">${gbp(d.authorisedThisMonthPence)}</span><span class="stat-label">authorised in ${esc(d.month)}</span></div>
      <div class="stat-block"><span class="stat-value">${d.payees.length}</span><span class="stat-label">allowed ${d.payees.length === 1 ? 'payee' : 'payees'}</span></div>
    </div>
    <p class="sf-note">Authorised is what this system let through, not what you spent —
      finance owns real spending, and a grocery shop must never consume a purchase ceiling.
      There is no override: a refusal is raised by changing the ceiling deliberately, never
      waived at the point it is asked.</p>`;
}

function renderPayees(d) {
  const el = root.querySelector('#sfPayees');
  if (!d.payees.length) {
    el.innerHTML = '<p class="empty-hint">Nobody is allowlisted, so every payee is refused.</p>';
    return;
  }
  el.innerHTML = `<ul class="sf-payees">${d.payees.map((p) => `
    <li><span>${esc(p.name)}</span>
      <button class="sf-del" data-del="${p.id}" title="Remove from the allowlist">×</button></li>`).join('')}</ul>`;

  el.querySelectorAll('.sf-del').forEach((b) => b.addEventListener('click', async () => {
    await api(`/payees/${b.dataset.del}`, { method: 'DELETE' });
    load();
  }));
}

function renderLog(d) {
  const el = root.querySelector('#sfLog');
  if (!d.recent.length) {
    // Captioned, not blank: "nothing refused" and "nothing ever asked" are different.
    el.innerHTML = `<p class="empty-hint">${esc(d.summary)}</p>`;
    return;
  }
  const counts = Object.fromEntries(d.totals.map((t) => [t.outcome, t.n]));
  el.innerHTML = `
    <p class="sf-note">${counts.allowed || 0} allowed · ${counts.refused || 0} refused</p>
    <ul class="sf-log">${d.recent.map((r) => `
      <li class="sf-log-${esc(r.outcome)}">
        <span class="sf-log-top">
          <span class="sf-log-out">${esc(r.outcome)}</span>
          <span class="sf-log-amt">${r.amount_pence == null ? '—' : gbp(r.amount_pence)}</span>
        </span>
        <span class="sf-log-what">${esc(r.action || 'no action given')}${r.payee ? ` · ${esc(r.payee)}` : ''}</span>
        ${r.reasons.length ? `<span class="sf-log-why">${r.reasons.map((x) => esc(REASONS[x] || x)).join(' · ')}</span>` : ''}
        <span class="sf-log-at">${esc(r.at)}${r.asked_by ? ` · asked by ${esc(r.asked_by)}` : ''}</span>
      </li>`).join('')}</ul>`;
}

async function load() {
  let d;
  try {
    d = await api('/');
  } catch (err) {
    root.querySelector('#sfState').innerHTML = `<p class="sf-banner">Could not read the guard: ${esc(err.message)}</p>`;
    return;
  }
  renderState(d);
  renderPayees(d);
  renderLog(d);

  const ls = root.querySelector('#sfLimitState');
  ls.innerHTML = `<p class="sf-note sf-dim">Per transaction ${gbp(d.limits.per_transaction_pence.pence)}
    (${esc(d.limits.per_transaction_pence.setBy)}) · per month ${gbp(d.limits.per_month_pence.pence)}
    (${esc(d.limits.per_month_pence.setBy)})</p>`;
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;

    el.querySelector('#sfLimits').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const t = el.querySelector('#sfTxn').value;
      const m = el.querySelector('#sfMonth').value;
      if (t === '' && m === '') return;
      try {
        await api('/limits', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            perTransaction: t === '' ? null : Number(t),
            perMonth: m === '' ? null : Number(m),
          }),
        });
        el.querySelector('#sfTxn').value = '';
        el.querySelector('#sfMonth').value = '';
        load();
      } catch (err) {
        el.querySelector('#sfLimitState').innerHTML = `<p class="sf-banner">${esc(err.message)}</p>`;
      }
    });

    el.querySelector('#sfPayeeAdd').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = el.querySelector('#sfPayee').value.trim();
      if (!name) return;
      try {
        await api('/payees', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        el.querySelector('#sfPayee').value = '';
        load();
      } catch (err) {
        root.querySelector('#sfPayees').innerHTML = `<p class="sf-banner">${esc(err.message)}</p>`;
      }
    });

    load();
  },
  unmount() { root = null; },
};
