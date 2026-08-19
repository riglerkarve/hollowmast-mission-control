// Exercise — record it in one line, see what you have actually done.
//
// Numbers live here rather than in wellbeing, by the owner's decision on 18 Aug, so that
// wellbeing can stay journal-only: free text, no interval, no due date, nothing that can
// report you as behind.
//
// NOTHING ON THIS PANEL SETS A TARGET, and that is a constraint on the panel as much as on
// the route. No goal field, no progress bar against a number, no streak, no colour meaning
// bad. The per-week row is a bare count of days with anything recorded — a count cannot say
// you fell short, whereas a percentage always implies a denominator someone chose.
let root = null;
let loadToken = 0;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-GB');

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Exercise</h1></div>

    <section class="card">
      <h2 class="ex-h2">Record something</h2>
      <div class="ex-form">
        <input id="exKind" class="ex-in ex-kind" placeholder="what (squats, walk, …)" list="exKinds">
        <datalist id="exKinds"></datalist>
        <input id="exReps" class="ex-in ex-num" type="number" min="0" placeholder="reps">
        <input id="exMins" class="ex-in ex-num" type="number" min="0" placeholder="mins">
        <input id="exNote" class="ex-in ex-note" placeholder="note (optional)">
        <button class="btn primary" id="exAdd">Add</button>
      </div>
      <p class="ex-note" id="exSaid">Reps and minutes are both optional — some things are
        counted, some are timed, and some are just done.</p>
    </section>

    <section class="card" id="exKindsCard"></section>
    <section class="card" id="exRecent"></section>
  </div>`;

function kindsHtml(d) {
  if (!d.kinds.length) return '';
  return `<h2 class="ex-h2">What you have done</h2>
    <p class="ex-note">${n(d.total)} session(s) across ${n(d.daysRecorded)} day(s).</p>
    <ul class="ex-list">${d.kinds.map((k) => {
    const bits = [];
    if (k.reps) bits.push(`${n(k.reps)} reps`);
    if (k.minutes) bits.push(`${n(k.minutes)} min`);
    // "Best" is the largest you have recorded. It is history, not a bar to clear, and
    // nothing anywhere compares today against it.
    const best = [];
    if (k.bestReps) best.push(`${n(k.bestReps)} reps`);
    if (k.bestMinutes) best.push(`${n(k.bestMinutes)} min`);
    return `<li class="ex-row">
        <span class="ex-kindname">${esc(k.kind)}</span>
        <span class="ex-tot">${bits.join(' · ') || '—'}</span>
        <span class="ex-sess">${n(k.sessions)}&times;</span>
        <span class="ex-best">${best.length ? `best ${best.join(' · ')}` : ''}</span>
        <span class="ex-last">last ${esc(k.lastDay)}</span>
      </li>`;
  }).join('')}</ul>`;
}

function weeksHtml(d) {
  if (!d.weeks || d.weeks.length < 2) return '';
  const max = Math.max(...d.weeks.map((w) => w.days), 1);
  return `<h2 class="ex-h2">Days with something recorded</h2>
    <p class="ex-note">Last 12 weeks. A count, not a percentage — there is no denominator
      here because nothing knows what you intended.</p>
    <ul class="ex-weeks">${d.weeks.map((w) => `
      <li class="ex-week" title="${esc(w.week)}: ${w.days} day(s), ${w.sessions} session(s)">
        <span class="ex-wbar" style="height:${Math.round(100 * w.days / max)}%"></span>
        <span class="ex-wn">${w.days}</span>
      </li>`).join('')}</ul>`;
}

async function load() {
  if (!root) return;
  const token = ++loadToken;
  let d;
  try {
    const r = await fetch('/api/exercise', { headers: { 'X-MC-By': 'you' } });
    d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    if (!root || token !== loadToken) return;
    root.querySelector('#exKindsCard').innerHTML =
      `<p class="empty-hint failure-hint">Could not read this: ${esc(err.message)}<br>`
      + '<small>That is a failure to look, not a report that you have done nothing.</small></p>';
    return;
  }
  if (!root || token !== loadToken) return;

  if (d.state === 'empty') {
    root.querySelector('#exKindsCard').innerHTML =
      `<p class="empty-hint">${esc(d.message)}<br><small>${esc(d.note)}</small></p>`;
    root.querySelector('#exRecent').innerHTML = '';
    return;
  }

  root.querySelector('#exKindsCard').innerHTML = kindsHtml(d) + weeksHtml(d);
  root.querySelector('#exKinds').innerHTML =
    d.kinds.map((k) => `<option value="${esc(k.kind)}">`).join('');
  root.querySelector('#exRecent').innerHTML = `
    <h2 class="ex-h2">Recent</h2>
    <ul class="ex-list">${d.recent.map((s) => `
      <li class="ex-row ex-recent-row">
        <span class="ex-day">${esc(s.day)}</span>
        <span class="ex-kindname">${esc(s.kind)}</span>
        <span class="ex-tot">${[s.reps != null ? `${n(s.reps)} reps` : '', s.minutes != null ? `${n(s.minutes)} min` : ''].filter(Boolean).join(' · ') || '—'}</span>
        <span class="ex-rnote">${esc(s.note || '')}</span>
        <button class="ex-del" data-id="${s.id}" title="Remove this entry">&times;</button>
      </li>`).join('')}</ul>
    <p class="ex-note">${esc(d.note)}</p>`;
}

async function onClick(ev) {
  if (!root) return;
  const add = ev.target.closest('#exAdd');
  const del = ev.target.closest('.ex-del');

  if (add) {
    const kind = root.querySelector('#exKind').value.trim();
    const said = root.querySelector('#exSaid');
    if (!kind) { said.textContent = 'Say what it was — anything you like.'; return; }
    const body = {
      kind,
      reps: root.querySelector('#exReps').value,
      minutes: root.querySelector('#exMins').value,
      note: root.querySelector('#exNote').value,
    };
    const r = await fetch('/api/exercise/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-MC-By': 'you' },
      body: JSON.stringify(body),
    });
    if (!root) return;
    if (!r.ok) { said.textContent = 'Could not save that.'; return; }
    ['#exReps', '#exMins', '#exNote'].forEach((s) => { root.querySelector(s).value = ''; });
    said.textContent = 'Recorded.';
    load();
  }

  if (del) {
    await fetch(`/api/exercise/sessions/${del.dataset.id}`, {
      method: 'DELETE', headers: { 'X-MC-By': 'you' },
    });
    if (!root) return;
    load();
  }
}

function onKey(ev) {
  // Enter anywhere in the form adds it, so a whole entry is type-type-Enter without
  // reaching for the mouse. Capture is one gesture or it does not happen.
  if (ev.key === 'Enter' && ev.target.closest && ev.target.closest('.ex-form')) {
    ev.preventDefault();
    root.querySelector('#exAdd').click();
  }
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    load();
  },
  unmount() { loadToken++; root = null; },
};
