//
// team — the shift: handovers, decisions, plans, and what the process missed.
//
// Owner instruction, 19 Aug 2026: "The reports should be all displayed in one place, handovers
// displayed too." Until now a handover could only be read through `tools/shift-start.cjs`, and
// a shift report only as a generated file — so the record existed and was not visible.
//
// TWO MODES, ONE IMPLEMENTATION. Mounted from the nav it is the full shift view; mounted from
// Focus with { card: 'steering' } it is only the decisions-waiting-on-you card. That is the
// same contract the backlog uses inside Focus, and for the same reason: a second copy of the
// steering card would be two implementations of one thing, disagreeing the week after.
//
// NOTHING HERE DERIVES ANYTHING. The gaps, the counts and the groupings all come from
// GET /api/team/report, which is the same function `tools/shift-report.cjs` renders its
// markdown from. A panel that recomputed "what the process missed" would agree with the tool
// until one of them was edited, and then disagree without either erroring.
const api = async (p, opts) => {
  const r = await fetch(`/api/team${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you', ...(opts && opts.headers) },
  });
  if (!r.ok) throw new Error(`${p} answered ${r.status}`);
  return r.json();
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hm = (s) => String(s || '').slice(11, 16);
const day = (s) => String(s || '').slice(0, 10);

// Handover prose arrives as markdown fragments. Rendered as escaped text with line breaks
// kept — not parsed. A half-implemented markdown renderer that swallows a `**` is worse than
// plain text, because it silently changes what a session reported.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

let root = null;
let state = null;

// ------------------------------------------------------------------ the steering card
function steeringCardHTML(open) {
  if (!open.length) return '';
  return `<section class="card tm-card">
    <h2>Decisions waiting on you <span class="tm-n">${open.length}</span></h2>
    <p class="tm-lede">From the Team Manager — the only role that may interrupt you.</p>
    ${open.map((q) => `
      <article class="tm-q" data-q="${q.id}">
        <p class="tm-question">${esc(q.question)}</p>
        ${Array.isArray(q.options) && q.options.length ? `<div class="tm-opts">${q.options.map((o) => {
    const label = typeof o === 'string' ? o : o.label;
    const cost = typeof o === 'string' ? null : o.cost;
    const rec = q.recommend && String(q.recommend).toLowerCase().startsWith(String(label).toLowerCase().slice(0, 12));
    return `<button class="tm-opt${rec ? ' tm-rec' : ''}" data-id="${q.id}" data-answer="${esc(label)}">
            <b>${esc(label)}</b>${rec ? '<span class="tm-tag">recommended</span>' : ''}
            ${cost ? `<span class="tm-cost">if this is wrong: ${esc(cost)}</span>` : ''}
          </button>`;
  }).join('')}</div>` : `<div class="tm-free">
            <input class="tm-input" type="text" placeholder="Your answer" aria-label="Your answer">
            <button class="tm-send" data-id="${q.id}">Answer</button></div>`}
        ${q.recommend ? `<p class="tm-why"><b>Manager’s recommendation:</b> ${esc(q.recommend)}</p>` : ''}
        <p class="tm-status" hidden></p>
      </article>`).join('')}
  </section>`;
}

function wireSteering() {
  root.querySelectorAll('.tm-opt').forEach((b) => b.addEventListener('click', () => answer(b.dataset.id, b.dataset.answer)));
  root.querySelectorAll('.tm-send').forEach((b) => b.addEventListener('click', () => {
    const input = b.parentElement.querySelector('.tm-input');
    if (input && input.value.trim()) answer(b.dataset.id, input.value.trim());
  }));
}

async function answer(id, text) {
  const art = root.querySelector(`[data-q="${id}"]`);
  const status = art && art.querySelector('.tm-status');
  if (art) art.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  if (status) { status.hidden = false; status.textContent = 'Recording…'; }
  try {
    await api(`/steering/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer: text }) });
    await load();
  } catch (e) {
    if (art) art.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    if (status) status.textContent = `Not recorded — ${e.message}. Nothing was saved; try again.`;
  }
}

