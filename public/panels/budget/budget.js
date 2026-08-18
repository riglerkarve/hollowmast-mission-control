// Budget and wishlist. Reads only /api/budget.
//
// The wishlist is the approval gate: nothing here buys anything, and approving means you
// have decided — not that a purchase happened.

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Budget</h1>
      <div class="badge"><span class="badge-icon">◷</span><span id="bgMonth">—</span></div>
    </div>

    <section class="card">
      <div id="bgCoverage"></div>
      <div class="stats-summary" id="bgTotals"></div>
      <div id="bgEmpty"></div>
    </section>

    <div class="bg-split">
      <section class="card">
        <h2 class="bg-h2">Against your own history</h2>
        <div id="bgLines"></div>
      </section>

      <section class="card">
        <h2 class="bg-h2">Wishlist — your approval gate</h2>
        <form class="bg-add" id="bgAdd">
          <input id="bgName" class="bg-in" placeholder="What is it?" required>
          <input id="bgPrice" class="bg-in bg-price" type="number" step="0.01" min="0" placeholder="£">
          <select id="bgScope" class="bg-in bg-scope-sel" aria-label="Personal or business">
            <option value="personal">Personal</option>
            <option value="business">Business</option>
          </select>
          <button class="btn primary" type="submit">Add</button>
        </form>
        <div id="bgWish"></div>
      </section>
    </div>
  </div>
`;

let root = null;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gbp = (p) => `£${(Math.abs(p ?? 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function api(p, opts) {
  const res = await fetch(`/api/budget${p}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

async function loadBudget() {
  let d;
  try { d = await api('/'); } catch (err) {
    root.querySelector('#bgLines').innerHTML = `<p class="bg-error">Could not load the budget: ${esc(err.message)}</p>`;
    return null;
  }

  root.querySelector('#bgMonth').textContent = d.month;

  if (d.state === 'no-budget') {
    root.querySelector('#bgEmpty').innerHTML = `
      <p class="empty-hint">${esc(d.message)}</p>
      <button class="btn primary" id="bgDerive">Build it from my last 12 months</button>`;
    root.querySelector('#bgDerive').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'deriving…';
      await api('/derive', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' }, body: '{"months":12}' });
      load();
    });
    root.querySelector('#bgTotals').innerHTML = '';
    root.querySelector('#bgLines').innerHTML = '';
    return d;
  }
  root.querySelector('#bgEmpty').innerHTML = '';

  // A partial month must never read as a finished one.
  root.querySelector('#bgCoverage').innerHTML = d.coverage.complete ? '' :
    `<p class="bg-warn">${esc(d.coverage.note)}</p>`;

  root.querySelector('#bgTotals').innerHTML = `
    <div class="stat-block"><span class="stat-value">${gbp(d.incomePence)}</span><span class="stat-label">in</span></div>
    <div class="stat-block"><span class="stat-value">${gbp(d.spentPence)}</span><span class="stat-label">spent</span></div>
    <div class="stat-block"><span class="stat-value">${gbp(d.essentialRemainingPence)}</span><span class="stat-label">essentials still due</span></div>
    <div class="stat-block"><span class="stat-value ${d.headroomPence < 0 ? 'bg-neg' : 'bg-pos'}">${d.headroomPence < 0 ? '−' : ''}${gbp(d.headroomPence)}</span><span class="stat-label">uncommitted</span></div>
  `;

  const max = Math.max(...d.lines.map((l) => Math.max(l.budgetPence, l.spentPence)), 1);
  root.querySelector('#bgLines').innerHTML = `
    <p class="bg-note">Each budget is the <b>median</b> of that category over the last 12 complete months —
    a mean would let one expensive month set a target you never hit. Edit any of them; a figure you
    set by hand is never re-derived over.</p>
    <ul class="bg-lines">
      ${d.lines.map((l) => `
        <li class="bg-line${l.overspent ? ' over' : ''}">
          <span class="bg-l-cat">${esc(l.category)}${l.essential ? '<span class="bg-ess">essential</span>' : ''}</span>
          <span class="bg-l-track">
            <span class="bg-l-spent" style="width:${Math.min(100, (l.spentPence / max) * 100)}%"></span>
            <span class="bg-l-budget" style="left:calc(${Math.min(99.5, (l.budgetPence / max) * 100)}% - 1px)"
                  title="budget ${gbp(l.budgetPence)}"></span>
          </span>
          <span class="bg-l-val">${gbp(l.spentPence)} <span class="bg-dim">of</span>
            <input class="bg-l-edit" type="number" step="0.01" min="0"
                   data-cat="${esc(l.category)}" value="${(l.budgetPence / 100).toFixed(2)}"
                   aria-label="Monthly budget for ${esc(l.category)}">
            <span class="bg-l-src bg-l-src-${l.source === 'manual' ? 'manual' : 'derived'}"
                  title="${esc(l.basis || '')}">${l.source === 'manual' ? 'yours' : 'derived'}</span>
          </span>
        </li>`).join('')}
    </ul>
    ${d.unbudgeted.length ? `<p class="bg-note bg-warn-text">Spent with no budget line:
      ${d.unbudgeted.map((u) => `${esc(u.category)} ${gbp(u.spentPence)}`).join(', ')} —
      these are real and are counted in "spent", but nothing is holding them to a limit.</p>` : ''}
    ${thinLines(d.lines)}
    <p class="bg-note bg-dim">The tick on each bar is the budget; the fill is what you have spent.
    Cash withdrawals are excluded throughout — the ledger cannot say what they bought.</p>
  `;

  // The edit the note above has always promised. PUT /lines/:category already existed;
  // nothing in the panel called it, so "edit any of them" was a claim the UI could not keep.
  root.querySelectorAll('.bg-l-edit').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const v = inp.value.trim();
      if (v === '' || Number(v) < 0 || !Number.isFinite(Number(v))) { load(); return; }
      const line = d.lines.find((l) => l.category === inp.dataset.cat);
      try {
        await api(`/lines/${encodeURIComponent(inp.dataset.cat)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          // essential is preserved rather than defaulted: PUT rewrites the whole row, so
          // omitting it would silently clear the flag and quietly change headroom.
          body: JSON.stringify({ monthly: Number(v), essential: !!(line && line.essential) }),
        });
        load();
      } catch (err) {
        root.querySelector('#bgLines').insertAdjacentHTML('afterbegin',
          `<p class="bg-error">Could not save ${esc(inp.dataset.cat)}: ${esc(err.message)}</p>`);
      }
    });
  });

  return d;
}

