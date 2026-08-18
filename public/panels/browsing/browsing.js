// Browsing — where attention goes. Reads only /api/browsing.
//
// Domains and counts. No URLs and no page titles exist in the store, so none can be shown
// here even by accident — see the migration note in server/routes/browsing.js.
//
// It does not judge what is on the list. There is no "wasted time" figure and there will
// not be one: that would be a weighting I invented, presented back as a measurement.

let root = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const gbp = (p) => `£${((p || 0) / 100).toFixed(2)}`;

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Browsing</h1>
      <div class="badge"><span class="badge-icon">◷</span><span id="brWindow">—</span></div>
    </div>
    <section class="card" id="brTop"></section>
    <section class="card" id="brCross"></section>
  </div>
`;

async function load() {
  let d;
  try {
    const r = await fetch('/api/browsing');
    d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    root.querySelector('#brTop').innerHTML = `<p class="empty-hint">Could not read browsing: ${esc(err.message)}</p>`;
    return;
  }

  if (d.state === 'empty') {
    // Nothing imported and nothing browsed must not read the same.
    root.querySelector('#brTop').innerHTML = `<p class="empty-hint">${esc(d.message)}<br><small>${esc(d.note)}</small></p>`;
    root.querySelector('#brCross').innerHTML = '';
    return;
  }

  root.querySelector('#brWindow').textContent = `${d.window.domains} domains`;

  const max = Math.max(...d.top.map((t) => t.visits), 1);
  root.querySelector('#brTop').innerHTML = `
    <h2 class="br-h2">Where the visits went</h2>
    <p class="br-note">${esc(d.window.from)} to ${esc(d.window.to)} · ${d.window.visits.toLocaleString('en-GB')} visits
      across ${d.window.domains} domains.</p>
    <p class="br-note br-dim">${esc(d.windowNote)}</p>
    <ul class="br-list">
      ${d.top.map((t) => `
        <li>
          <span class="br-bar" style="width:${Math.max(2, (t.visits / max) * 100)}%"></span>
          <span class="br-name">${esc(t.domain)}</span>
          <span class="br-n">${t.visits.toLocaleString('en-GB')} visits · ${t.pages} pages</span>
        </li>`).join('')}
    </ul>
    <p class="br-note br-dim">${esc(d.privacy)}</p>`;

  root.querySelector('#brCross').innerHTML = `
    <h2 class="br-h2">Paid for, but not visited</h2>
    ${d.paidNotVisited.length ? `
      <ul class="br-cross">
        ${d.paidNotVisited.map((s) => `
          <li><span class="br-name">${esc(s.name)}</span>
            <span class="br-n">${esc(s.status)} · last charge ${esc(s.lastOn)} · ${gbp(s.totalPence)} in total</span></li>`).join('')}
      </ul>`
    : '<p class="empty-hint">Every recurring service matched a domain you visited.</p>'}
    <p class="br-note br-dim">${esc(d.matchNote)}</p>`;
}

export default {
  mount(el) { root = el; el.innerHTML = TEMPLATE; load(); },
  unmount() { root = null; },
};
