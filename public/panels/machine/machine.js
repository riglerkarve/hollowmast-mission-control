// Machine — what this computer is doing right now.
//
// Owner request, 18 Aug 2026: "live analytics, cpu temp, gpu temp and other systems stats".
//
// IT NEEDS NO INPUT, EVER. Every figure is read from the machine, so this is one of the few
// panels that can never fall out of date through neglect — which is the whole test in
// CLAUDE.md's gate. There is nothing here to feed and nothing to remember.
//
// CPU TEMPERATURE IS SHOWN AS UNAVAILABLE, WITH THE REASON, rather than as a zero or a dash.
// Windows will not report it without elevation and most laptops do not implement it even then;
// reading it needs a third-party tool, which is an owner decision. A panel that drew "0°C" or
// left the tile blank would be making a claim about the hardware instead of about itself.
//
// NOTHING HERE IS A SCORE. Load, temperature and memory are shown as measured values against
// their own ceilings, which is arithmetic the reader can check. There is no composite "health"
// number, because it would be built from weights I chose — the one figure nobody can audit.
let root = null;
let timer = null;
let signal = null;   // from the shell, aborted when this panel is torn down
let loadToken = 0;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header">
      <h1>Machine</h1>
      <span class="mc-age" id="mcAge"></span>
    </div>

    <section class="card">
      <div class="mc-grid" id="mcGrid"></div>
    </section>

    <section class="card">
      <h2 class="mc-h2">Last 20 minutes</h2>
      <div class="mc-trend" id="mcTrend"></div>
      <p class="mc-note" id="mcTrendNote"></p>
    </section>

    <section class="card" id="mcNotesCard" hidden>
      <h2 class="mc-h2">What this cannot see</h2>
      <ul class="mc-notes" id="mcNotes"></ul>
    </section>
  </div>