// A median is only as good as the number of months it had. A category that appeared in 1
// month of 12 has a median of zero, and a £0 budget that does not explain itself reads as
// broken rather than as "you do not normally spend here". The API already carries the
// basis per line; this surfaces the part of it that changes how a figure should be read.
function thinLines(lines) {
  const thin = lines.map((l) => {
    const m = /present in (\d+)/.exec(l.basis || '');
    const of = /median of (\d+)/.exec(l.basis || '');
    if (!m || !of || l.source === 'manual') return null;
    const seen = Number(m[1]);
    const total = Number(of[1]);
    return seen * 2 <= total ? { category: l.category, seen, total } : null;
  }).filter(Boolean);

  if (!thin.length) return '';
  return `<p class="bg-note bg-dim">Derived from a thin history, so read these as
    "not usually spent" rather than as a target:
    ${thin.map((t) => `<b>${esc(t.category)}</b> appeared in ${t.seen} of ${t.total} months`).join(' · ')}.
    Set one by hand and it stops being re-derived.</p>`;
}

// The business/personal split. It shows a SHARE, not a second budget: both scopes are
// judged against the same headroom, because a sole trader has one pot and inventing a
// per-purse headroom would assert a separation that does not legally exist.
//
// The business purse is shown underneath as CONTEXT rather than as a budget. Over the
// last twelve months of the ledger it has taken in less than it spent, so a "business
// headroom" would be a constant zero — a figure that teaches you to ignore the panel.
function scopeSplit(d) {
  const b = d.byScope && d.byScope.business;
  const pers = d.byScope && d.byScope.personal;
  if (!b || !pers) return '';
  if (!b.count) {
    return `<p class="bg-note bg-dim">Every item is marked <b>personal</b>.
      Use <em>Mark business</em> on anything bought for the business — it does not change
      what you can afford, but it separates the two lists and flags what may be an
      allowable expense at self-assessment.</p>`;
  }
  const purse = d.businessPurse || {};
  return `
    <div class="bg-scope-split">
      <span>Personal <b>${gbp(pers.proposedPence)}</b> <i>${pers.proposedCount} waiting</i></span>
      <span>Business <b>${gbp(b.proposedPence)}</b> <i>${b.proposedCount} waiting</i></span>
    </div>
    <p class="bg-note bg-dim">Both are judged against the same headroom — sole trader, one pot.
      The business account itself took in <b>${gbp(purse.incomePence || 0)}</b> and spent
      <b>${gbp(purse.spendPence || 0)}</b> over the last 12 months of the ledger${purse.lastActivity
        ? `, last active ${esc(purse.lastActivity)}` : ''}. That is shown so you can see what the
      business side is doing, not as a second budget to spend against.</p>`;
}

