// desktop.js — Stage 1 (t_8513f316). Ground Control desktop-OS shell: data widgets only.
//
// ADDITIVE ONLY. This file is loaded exclusively by /desktop.html and never touches
// shell.js's PANELS registry, mountPanel, or any existing panel file. The old shell
// (index.html + all 75 panels) has nothing to do with anything in this file.
//
// DATA SOURCES: two existing endpoints only, per the plan's Section 1 — no new backend
// work, no second data source built for this route.
//   GET /api/machine          — CPU/RAM/disk/uptime/GPU (same route panels/machine/machine.js polls)
//   GET /api/machine/history  — 20-minute ring, for a trend sparkline
//   GET /api/agents           — per-agent roster + boardSummary (same route panels/agents/agents.js polls)
//
// CPU TEMPERATURE IS NOT SHOWN AS A NUMBER, EVER. machine.js's cpu.tempC is always null
// on this machine and carries cpu.tempWhy explaining the real reason (Windows needs
// elevation for MSAcpi_ThermalZoneTemperature, unimplemented on most laptops even then).
// This widget shows that absence honestly (a dim "n/a" with the reason in its title
// attribute) rather than fabricating a value or silently omitting the row.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pctClass(pct) {
  if (pct == null) return '';
  if (pct >= 90) return 'is-bad';
  if (pct >= 70) return 'is-warn';
  return '';
}

function metricRow(label, valueHtml, cls) {
  return `<div class="dt-metric-row"><span class="dt-metric-label">${esc(label)}</span><span class="dt-metric-value ${cls || ''}">${valueHtml}</span></div>`;
}

function bar(pct, cls) {
  const w = typeof pct === 'number' && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return `<div class="dt-bar ${cls || ''}"><i style="width:${w}%"></i></div>`;
}

// ---------------------------------------------------------------------- machine widget
function renderMachine(d, history) {
  if (d.state === 'sampling') {
    return `<div class="dt-note">${esc(d.note || 'Sampling…')}</div>`;
  }
  if (d.error) {
    return `<div class="dt-note is-down">Could not reach /api/machine: ${esc(d.error)}</div>`;
  }
  const cpu = d.cpu || {};
  const g = d.gpu || {};
  const m = d.memory || {};
  const disk = d.disk || {};
  const diskUsedPct = (disk.available && disk.totalGB) ? ((disk.totalGB - disk.freeGB) / disk.totalGB) * 100 : null;

  let html = '';
  html += metricRow('CPU load', cpu.loadPct != null ? `${cpu.loadPct.toFixed(1)}%` : `<span class="is-absent">n/a</span>`, pctClass(cpu.loadPct));
  html += bar(cpu.loadPct, pctClass(cpu.loadPct));
  // CPU temp: genuinely absent on this machine, shown as such with the real reason —
  // never a fabricated number. See machine.js's own CPU_TEMP_WHY.
  html += metricRow('CPU temp', `<span class="is-absent" title="${esc(cpu.tempWhy || '')}">n/a</span>`, '');
  html += metricRow('Memory', m.usedPct != null ? `${m.usedPct}% (${m.usedMB}/${m.totalMB} MB)` : `<span class="is-absent">n/a</span>`, pctClass(m.usedPct));
  html += bar(m.usedPct, pctClass(m.usedPct));
  html += metricRow('Disk C:', disk.available ? `${diskUsedPct.toFixed(1)}% (${disk.freeGB} GB free)` : `<span class="is-absent">${esc(disk.why || 'n/a')}</span>`, pctClass(diskUsedPct));
  html += bar(diskUsedPct, pctClass(diskUsedPct));
  html += metricRow('GPU', g.available ? `${esc(g.name)} · ${g.utilPct}% · ${g.tempC}°C` : `<span class="is-absent">${esc(g.why || 'n/a')}</span>`, '');
  html += metricRow('Uptime', d.machine ? `${d.machine.uptimeHours} h` : `<span class="is-absent">n/a</span>`, '');

  const samples = (history && history.samples) || [];
  if (samples.length >= 2) {
    const pts = samples.map((s) => s.cpuLoadPct).filter((v) => v != null);
    if (pts.length >= 2) {
      const W = 200, H = 24;
      const path = samples.map((s, i) => {
        const v = s.cpuLoadPct;
        if (v == null) return null;
        const px = (i / (samples.length - 1)) * W;
        const py = H - (Math.max(0, Math.min(100, v)) / 100) * H;
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      }).filter(Boolean).join(' ');
      html += `<div class="dt-note">CPU trend, last ${samples.length} samples</div>`;
      html += `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${path}" fill="none" stroke="var(--dt-accent)" stroke-width="1.5"/></svg>`;
    }
  }
  html += `<div class="dt-note">sampled ${Math.round((d.ageMs || 0) / 1000)}s ago</div>`;
  return html;
}

