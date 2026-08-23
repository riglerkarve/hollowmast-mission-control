// servers panel — every local dev server, its state, and a start button where starting
// is a thing that can be done.
//
// The design decision worth knowing: FOUR STATES, FOUR TREATMENTS, and only one of them
// is an alarm. "Nothing to run here" and "should be running and is not" are opposite
// facts, and a panel that paints both red teaches the reader to stop looking at red.
//
//   running       green  · the port answered
//   stopped       amber  · not listening, and a command exists — the only actionable row
//   no-command    grey   · attach-only config, nothing to start, not broken
//   unconfigured  grey   · the project declares no servers at all
//   unreadable    red    · launch.json exists and does not parse — the only real fault
//
// Start is loopback-only at the route. The button is still rendered from a phone and the
// refusal is shown, rather than hiding the control: a disabled button that explains
// itself is more use than a missing one you go looking for.

import { renderLede } from '/panels/lede/lede.js';

const LAMP = {
  running: 'ok', stopped: 'warn', 'no-command': 'idle',
  unconfigured: 'idle', unreadable: 'bad', 'started-but-not-listening': 'warn',
};

function row(s, onStart) {
  const el = document.createElement('div');
  el.className = 'srv-row';
  const startable = s.state === 'stopped';

  el.innerHTML = `
    <span class="srv-lamp srv-${LAMP[s.state] || 'idle'}" title="${s.state}"></span>
    <span class="srv-name">${s.name}${s.config ? ` <span class="srv-cfg">${s.config}</span>` : ''}</span>
    <span class="srv-port">${s.port ? ':' + s.port : '—'}</span>
    <span class="srv-state">${s.state}</span>
    <span class="srv-why">${s.portConflict ? `port also claimed by ${s.portConflict}` : (s.why || '')}</span>
  `;

  const act = document.createElement('span');
  act.className = 'srv-act';
  if (startable) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = 'Start';
    b.onclick = () => onStart(s, b);
    act.appendChild(b);
  } else if (s.command) {
    act.innerHTML = `<code class="srv-cmd">${s.command}</code>`;
  }
  el.appendChild(act);
  return el;
}

let timer = null;

async function build(root) {
  root.innerHTML = '<h2>Servers</h2><div id="srvLede"></div><div id="srvBody">probing…</div>';
  try { await renderLede('servers', root.querySelector('#srvLede')); } catch { /* lede is optional */ }

  const body = root.querySelector('#srvBody');

  async function draw() {
    let d;
    try {
      const r = await fetch('/api/servers');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json();
    } catch (e) {
      // COULD NOT LOOK is not the same as everything being down, and must not render
      // as a wall of red lamps.
      body.innerHTML = `<p class="panel-empty">Could not reach /api/servers (${e.message}).
        <strong>This says nothing about whether the servers are up</strong> — it says this
        panel could not ask. Nothing below is a reading.</p>`;
      return;
    }

    const s = d.summary;
    const head = `
      <p class="panel-lede">
        <strong>${s.running}</strong> running ·
        <strong>${s.stopped}</strong> stopped and startable ·
        ${s.noCommand + s.unconfigured} with nothing to start
        ${s.unreadable ? ` · <strong class="srv-bad">${s.unreadable} unreadable</strong>` : ''}
      </p>
      ${d.conflicts.length ? `<p class="srv-conflict">Port conflict:
        ${d.conflicts.map((c) => `<strong>:${c.port}</strong> claimed by ${c.claimedBy}`).join(' · ')}
        — starting the second will fail to bind, or appear to work because the first is answering.</p>` : ''}
      <p class="panel-note">${d.probe.note}. Start is loopback-only.</p>`;

    body.innerHTML = head;
    const list = document.createElement('div');
    list.className = 'srv-list';

    // Actionable first: a list sorted by name buries the one row you can do something
    // about among twelve you cannot.
    const order = { stopped: 0, unreadable: 1, running: 2, 'no-command': 3, unconfigured: 4 };
    [...d.servers].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9)
                                  || String(a.name).localeCompare(String(b.name)))
      .forEach((x) => list.appendChild(row(x, start)));
    body.appendChild(list);
  }

  async function start(s, btn) {
    btn.disabled = true;
    btn.textContent = 'starting…';
    try {
      const r = await fetch('/api/servers/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: s.project, config: s.config }),
      });
      const j = await r.json();
      if (!r.ok) {
        btn.disabled = false;
        btn.textContent = 'Start';
        // Show the refusal rather than swallowing it — the loopback rule and the
        // already-running case are both things the reader needs to be told.
        alert(`${j.error}\n\n${j.why || ''}`.trim());
        return;
      }
      // Report what the PORT says, never that the spawn returned.
      btn.textContent = j.state === 'running' ? 'started' : 'spawned, not listening';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Start';
      alert('Could not reach the start endpoint: ' + e.message);
      return;
    }
    setTimeout(draw, 800);
  }

  await draw();
  // Cleared in unmount(). A poll left running after the panel is torn down keeps probing
  // eight ports every fifteen seconds forever, and writes into a DOM node that is gone.
  timer = setInterval(draw, 15000);
}

export default {
  mount(el) { build(el); },
  unmount() { if (timer) { clearInterval(timer); timer = null; } },
};
