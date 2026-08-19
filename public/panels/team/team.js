//
// team — the decisions waiting on you, answerable in one tap.
//
// Built 19 Aug 2026, first of five expansions and chosen by the owner ahead of the others.
// The reason it went first is the workspace gate rather than size: the Team Manager may
// interrupt him once a day, and on the day that started working his only routes to ANSWER
// were a terminal command or waiting for the next morning's briefing. A structure meant to
// reduce what he does had made replying cost more effort than being asked did.
//
// It lives inside Focus, beside the backlog, for the reason the backlog was moved there:
// "Yours — decisions" is already the thing he opens Focus to see, and a steering question is
// exactly that. It is NOT a team dashboard. It renders open questions and records answers,
// and nothing else — the shift view, the plan and the assignments stay on the CLI until
// there is something derived worth rendering.
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

let root = null;
let state = null;

function optionButtons(q) {
  const opts = Array.isArray(q.options) ? q.options : [];
  if (!opts.length) {
    // A question with no options is still answerable — it just needs typing. Hiding it
    // because it does not fit the card would be the card deciding what he gets asked.
    return `<div class="tm-free">
      <input class="tm-input" type="text" placeholder="Your answer" aria-label="Your answer">
      <button class="tm-send" data-id="${q.id}">Answer</button></div>`;
  }
  return `<div class="tm-opts">${opts.map((o) => {
    const label = typeof o === 'string' ? o : o.label;
    const cost = typeof o === 'string' ? null : o.cost;
    const rec = q.recommend && String(q.recommend).toLowerCase().startsWith(String(label).toLowerCase().slice(0, 12));
    return `<button class="tm-opt${rec ? ' tm-rec' : ''}" data-id="${q.id}" data-answer="${esc(label)}">
        <b>${esc(label)}</b>${rec ? '<span class="tm-tag">recommended</span>' : ''}
        ${cost ? `<span class="tm-cost">if this is wrong: ${esc(cost)}</span>` : ''}
      </button>`;
  }).join('')}</div>`;
}

function render() {
  if (!root) return;

  if (state.error) {
    // COULD NOT LOOK is not "nothing to decide". An empty card on a failed fetch would tell
    // him there is nothing waiting on exactly the morning several things were.
    root.innerHTML = `<section class="card tm-card tm-bad">
      <h2>Decisions waiting on you</h2>
      <p class="tm-alarm">Could not read the steering queue — ${esc(state.error)}.
      That is a failure to look, not an empty queue.</p></section>`;
    return;
  }

  // Nothing waiting renders NOTHING AT ALL. A card that says "no questions today" every day
  // is a surface he learns to skip, and it takes the days with a real question down with it.
  if (!state.open || !state.open.length) { root.innerHTML = ''; return; }

  root.innerHTML = `<section class="card tm-card">
    <h2>Decisions waiting on you <span class="tm-n">${state.open.length}</span></h2>
    <p class="tm-lede">From the Team Manager — the only role that may interrupt you.</p>
    ${state.open.map((q) => `
      <article class="tm-q" data-q="${q.id}">
        <p class="tm-question">${esc(q.question)}</p>
        ${optionButtons(q)}
        ${q.recommend ? `<p class="tm-why"><b>Manager’s recommendation:</b> ${esc(q.recommend)}</p>` : ''}
        <p class="tm-status" hidden></p>
      </article>`).join('')}
  </section>`;

  root.querySelectorAll('.tm-opt').forEach((b) => b.addEventListener('click', () => answer(b.dataset.id, b.dataset.answer, b)));
  root.querySelectorAll('.tm-send').forEach((b) => b.addEventListener('click', () => {
    const input = b.parentElement.querySelector('.tm-input');
    if (input && input.value.trim()) answer(b.dataset.id, input.value.trim(), b);
  }));
}

async function answer(id, text, btn) {
  const art = root.querySelector(`[data-q="${id}"]`);
  const status = art && art.querySelector('.tm-status');
  art.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  if (status) { status.hidden = false; status.textContent = 'Recording…'; }
  try {
    await api(`/steering/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer: text }) });
    // Read back rather than trusting the write, and re-render from the server's answer —
    // a card that removes the question optimistically would show it gone on a failed write.
    await load();
  } catch (e) {
    art.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    if (status) status.textContent = `Not recorded — ${e.message}. Nothing was saved; try again.`;
  }
}

async function load() {
  try {
    const j = await api('/steering');
    state = { open: j.open, error: null };
  } catch (e) {
    state = { open: [], error: e.message };
  }
  render();
}

export default {
  mount(el) { root = el; state = { open: [], error: null }; load(); },
  unmount() { root = null; state = null; },
};
