//
// phase5 — HOLLOWMAST's Phase 5 commercial decision gate, collected in one place.
//
// M148. NOT a duplicate of launch-readiness: that panel is a fitness-to-ship checklist
// (build file, commits, dev server, open bugs). This panel is the separate, later question —
// once HOLLOWMAST has shipped and been played, should it go commercial? — with the criteria
// as LAUNCH.md actually states them, each labelled measured / pending / qualitative so a
// number that cannot be read yet never quietly reads as zero.
//
// NOTHING HERE DERIVES ANYTHING. Every figure and every met/pending/qualitative label comes
// from the route, which is the only thing that reads LAUNCH.md's criteria, the telemetry
// worker, git, and disk.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

const TYPE_LABEL = { measured: 'Measured', pending: 'Pending', qualitative: 'Owner judgement' };

function iconFor(c) {
  if (c.type === 'measured' && c.met === true) return '<span class="p5-icon p5-met" aria-label="met">&#x2713;</span>';
  if (c.type === 'measured' && c.met === false) return '<span class="p5-icon p5-notmet" aria-label="not met">&#x2717;</span>';
  return '<span class="p5-icon p5-neutral" aria-label="not yet known">&mdash;</span>';
}

// Sort order: measured-and-not-met first (the blockers), then pending, then qualitative,
// then measured-and-met. Within a group, original order is preserved.
function rank(c) {
  if (c.type === 'measured' && c.met === false) return 0;
  if (c.type === 'pending') return 1;
  if (c.type === 'qualitative') return 2;
  if (c.type === 'measured' && c.met === true) return 3;
  return 4;
}
function sortCriteria(criteria) {
  return criteria.slice().sort((a, b) => rank(a) - rank(b));
}

function criterionRow(c) {
  return `<div class="p5-row p5-${esc(c.type)}">
    ${iconFor(c)}
    <div class="p5-body">
      <h3 class="p5-name">${esc(c.name)}</h3>
      <p class="p5-type">${esc(TYPE_LABEL[c.type] || c.type)}</p>
      <p class="p5-detail">${esc(c.detail)}</p>
    </div>
  </div>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel p5-panel">
      <h1>Phase 5</h1>
      <p class="p5-alarm">Could not read the Phase 5 gate — ${esc(state.error)}.
      That is a failure to look, not an empty checklist.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel p5-panel"><h1>Phase 5</h1>
      <p class="p5-loading">Reading the Phase 5 gate…</p></section>`;
    return;
  }

  const d = state.data;
  const criteria = sortCriteria(d.criteria || []);
  const evaluable = !!(d.gate && d.gate.evaluable);

  const statusLabel = evaluable ? 'SAMPLE MET' : 'NOT YET EVALUABLE';
  const statusClass = evaluable ? 'p5-status-ready' : 'p5-status-notready';
  const statusNote = (d.gate && d.gate.note) || '';

  const listHTML = criteria.length
    ? criteria.map(criterionRow).join('')
    : '<p class="p5-empty">No criteria returned. An empty list is not a clean gate — it means the route did not look.</p>';

  root.innerHTML = `<section class="panel p5-panel">
    <h1>Phase 5</h1>
    <p class="p5-lede">HOLLOWMAST's commercial decision gate, from LAUNCH.md — the later, separate
      question of whether to go commercial once the game has shipped and been played. This is not
      the ship-readiness checklist (that's the Launch readiness panel); nothing here computes a
      go/no-go verdict — that decision stays the owner's.</p>

    <div class="p5-banner ${statusClass}">
      <span class="p5-banner-label">${statusLabel}</span>
      <span class="p5-banner-note">${esc(statusNote)}</span>
    </div>

    <h2 class="p5-h2">Criteria <span class="p5-n">${criteria.length}</span></h2>
    ${listHTML}

    ${d.source ? `<p class="p5-source">Source: ${esc(d.source)}</p>` : ''}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/phase5')).json();
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
    renderLede('phase5', el);
  },
  unmount() { root = null; state = null; },
};