// ----------------------------------------------------------------------- the full view
const FIELDS = [
  ['done', 'Done'],
  ['blocked', 'Blocked'],
  ['candidates', 'Candidates'],
  ['needs_owner', 'For the owner'],
  ['next', 'Next'],
];

function handoverHTML(h) {
  const stated = FIELDS.filter(([k]) => h[k]);
  const missing = ['done', 'blocked', 'next'].filter((k) => !h[k]);
  return `<details class="tm-ho"${h.needs_owner && !h.owner_resolved_at ? ' open' : ''}>
    <summary>
      <span class="tm-ho-who">${esc(h.title)}</span>
      <span class="role">${esc(h.role)}</span>
      ${h.project ? `<span class="tm-ho-proj">${esc(h.project)}</span>` : ''}
      <span class="t">${esc(hm(h.at))}</span>
      ${h.read_at ? '' : '<span class="tm-flag">unread</span>'}
      ${h.needs_owner && !h.owner_resolved_at ? '<span class="tm-flag tm-flag-owner">for you</span>' : ''}
    </summary>
    <div class="tm-ho-body">
      ${stated.map(([k, label]) => `
        <div class="tm-field${k === 'needs_owner' ? ' tm-field-owner' : ''}">
          <h5>${label}</h5><p>${prose(h[k])}</p>
          ${k === 'needs_owner' && h.owner_resolved_at ? `<p class="tm-resolved">Resolved without the owner by ${esc(h.owner_resolved_by)} — ${esc(h.owner_resolved_note)}</p>` : ''}
        </div>`).join('')}
      ${missing.length ? `<p class="tm-notstated">Not stated: ${missing.join(', ')} — which is different from "nothing to report".</p>` : ''}
    </div>
  </details>`;
}

