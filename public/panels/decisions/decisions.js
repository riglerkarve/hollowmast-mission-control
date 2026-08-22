//
// decisions — the owner's own decision log (M149) and the decisions whose revisit_when
// date has arrived (M146).
//
// TWO SECTIONS, ONE FETCH.
//   'Revisit now' — every decision whose dated recheck has arrived, highlighted so it
//   cannot be missed. A decision that states what would change it and then never gets
//   looked at again is exactly the failure the field exists to prevent.
//   'Decision log' — every decision, newest first, with who decided, when, why, and what
//   it costs if wrong. The owner's steering answers are in this list too, because a
//   steering answer IS the owner's decision and a log that omits them is not one.
//
// NOTHING HERE DERIVES ANYTHING. The due list comes from the route, which uses the same
// calendar-date check as team.js's dueDecisions(). A panel that recomputed "is this due"
// would agree with the route until one was edited, and then disagree without either
// erroring — the exact failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Handover/decision prose is escaped, not parsed. A half-implemented markdown renderer that
// swallows a `**` is worse than plain text, because it silently changes what was recorded.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

const day = (s) => String(s || '').slice(0, 10);
const time = (s) => String(s || '').slice(11, 16);

let root = null;
let state = null;

function badgeHTML(d) {
  if (!d.due) return '';
  return '<span class="dc-badge">revisit now</span>';
}

function attrHTML(d) {
  const who = d.decidedBy || 'unknown';
  const role = d.role ? `<span class="dc-role">${esc(d.role)}</span>` : '';
  const when = d.decidedAt ? `<span class="dc-when">${esc(day(d.decidedAt))} ${esc(time(d.decidedAt))}</span>` : '';
  const sup = d.superseded ? '<span class="dc-flag dc-flag-sup">superseded</span>' : '';
  return `<p class="dc-attr"><span class="dc-who">${esc(who)}</span>${role}${when}${sup}</p>`;
}

function detailHTML(d) {
  const parts = [];
  if (d.isSteering && d.answer) {
    parts.push(`<div class="dc-field"><h5>You answered</h5><p>${prose(d.answer)}</p></div>`);
    if (d.because) parts.push(`<div class="dc-field"><h5>Manager recommended</h5><p>${prose(d.because)}</p></div>`);
  } else {
    if (d.because) parts.push(`<div class="dc-field"><h5>Because</h5><p>${prose(d.because)}</p></div>`);
    if (d.costIfWrong) parts.push(`<div class="dc-field"><h5>If this is wrong</h5><p>${prose(d.costIfWrong)}</p></div>`);
    if (d.revisitWhen) parts.push(`<div class="dc-field"><h5>Revisit when</h5><p>${prose(d.revisitWhen)}</p></div>`);
    if (d.recheckAt) parts.push(`<div class="dc-field"><h5>Recheck date</h5><p class="dc-mono">${esc(d.recheckAt)}</p></div>`);
    if (d.evidence) parts.push(`<div class="dc-field"><h5>Evidence</h5><p class="dc-mono">${prose(d.evidence)}</p></div>`);
  }
  return parts.join('');
}

function cardHTML(d) {
  const due = d.due ? ' dc-due' : '';
  const steer = d.isSteering ? ' dc-steer' : '';
  return `<article class="dc-card${due}${steer}">
    ${badgeHTML(d)}
    <h3 class="dc-text">${prose(d.text)}</h3>
    ${attrHTML(d)}
    ${detailHTML(d)}
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel dc-panel">
      <h1>Decisions</h1>
      <p class="dc-alarm">Could not read the decision log — ${esc(state.error)}.
      That is a failure to look, not an empty log.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel dc-panel"><h1>Decisions</h1>
      <p class="dc-loading">Reading the log…</p></section>`;
    return;
  }

  const { decisions, revisitable, asOf } = state.data;
  const revisitHTML = revisitable.length
    ? revisitable.map(cardHTML).join('')
    : '<p class="dc-empty">Nothing is due for revisit. A dated recheck that has not arrived yet, or a condition without a date, stays in the log below — not here.</p>';

  const logHTML = decisions.length
    ? decisions.map(cardHTML).join('')
    : '<p class="dc-empty">No decisions recorded yet. A decision that is not written down is a mood, not a call.</p>';

  root.innerHTML = `<section class="panel dc-panel">
    <h1>Decisions</h1>
    <p class="dc-lede">Every decision, newest first, with who decided, when, why, and what it costs
      if wrong. The ones whose dated recheck has arrived are surfaced on top so they are not
      buried in history.</p>

    <h2 class="dc-h2">Revisit now <span class="dc-n">${revisitable.length}</span></h2>
    <p class="dc-asof">As of ${esc(asOf)}.</p>
    ${revisitHTML}

    <h2 class="dc-h2">Decision log <span class="dc-n">${decisions.length}</span></h2>
    ${logHTML}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/decisions')).json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { data: null, error: null };
    render();
    load();
    renderLede('decisions', el);
  },
  unmount() { root = null; state = null; },
};
