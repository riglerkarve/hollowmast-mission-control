//
// board — open bugs and requests across every project, in one place.
//
// Owner instruction, 19 Aug 2026. Work lived in six stores; this reads all of them and owns
// none of them. Each project's own tracker stays the place to WRITE.
//
// The panel's job is to be trustworthy about three things that are easy to blur:
//   - a project with nothing open, versus a project whose tracker could not be read
//   - a status the tracker asserted, versus one this dashboard inferred
//   - the count of things open, versus the count of things held
import { responderHTML, wireResponders } from '/panels/team/respond.js';

const api = async (p, opts) => {
  const r = await fetch(`/api/board${p}`, {
    ...opts,
    headers: { 'x-mc-by': 'you', ...(opts && opts.headers) },
  });
  if (!r.ok) throw new Error(`${p} answered ${r.status}`);
  return r.json();
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = { filter: 'all', data: null, responses: [] };

// Grouped once per render. The responder is the team module's -- one implementation for
// every item the owner can see, rather than a reply box per panel.
function byTarget(list) {
  const m = new Map();
  for (const r of list || []) {
    const k = r.kind + '|' + r.ref;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
let RESP = new Map();

function sourceCard(s) {
  // ABSENCE AND FAILURE MUST NOT LOOK THE SAME. A tracker that could not be read renders as a
  // warning, never as a project with no bugs — the second is good news nobody investigates.
  if (!s.exists) {
    return `<div class="bd-src bd-src-bad">
      <b>${esc(s.id)}</b><span class="bd-src-state">FILE NOT FOUND</span>
      <p>Nothing was read. This is not "no open bugs" — the board is showing whatever it held
         from the last successful read. Expected at <code>${esc(s.file)}</code>.</p></div>`;
  }
  if (!s.lastRun) {
    return `<div class="bd-src bd-src-bad">
      <b>${esc(s.id)}</b><span class="bd-src-state">NEVER READ</span>
      <p>The file is there and has not been imported yet, so this tracker contributes nothing
         to the counts above. Press Re-read.</p></div>`;
  }
  if (!s.lastRun.ok) {
    return `<div class="bd-src bd-src-bad">
      <b>${esc(s.id)}</b><span class="bd-src-state">COULD NOT READ</span>
      <p>${esc(s.lastRun.note || 'no detail recorded')}</p></div>`;
  }
  const r = s.lastRun;
  return `<div class="bd-src">
    <b>${esc(s.id)}</b><span class="bd-src-state bd-ok">read ${esc(String(r.at).slice(0, 16).replace('T', ' '))}</span>
    <p>${esc(r.note || '')}</p>
    ${r.skipped ? `<p class="bd-residue">${r.skipped} entr(ies) the parser could not settle — shown as unknown, never dropped.</p>` : ''}
    ${r.conflicts ? `<p class="bd-residue">${r.conflicts} where the tracker contradicts itself; the more specific field was used and the basis is shown on each row.</p>` : ''}
  </div>`;
}

function itemRow(i) {
  const sev = i.severity ? `<span class="bd-sev bd-${esc(i.severity)}">${esc(i.severity)}</span>` : '';
  // The BASIS is shown on every row, because "the tracker says open" and "nothing said
  // otherwise so we assumed open" are different claims and the board must not merge them.
  const basis = {
    meta: 'the entry’s own status line',
    section: 'the section it is filed under — no status line on the entry',
    record: 'the record’s status field',
    event: 'a later status event in the log',
    none: 'NOTHING SAID — status is unknown',
  }[i.status_basis] || i.status_basis;
  return `<tr>
    <td class="bd-ref">${esc(i.ref)}</td>
    <td>${sev}<span class="bd-kind">${esc(i.kind)}</span></td>
    <td class="bd-title">${esc(i.title)}
      <span class="bd-basis" title="how this status was decided">${esc(basis)}</span></td>
    <td class="bd-proj">${esc(i.project)}</td>
  </tr>
  <tr class="bd-rrow"><td colspan="4">${responderHTML('board', i.ref, i.title, RESP.get('board|' + i.ref))}</td></tr>`;
}

function backlogRow(b) {
  return `<tr>
    <td class="bd-ref">${esc(b.id)}</td>
    <td><span class="bd-sev bd-${esc(b.priority)}">${esc(b.priority)}</span>
        <span class="bd-kind">${esc(b.kind || 'untriaged')}</span></td>
    <td class="bd-title">${esc(b.title)}
      <span class="bd-basis">${esc(b.owner === 'YOU' ? 'waiting on you' : `for ${b.owner}`)}${b.cluster ? ` · ${esc(b.cluster)}` : ''}</span></td>
    <td class="bd-proj">${esc(b.project || '—')}</td>
  </tr>
  <tr class="bd-rrow"><td colspan="4">${responderHTML('todo', b.id, b.title, RESP.get('todo|' + b.id))}</td></tr>`;
}

function render() {
  const d = state.data;
  if (!d) return;

  const f = state.filter;
  const items = f === 'all' || f === 'external' ? d.items
    : d.items.filter((i) => i.project === f);
  const backlog = f === 'all' || f === 'backlog' ? d.backlog
    : d.backlog.filter((b) => (b.project || '(unassigned)') === f);

  const projects = d.projects.map((p) => `
    <button class="bd-tab${state.filter === p.project ? ' on' : ''}" data-f="${esc(p.project)}">
      ${esc(p.project)} <span>${p.bugs + p.requests + p.backlog}</span></button>`).join('');

  root.innerHTML = `
    <section class="panel bd-panel">
      <h1>The board</h1>
      <p class="bd-lede">Everything open, across every project. This reads each project's own
        tracker and <b>never writes to it</b> — those files stay the place to log a bug.</p>

      <div class="bd-heads">
        <div class="bd-head"><b>${d.counts.externalOpen + d.counts.backlogOpen}</b><span>open, all projects</span></div>
        <div class="bd-head"><b>${d.counts.externalOpen}</b><span>from project trackers</span></div>
        <div class="bd-head"><b>${d.counts.backlogOpen}</b><span>from the backlog</span></div>
        <div class="bd-head bd-head-quiet"><b>${d.counts.externalTotal}</b><span>held in total, open or not</span></div>
      </div>

      <div class="bd-tabs">
        <button class="bd-tab${f === 'all' ? ' on' : ''}" data-f="all">Everything</button>
        ${projects}
      </div>

      ${d.backlogError ? `<p class="bd-alarm">THE BACKLOG COULD NOT BE READ — ${esc(d.backlogError)}.
        The figures above are missing it entirely; they are not a smaller backlog.</p>` : ''}

      <h2>From project trackers <span class="bd-n">${items.length}</span></h2>
      ${items.length ? `<table class="bd-table"><tbody>${items.map(itemRow).join('')}</tbody></table>`
    : '<p class="bd-empty">Nothing open in the trackers that were read. The source panel below says which those were.</p>'}

      <h2>From the backlog <span class="bd-n">${backlog.length}</span></h2>
      ${backlog.length ? `<table class="bd-table"><tbody>${backlog.map(backlogRow).join('')}</tbody></table>`
    : '<p class="bd-empty">Nothing open in the backlog for this filter.</p>'}

      <h2>Where this came from</h2>
      <div class="bd-srcs">${d.sources.map(sourceCard).join('')}</div>
      <button class="bd-refresh">Re-read the trackers</button>
    </section>`;

  wireResponders(root, load);
  root.querySelectorAll('.bd-tab').forEach((b) => b.addEventListener('click', () => {
    state.filter = b.dataset.f;
    render();
  }));
  const rb = root.querySelector('.bd-refresh');
  if (rb) {
    rb.addEventListener('click', async () => {
      rb.disabled = true;
      rb.textContent = 'reading…';
      try { await api('/refresh', { method: 'POST' }); await load(); }
      catch (e) { rb.textContent = `could not re-read: ${e.message}`; }
    });
  }
}

async function load() {
  try {
    state.data = await api('/');
    try {
      const r = await fetch('/api/team/responses', { headers: { 'x-mc-by': 'you' } });
      RESP = byTarget(r.ok ? (await r.json()).responses : []);
    } catch {
      // Could not read the replies. The board still renders; the reply boxes just start empty,
      // which is honest — an empty box is "none shown", not "none given".
      RESP = new Map();
    }
    render();
  } catch (e) {
    root.innerHTML = `<section class="panel bd-panel"><h1>The board</h1>
      <p class="bd-alarm">COULD NOT LOAD — ${esc(e.message)}. This is a failure to look, not an
      empty board: do not read it as "nothing open".</p></section>`;
  }
}

export default {
  mount(el) { root = el; state = { filter: 'all', data: null }; load(); },
  unmount() { root = null; state = { filter: 'all', data: null }; },
};