function fullHTML(d) {
  const c = d.counts;
  const answered = d.steering.filter((s) => s.answer);
  const verdicts = d.plans.filter((p) => p.verdict);

  return `<section class="panel tm-panel">
    <div class="tm-head">
      <h1>The shift</h1>
      <select class="tm-shift" aria-label="Which shift">
        ${state.shifts.map((s) => `<option value="${esc(s.shift)}"${s.shift === d.shift ? ' selected' : ''}>${esc(s.shift)}</option>`).join('')}
      </select>
    </div>
    <p class="tm-lede">Every handover, decision and plan for one shift, and what the process
      missed. Nothing on this page is typed — it is read from the module that owns it.</p>

    <div class="tm-figs">
      <div class="tm-fig"><b>${c.handovers}<i>/${c.roster}</i></b><span>handovers</span></div>
      <div class="tm-fig"><b>${c.plans}</b><span>plans</span></div>
      <div class="tm-fig"><b>${c.confirmed}</b><span>confirmed</span></div>
      <div class="tm-fig${c.assignments ? '' : ' tm-zero'}"><b>${c.assignments}</b><span>delegated</span></div>
      <div class="tm-fig"><b>${c.decisions}</b><span>decisions</span></div>
      <div class="tm-fig"><b>${c.steering}</b><span>put to you</span></div>
    </div>

    ${steeringCardHTML(d.steering.filter((s) => !s.answer))}

    <h2 class="tm-h2">Handovers <span class="tm-n">${d.handovers.length}</span></h2>
    ${d.handovers.length
    ? d.handovers.map(handoverHTML).join('')
    : '<p class="tm-empty">No handover was filed for this shift. That is not a quiet shift — it is no report at all, and the two look identical from here.</p>'}

    <h2 class="tm-h2">What the process missed <span class="tm-n">${d.gaps.length}</span></h2>
    ${d.gaps.length ? d.gaps.map((g) => `
      <div class="tm-gap">
        <span class="tm-kind">${esc(g.kind)}</span>
        <div>
          <h4>${esc(g.head)}</h4>
          ${g.names.length ? `<p class="tm-names">${esc(g.names.join(', '))}</p>` : ''}
          ${g.why ? `<p>${esc(g.why)}</p>` : ''}
        </div>
      </div>`).join('')
    : '<p class="tm-clean">Nothing. Every handover read, every plan resolved, every owner-facing item triaged.</p>'}

    <h2 class="tm-h2">Decided <span class="tm-n">${answered.length + d.decisions.length + verdicts.length}</span></h2>
    ${answered.map((s) => `
      <article class="tm-rec tm-rec-owner">
        <h3>${esc(s.question)}</h3>
        <p class="tm-attr"><span class="who">You</span><span class="role">owner</span><span class="t">${esc(hm(s.answered_at))}</span></p>
        <dl><dt>Decided</dt><dd>${esc(s.answer)}</dd>
        <dt>Manager recommended</dt><dd>${esc(s.recommend)}</dd></dl>
      </article>`).join('')}
    ${d.decisions.map((x) => `
      <article class="tm-rec">
        <h3>${esc(x.decision)}</h3>
        <p class="tm-attr"><span class="who">${esc(x.decided_by)}</span>${x.role ? `<span class="role">${esc(x.role)}</span>` : ''}<span class="t">${esc(hm(x.at))}</span></p>
        <dl>
          <dt>Because</dt><dd>${esc(x.because)}</dd>
          ${x.cost_if_wrong ? `<dt>If wrong</dt><dd>${esc(x.cost_if_wrong)}</dd>` : ''}
          ${x.revisit_when ? `<dt>Revisit when</dt><dd>${esc(x.revisit_when)}</dd>` : ''}
          ${x.evidence ? `<dt>Evidence</dt><dd class="mono">${esc(x.evidence)}</dd>` : ''}
        </dl>
      </article>`).join('')}
    ${verdicts.map((p) => `
      <article class="tm-rec">
        <h3>Plan #${p.id} — ${p.confirmed_at ? 'confirmed' : 'returned'}</h3>
        <p class="tm-attr"><span class="who">${esc(p.confirmed_by || 'the manager')}</span><span class="role">manager</span><span class="t">${esc(hm(p.confirmed_at || p.returned_at))}</span></p>
        <dl><dt>Verdict</dt><dd>${esc(p.verdict)}</dd></dl>
      </article>`).join('')}

    <h2 class="tm-h2">Plans <span class="tm-n">${d.plans.length}</span></h2>
    ${d.plans.map((p) => `
      <details class="tm-ho">
        <summary>
          <span class="tm-ho-who">Plan #${p.id}</span>
          <span class="role">${p.confirmed_at ? 'confirmed' : p.returned_at ? 'returned' : 'draft'}</span>
          <span class="t">${esc(hm(p.drafted_at))} by ${esc(p.drafted_by)}</span>
          ${!p.confirmed_at && !p.returned_at ? '<span class="tm-flag">never put to the manager</span>' : ''}
        </summary>
        <div class="tm-ho-body"><div class="tm-field"><p>${prose(p.body)}</p></div></div>
      </details>`).join('') || '<p class="tm-empty">No plan was drafted for this shift.</p>'}
  </section>`;
}

function render() {
  if (!root || !state) return;
  if (state.error) {
    root.innerHTML = `<section class="${state.cardOnly ? 'card tm-card tm-bad' : 'panel tm-panel'}">
      <h2>The shift</h2>
      <p class="tm-alarm">Could not read the team record — ${esc(state.error)}.
      That is a failure to look, not an empty shift.</p></section>`;
    return;
  }
  if (state.cardOnly) {
    // Nothing waiting renders NOTHING inside Focus. A card that says "no questions today"
    // every day is a surface he learns to skip, taking the days with a real question with it.
    root.innerHTML = steeringCardHTML((state.data && state.data.steering.filter((s) => !s.answer)) || []);
    wireSteering();
    return;
  }
  root.innerHTML = fullHTML(state.data);
  wireSteering();
  const sel = root.querySelector('.tm-shift');
  if (sel) sel.addEventListener('change', () => load(sel.value));
}

async function load(shift) {
  try {
    if (!state.cardOnly && !state.shifts.length) state.shifts = (await api('/shifts')).shifts;
    state.data = await api(`/report${shift ? `?shift=${encodeURIComponent(shift)}` : ''}`);
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { cardOnly: !!(opts && opts.card === 'steering'), shifts: [], data: null, error: null };
    load();
  },
  unmount() { root = null; state = null; },
};