async function loadWishlist() {
  const el = root.querySelector('#bgWish');
  let d;
  try { d = await api('/wishlist'); } catch (err) {
    el.innerHTML = `<p class="bg-error">Could not load the wishlist: ${esc(err.message)}</p>`;
    return;
  }

  if (!d.items.length) { el.innerHTML = '<p class="empty-hint">Nothing on the list.</p>'; return; }

  const group = (st) => d.items.filter((i) => i.status === st);
  const section = (title, items) => !items.length ? '' : `
    <h3 class="bg-h3">${title}</h3>
    <ul class="bg-wish">
      ${items.map((i) => `
        <li>
          <span class="bg-w-top">
            <span class="bg-w-name">${esc(i.name)}<span class="bg-scope bg-scope-${i.scope}">${i.scope === 'business' ? 'business' : 'personal'}</span></span>
            <span class="bg-w-price">${i.price_pence == null ? '—' : gbp(i.price_pence)}</span>
          </span>
          <span class="bg-w-aff ${i.monthsNeeded === 0 ? 'bg-pos' : ''}">${esc(i.affordability)}${i.monthsNeeded > 0 ? ` · about ${i.monthsNeeded} month${i.monthsNeeded === 1 ? '' : 's'} of headroom` : ''}</span>
          ${i.note ? `<span class="bg-w-note">${esc(i.note)}</span>` : ''}
          ${i.status === 'proposed' ? `<div class="bg-prop" id="bgProp${i.id}"></div>` : ''}
          <span class="bg-w-acts">
            ${i.status === 'proposed' ? `
              <button class="btn bg-act bg-why" data-prop="${i.id}">Before you decide</button>
              <button class="btn bg-act" data-id="${i.id}" data-to="approved">Approve</button>
              <button class="btn bg-act" data-id="${i.id}" data-to="declined">Not now</button>` : ''}
            ${i.status === 'approved' ? `<button class="btn bg-act" data-id="${i.id}" data-to="bought">Got it</button>` : ''}
            ${i.status !== 'proposed' ? `<button class="btn bg-act" data-id="${i.id}" data-to="proposed">Back to list</button>` : ''}
            <button class="btn bg-act bg-retag" data-id="${i.id}" data-scope="${i.scope === 'business' ? 'personal' : 'business'}"
              title="What the item is for. Not a decision — it does not approve anything.">Mark ${i.scope === 'business' ? 'personal' : 'business'}</button>
            <button class="bg-del" data-del="${i.id}" title="Remove">×</button>
          </span>
        </li>`).join('')}
    </ul>`;

  // The collective figure, not just the per-item one. Six things each affordable on their
  // own can be double what exists, and only a total shows that.
  const over = !d.allProposedFit && d.proposedPence > 0;
  el.innerHTML = `
    <div class="bg-headroom">
      <span>Uncommitted this month <b>${gbp(d.headroomPence)}</b></span>
      ${d.approvedPence > 0 ? `<span>less approved <b>${gbp(d.approvedPence)}</b></span>
        <span>left <b class="${d.remainingPence < 0 ? 'bg-neg' : 'bg-pos'}">${gbp(d.remainingPence)}</b></span>` : ''}
    </div>
    ${over ? `<p class="bg-warn">Everything still waiting adds up to <b>${gbp(d.proposedPence)}</b>,
      which is <b>${gbp(d.overBy)}</b> more than is left. Each item below may say it fits — they do not all fit together.</p>` : ''}
    ${scopeSplit(d)}
    <p class="bg-note">${esc(d.basis)}</p>
    ${section('Waiting on you', group('proposed'))}
    ${section('Approved — buy when you are ready', group('approved'))}
    ${section('Bought', group('bought'))}
    ${section('Not now', group('declined'))}
    <p class="bg-note bg-dim">Approving records your decision. Nothing here can buy anything.</p>
  `;

  el.querySelectorAll('.bg-act').forEach((b) => b.addEventListener('click', async () => {
    await api(`/wishlist/${b.dataset.id}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ status: b.dataset.to }),
    });
    load();
  }));
  // The proposition. Backlog #28: what you need in front of you before deciding, fetched
  // on demand rather than for every row — it is a per-item question, and pre-loading eight
  // of them would put eight sets of arithmetic on screen that nobody asked for.
  el.querySelectorAll('.bg-why').forEach((b) => b.addEventListener('click', async () => {
    const box = el.querySelector(`#bgProp${b.dataset.prop}`);
    if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; return; }
    box.innerHTML = '<p class="bg-note">…</p>';
    box.dataset.open = '1';
    let p;
    try {
      p = await api(`/wishlist/${b.dataset.prop}/proposition`);
    } catch (err) {
      box.innerHTML = `<p class="bg-error">Could not build the proposition: ${esc(err.message)}</p>`;
      return;
    }

    const fit = p.budgetFit;
    box.innerHTML = `
      <div class="bg-prop-in">
        <div class="bg-prop-row">
          <b>${fit.fitsNow ? 'Fits in what is left' : 'Does not fit this month'}</b>
          <span>${gbp(p.cost.pricePence)} of ${gbp(fit.remainingPence)} remaining${
            fit.fitsNow ? ` · ${gbp(fit.remainingAfterPence)} would be left` : ''}</span>
        </div>
        ${!fit.fitsNow && p.costOfWaiting.months ? `<div class="bg-prop-row">
          <b>Cost of waiting</b>
          <span>${p.costOfWaiting.months} month${p.costOfWaiting.months === 1 ? '' : 's'} of headroom.
            ${esc(p.costOfWaiting.note)}</span></div>` : ''}
        <div class="bg-prop-row">
          <b>${p.displaces.length ? 'Approving this displaces' : 'Displaces nothing'}</b>
          <span>${p.displaces.length
            ? `${p.displaces.map((d) => `${esc(d.name)} (${gbp(d.pricePence)})`).join(', ')} — ${esc(p.displacesNote)}`
            : esc(p.displacesNote)}</span>
        </div>
        <div class="bg-prop-row">
          <b>Automatable</b>
          <span>${esc(p.safety.meaning)}</span>
        </div>
        <p class="bg-note bg-dim">${esc(fit.basis)}</p>
        <p class="bg-note bg-dim">${esc(p.nothingHereBuys)}</p>
      </div>`;
  }));

  el.querySelectorAll('.bg-retag').forEach((b) => b.addEventListener('click', async () => {
    await api(`/wishlist/${b.dataset.id}/scope`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ scope: b.dataset.scope }),
    });
    load();
  }));
  el.querySelectorAll('.bg-del').forEach((b) => b.addEventListener('click', async () => {
    await api(`/wishlist/${b.dataset.del}`, { method: 'DELETE' });
    load();
  }));
}

async function load() { await loadBudget(); await loadWishlist(); }

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    el.querySelector('#bgAdd').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = el.querySelector('#bgName').value.trim();
      const price = el.querySelector('#bgPrice').value;
      if (!name) return;
      await api('/wishlist', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ name, price: price === '' ? null : Number(price), scope: el.querySelector('#bgScope').value }),
      });
      el.querySelector('#bgName').value = '';
      el.querySelector('#bgPrice').value = '';
      load();
    });
    load();
  },
  unmount() { root = null; },
};