// ---------------------------------------------------------------------- agents widget
function renderAgents(d) {
  if (d.error) {
    return `<div class="dt-note is-down">Could not reach /api/agents: ${esc(d.error)} (${esc(d.reason || '')})</div>`;
  }
  const bs = d.boardSummary || {};
  const agents = d.agents || [];
  const running = agents.filter((a) => a.status === 'running');
  const idle = agents.filter((a) => a.status === 'idle');
  const other = agents.filter((a) => a.status !== 'running' && a.status !== 'idle');

  let html = '';
  html += metricRow('Running', String(running.length), running.length ? '' : 'is-absent');
  html += metricRow('Idle', String(idle.length), '');
  html += metricRow('Blocked/ready', String(other.length), other.length ? 'is-warn' : '');
  html += metricRow('Done today', String(bs.doneToday ?? 0), '');
  html += metricRow('Done total', String(bs.doneTotal ?? 0), '');
  if (bs.oldestStuck) {
    html += `<div class="dt-note">oldest stuck: ${esc(bs.oldestStuck.title)} (${esc(bs.oldestStuck.elapsedLabel || '')})</div>`;
  }
  if (running.length) {
    html += `<div class="dt-note">active</div>`;
    running.forEach((a) => {
      const title = a.currentTask ? a.currentTask.title : '';
      html += `<div class="dt-agent-row"><span class="dt-agent-name">${esc(a.name)}</span><span class="dt-agent-task" title="${esc(title)}">${esc(title)}</span></div>`;
    });
  }
  return html;
}

// ---------------------------------------------------------------------- mechanism proof
// Stage 1 asks only that opening a panel be PROVEN possible from this route — not styled,
// not redesigned (that is Stage 2). Reuses the panel module the old shell already has;
// does not touch shell.js's PANELS map, just imports one existing module directly.
function wireOverlayDemo(container) {
  const overlay = document.getElementById('dtOverlay');
  const body = document.getElementById('dtOverlayBody');
  const title = document.getElementById('dtOverlayTitle');
  const closeBtn = document.getElementById('dtOverlayClose');

  closeBtn.addEventListener('click', () => {
    overlay.hidden = true;
    body.innerHTML = '';
  });

  const btn = document.createElement('button');
  btn.className = 'dt-open-btn';
  btn.type = 'button';
  btn.textContent = 'Open Machine panel (unstyled proof)';
  btn.addEventListener('click', async () => {
    title.textContent = 'machine (Stage 2 styling not applied — mechanism proof only)';
    overlay.hidden = false;
    body.innerHTML = '<p style="padding:12px;font-family:sans-serif;">Loading…</p>';
    try {
      const mod = await import('/panels/machine/machine.js');
      body.innerHTML = '';
      mod.default.mount(body, {});
    } catch (e) {
      body.innerHTML = `<p style="padding:12px;font-family:sans-serif;color:#b00;">Could not load panel module: ${esc(e.message)}</p>`;
    }
  });
  container.appendChild(btn);
}

// ---------------------------------------------------------------------- shell
function widget(id, titleText) {
  return `<section class="dt-widget"><div class="dt-widget-title">${esc(titleText)}</div><div id="${id}"></div></section>`;
}

async function loadMachine() {
  const el = document.getElementById('dtMachineBody');
  if (!el) return;
  try {
    const [d, h] = await Promise.all([
      fetch('/api/machine').then((r) => r.json()),
      fetch('/api/machine/history').then((r) => r.json()),
    ]);
    el.innerHTML = renderMachine(d, h);
  } catch (e) {
    el.innerHTML = `<div class="dt-note is-down">Could not reach /api/machine: ${esc(e.message)}</div>`;
  }
}

async function loadAgents() {
  const el = document.getElementById('dtAgentsBody');
  if (!el) return;
  try {
    const res = await fetch('/api/agents');
    const d = await res.json();
    if (!res.ok) { el.innerHTML = renderAgents(d); return; }
    el.innerHTML = renderAgents(d);
  } catch (e) {
    el.innerHTML = `<div class="dt-note is-down">Could not reach /api/agents: ${esc(e.message)}</div>`;
  }
}

function tickClock() {
  const el = document.getElementById('dtClock');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function init() {
  const grid = document.getElementById('dtGrid');
  grid.innerHTML = widget('dtMachineBody', 'Host') + widget('dtAgentsBody', 'Company');

  const machineWidget = grid.children[0];
  wireOverlayDemo(machineWidget);

  tickClock();
  setInterval(tickClock, 1000);

  loadMachine();
  loadAgents();
  // Matches the existing panels' own poll cadence (machine.js polls every 5s; agents.js's
  // own cadence is left to that panel — this route just re-fetches at the same 5s rate
  // machine.js already uses, which is the more time-sensitive of the two).
  setInterval(loadMachine, 5000);
  setInterval(loadAgents, 5000);
}

init();
