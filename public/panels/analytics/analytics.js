// Analytics — what the two published sites are serving, and what has been imported about them.
//
// Two halves, and the top one needs no input ever: the site probes are derived from the live
// URLs and kept, so this panel is useful on the day it ships rather than on the day a token
// arrives. The bottom half is imported and will be empty until an export is fed in — and it
// says so, with what would fill it, rather than drawing an empty chart.
//
// NOTHING IS SUMMED ACROSS SOURCES. Cloudflare counts visits, Search Console counts impressions
// of a result, and the report worker counts game sessions. A combined "audience" figure would be
// a number nobody could check, so each source gets its own row.
//
// A GREEN ROW IS NOT AN AUDIENCE, and the panel says that out loud. Everything above the import
// section measures what the URL serves, not whether anyone asked for it — which is exactly the
// distinction PrintProfit's £0 has been hiding behind all week.
let root = null;
let timer = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header">
      <h1>Analytics</h1>
      <button id="anProbe" class="an-btn" type="button">Check now</button>
    </div>
    <section class="card">
      <h2 class="an-h2">Published sites</h2>
      <div id="anSites" class="an-sites"></div>
      <p class="an-caveat" id="anCaveat"></p>
    </section>
    <section class="card">
      <h2 class="an-h2">Traffic</h2>
      <div id="anTraffic"></div>
    </section>
  </div>
`;

// A sparkline of response time. Its own scale, labelled — a line with no axis is decoration.
function spark(recent) {
  const pts = recent.filter((r) => r.ms != null);
  if (pts.length < 2) return `<span class="an-why">${pts.length} of the 2 readings needed for a trend</span>`;
  const W = 200, H = 26;
  const max = Math.max(...pts.map((r) => r.ms));
  const path = pts.map((r, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - (r.ms / max) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${path}"/></svg>
    <span class="an-scale">peak ${max} ms over ${pts.length} checks</span>`;
}

function site(s) {
  const l = s.latest;
  const cls = s.state === 'ok' ? 'is-ok' : (s.state === 'never probed' ? 'is-unknown' : 'is-attention');
  const detail = l
    ? `${esc(String(l.status ?? 'unreachable'))} · ${esc(String(l.ms))} ms · ${l.bytes != null ? (l.bytes / 1024).toFixed(0) + ' KB' : '—'}`
    : 'no reading yet';
  return `
    <div class="an-site ${cls}">
      <div class="an-row">
        <span class="an-name">${esc(s.name)}</span>
        <span class="an-state">${esc(s.state)}</span>
      </div>
      <a class="an-url" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>
      <div class="an-detail">${detail}</div>
      <div class="an-flags">
        ${l && l.indexable === 1 ? '<span class="an-flag">indexable</span>' : ''}
        ${l && l.indexable === 0 ? '<span class="an-flag is-bad">noindex</span>' : ''}
        ${l && l.indexable == null ? '<span class="an-flag is-unknown">indexability unchecked</span>' : ''}
        <span class="an-flag is-quiet">${esc(String(s.probeCount))} check${s.probeCount === 1 ? '' : 's'} kept</span>
      </div>
      ${l && l.why ? `<div class="an-why">${esc(l.why)}</div>` : ''}
      <div class="an-spark">${spark(s.recent || [])}</div>
    </div>`;
}

function render(d) {
  root.querySelector('#anSites').innerHTML = (d.sites || []).map(site).join('')
    || '<p class="an-why">No project declares a public URL.</p>';
  root.querySelector('#anCaveat').textContent = d.caveat || '';

  const box = root.querySelector('#anTraffic');
  if (d.trafficState !== 'imported') {
    // Absence with its reason and its remedy, never an empty chart.
    box.innerHTML = `<p class="an-empty">Nothing imported yet.</p><p class="an-why">${esc(d.trafficNote || '')}</p>`;
    return;
  }
  box.innerHTML = `
    <table class="an-table">
      <thead><tr><th>Source</th><th>Site</th><th>Days</th><th>Clicks</th><th>Impressions</th><th>Range</th></tr></thead>
      <tbody>
        ${(d.traffic || []).map((t) => `<tr>
          <td>${esc(t.source)}</td><td>${esc(t.project)}</td>
          <td class="num">${esc(String(t.days))}</td>
          <td class="num">${esc(String(t.clicks ?? '—'))}</td>
          <td class="num">${esc(String(t.impressions ?? '—'))}</td>
          <td>${esc(t.from_day)} to ${esc(t.to_day)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="an-why">Grouped by source deliberately: these count different things and are not summed.</p>`;
}

async function load() {
  if (!root) return;
  try {
    const d = await fetch('/api/analytics', { headers: { 'x-mc-by': 'you' } }).then((r) => r.json());
    if (!root) return;                    // unmounted while the fetch was in flight
    if (d.error) { root.querySelector('#anSites').innerHTML = `<p class="an-why">${esc(d.error)}</p>`; return; }
    render(d);
  } catch (e) {
    if (!root) return;
    root.querySelector('#anSites').innerHTML = `<p class="an-why">Could not reach /api/analytics: ${esc(e.message)}</p>`;
  }
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    el.querySelector('#anProbe').addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true; b.textContent = 'Checking…';
      try { await fetch('/api/analytics/probe', { method: 'POST', headers: { 'x-mc-by': 'you' } }); } catch (e) { /* load() reports it */ }
      if (!root) return;
      b.disabled = false; b.textContent = 'Check now';
      load();
    });
    load();
    // Slow on purpose. The route probes every 15 minutes, so polling faster would only re-read
    // the same rows and imply a liveness the data does not have.
    timer = setInterval(load, 60000);
  },
  unmount() {
    if (timer) clearInterval(timer);
    timer = null;
    root = null;
  },
};