`;

// A meter with its own numbers beside it. `pct` may be null, which draws an empty track and the
// word given in `absent` -- deliberately different from a full-width track at 0%, because
// "nothing to report" and "reporting zero" are different statements.
function meter(label, pct, detail, absent) {
  const known = typeof pct === 'number' && Number.isFinite(pct);
  const w = known ? Math.max(0, Math.min(100, pct)) : 0;
  return `
    <div class="mc-tile${known ? '' : ' is-absent'}">
      <div class="mc-label">${esc(label)}</div>
      <div class="mc-value">${known ? esc(w.toFixed(1)) + '<span class="mc-unit">%</span>' : esc(absent || 'unavailable')}</div>
      <div class="mc-track"><i style="width:${w}%"></i></div>
      <div class="mc-detail">${detail || ''}</div>
    </div>`;
}

function reading(label, value, unit, detail, why) {
  const known = value != null && value !== '';
  return `
    <div class="mc-tile${known ? '' : ' is-absent'}">
      <div class="mc-label">${esc(label)}</div>
      <div class="mc-value">${known ? esc(value) + (unit ? `<span class="mc-unit">${esc(unit)}</span>` : '') : 'unavailable'}</div>
      <div class="mc-detail">${known ? (detail || '') : `<span class="mc-why">${esc(why || '')}</span>`}</div>
    </div>`;
}

function render(d) {
  const grid = root.querySelector('#mcGrid');
  const age = root.querySelector('#mcAge');

  if (d.state === 'sampling') {
    grid.innerHTML = `<p class="mc-note">${esc(d.note || 'Sampling.')}</p>`;
    age.textContent = '';
    return;
  }

  // Age is shown always. A live panel that silently stops updating looks exactly like a machine
  // that stopped changing, and the reader has no way to tell which they are looking at.
  const secs = Math.round((d.ageMs || 0) / 1000);
  age.textContent = `sampled ${secs}s ago, every ${Math.round((d.sampleMs || 5000) / 1000)}s`;
  age.className = 'mc-age' + (secs > (d.sampleMs || 5000) / 1000 * 4 ? ' is-stale' : '');

  const g = d.gpu || {};
  const m = d.memory || {};
  const disk = d.disk || {};
  const cpu = d.cpu || {};
  const diskUsedPct = (disk.available && disk.totalGB)
    ? ((disk.totalGB - disk.freeGB) / disk.totalGB) * 100 : null;

  grid.innerHTML = [
    meter('CPU load', cpu.loadPct, esc(cpu.model || '') + ' · ' + esc(String(cpu.threads || '?')) + ' threads',
      cpu.loadWhy || 'unavailable'),
    reading('CPU temp', null, '', '', cpu.tempWhy),
    reading('GPU temp', g.available ? g.tempC : null, '°C',
      esc(g.name || ''), g.why),
    meter('GPU load', g.available ? g.utilPct : null,
      g.available ? `${esc(String(g.powerW))} W · ${esc(String(g.clockMHz))} MHz` : '', g.why),
    meter('VRAM', (g.available && g.memTotalMiB) ? (g.memUsedMiB / g.memTotalMiB) * 100 : null,
      g.available ? `${esc(String(g.memUsedMiB))} of ${esc(String(g.memTotalMiB))} MiB` : '', g.why),
    meter('Memory', m.usedPct, `${esc(String(m.usedMB))} of ${esc(String(m.totalMB))} MB`, 'unavailable'),
    meter('Disk C:', diskUsedPct,
      disk.available ? `${esc(String(disk.freeGB))} GB free of ${esc(String(disk.totalGB))}` : '', disk.why),
    reading('Uptime', d.machine ? d.machine.uptimeHours : null, ' h',
      esc((d.machine && d.machine.platform) || ''), 'unavailable'),
  ].join('');

  const notes = d.notes || [];
  const card = root.querySelector('#mcNotesCard');
  card.hidden = notes.length === 0;
  root.querySelector('#mcNotes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
}

// A bare sparkline per series. Drawn from the ring the route keeps, and it says how many
// samples it is drawn from -- a two-point line and a twenty-minute line look identical.
function renderTrend(h) {
  const box = root.querySelector('#mcTrend');
  const note = root.querySelector('#mcTrendNote');
  const s = h.samples || [];
  if (s.length < 2) {
    box.innerHTML = '';
    note.textContent = `Not enough samples yet — ${s.length} of the 2 needed. One arrives every ${Math.round((h.sampleMs || 5000) / 1000)}s.`;
    return;
  }
  const series = [
    ['CPU load', 'cpuLoadPct', 100],
    ['GPU temp', 'gpuTempC', 100],
    ['GPU load', 'gpuUtilPct', 100],
    ['Memory', 'memUsedPct', 100],
  ];
  const W = 240, H = 34;
  box.innerHTML = series.map(([label, key, max]) => {
    const pts = s.map((x) => x[key]).filter((v) => v != null);
    if (pts.length < 2) return `<div class="mc-spark is-absent"><span class="mc-label">${esc(label)}</span><span class="mc-why">no readings</span></div>`;
    const path = s.map((x, i) => {
      const v = x[key];
      if (v == null) return null;
      const px = (i / (s.length - 1)) * W;
      const py = H - (Math.max(0, Math.min(max, v)) / max) * H;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    }).filter(Boolean).join(' ');
    const last = pts[pts.length - 1];
    return `
      <div class="mc-spark">
        <span class="mc-label">${esc(label)}</span>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="${path}"/>
        </svg>
        <span class="mc-last">${esc(String(last))}</span>
      </div>`;
  }).join('');
  const mins = Math.round((s.length * (h.sampleMs || 5000)) / 60000 * 10) / 10;
  note.textContent = `${s.length} samples over about ${mins} min, held in memory only and lost when the service restarts.`;
}

async function load() {
  if (!root) return;
  const token = ++loadToken;
  try {
    const [a, b] = await Promise.all([
      fetch('/api/machine', { headers: { 'x-mc-by': 'you' }, signal }).then((r) => r.json()),
      fetch('/api/machine/history', { headers: { 'x-mc-by': 'you' }, signal }).then((r) => r.json()),
    ]);
    if (!root || token !== loadToken) return;
    if (a.error) {
      root.querySelector('#mcGrid').innerHTML = `<p class="mc-note failure-hint">Could not read machine data: ${esc(a.error)}<br><small>That is a failure to look, not a quiet machine.</small></p>`;
      return;
    }
    render(a);
    renderTrend(b);
  } catch (e) {
    // An abort is what a panel switch looks like from in here, not a fault.
    if (e && e.name === 'AbortError') return;
    if (!root || token !== loadToken) return;
    root.querySelector('#mcGrid').innerHTML = `<p class="mc-note failure-hint">Could not reach /api/machine: ${esc(e.message)}<br><small>That is a failure to look, not a quiet machine.</small></p>`;
  }
}

export default {
  mount(el, opts) {
    root = el;
    signal = (opts && opts.signal) || null;
    el.innerHTML = TEMPLATE;
    load();
    // Matches the route's own cadence. Polling faster would only re-read the same sample and
    // show a rising age counter, which reads as a stall.
    timer = setInterval(load, 5000);
  },
  unmount() {
    loadToken++;
    signal = null;
    if (timer) clearInterval(timer);
    timer = null;
    root = null;
  },
};
