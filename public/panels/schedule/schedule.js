// Schedule. Reads only /api/schedule.
//
// The panel holds no dates of its own. Every "in 4 days", every "overdue by 11", and the
// whole free/busy strip arrived from the server this render, computed from starts_at and
// the server's local today. Nothing here recomputes any of it — a second copy of daysUntil
// living in the browser would drift from the server's without either of them erroring, and
// the first you would know is a passport slot filed on the wrong day.
//
// The one thing this panel exists to put in front of you is OVERDUE: appointments whose day
// went past while they were still 'scheduled'. It is the first card, it is the only card
// that takes the accent colour, and its buttons are the only ones that matter — because a
// slot you did not attend leaves no trace anywhere else.
//
// No priority score, no urgency colouring, no "important" flag. Order is by date.
//
// No notification, no badge that grows, no polling. The panel refreshes when you come back
// to the tab, and once a minute it checks only whether the DATE has rolled over — because
// every relative figure on screen is relative to today, and a panel left open overnight
// would otherwise sit there quietly claiming yesterday.

const KINDS = ['appointment', 'deadline', 'reminder', 'other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Schedule</h1>
      <div class="badge"><span class="badge-icon">◷</span><span id="scBadge">—</span></div>
    </div>

    <section class="card" id="scDecideCard">
      <h2 class="sc-h2">Needs a decision</h2>
      <div id="scOverdue"></div>
    </section>

    <div class="sc-split">
      <section class="card">
        <h2 class="sc-h2">Next 30 days</h2>
        <div id="scAgenda"></div>
      </section>

      <section class="card">
        <h2 class="sc-h2">Add something</h2>
        <form class="sc-add" id="scAdd">
          <input id="scTitle" class="sc-in sc-title" placeholder="What is it?" required>
          <input id="scDate" class="sc-in sc-date" type="date" required>
          <input id="scTime" class="sc-in sc-time" type="time" title="Leave blank for an all-day entry">
          <select id="scKind" class="sc-in sc-kind">
            ${KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}
          </select>
          <input id="scWhere" class="sc-in sc-where" placeholder="Where? (optional)">
          <button class="btn primary" type="submit">Add</button>
        </form>
        <p class="sc-hint">Leave the time blank and it is filed as an all-day entry. Times are
        local wall-clock — 09:15 means 09:15 on the clock, and nothing converts it.</p>
        <p class="sc-echo" id="scEcho"></p>

        <h3 class="sc-h3">The next 14 days</h3>
        <div id="scShape"></div>
      </section>
    </div>
  </div>
`;

let root = null;
let onVisible = null;
let dayTimer = null;
// The server's local today, as of the last successful render. The timer compares against it.
let renderedToday = null;
// Bumped on mount and unmount. Every async handler checks it before touching the DOM, so a
// slow fetch landing after you switch panels writes into nothing rather than a dead tree.
let token = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

// Pure formatting of a string the server already sent. Not a derivation: it reads the
// weekday off the event rather than working one out, so there is nothing here that could
// disagree with the server about what day something is on.
const dayLabel = (iso, weekday) => `${weekday} ${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

async function api(p, opts) {
  const res = await fetch(`/api/schedule${p}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// Lives outside every container that gets re-rendered, so a message survives the reload
// that follows the action which produced it.
function echo(text, kind) {
  const el = root && root.querySelector('#scEcho');
  if (el) { el.textContent = text; el.className = `sc-echo ${kind || ''}`; }
}

// --------------------------------------------------------------------------- one event
function whenLine(e) {
  const at = e.allDay ? 'all day' : e.time + (e.endTime ? `–${e.endTime}` : '');
  const parts = [`${dayLabel(e.day, e.weekday)} · ${at}`];
  if (e.multiDay) parts.push(`runs to ${e.endsOnDay}`);
  if (e.location) parts.push(e.location);
  return parts.join(' · ');
}

// The relative half, straight from the server's numbers. Every branch names a fact; none of
// them names a level of importance.
function relLine(e) {
  if (e.state === 'overdue') return `Was ${plural(e.overdueByDays, 'day')} ago and never marked done, missed or cancelled`;
  if (e.state === 'past') return `${plural(-e.daysUntil, 'day')} ago · ${e.status}`;
  if (e.state === 'today') return e.startTimePassed ? 'Today — start time has passed' : 'Today';
  if (e.daysUntil === 1) return 'Tomorrow';
  return `In ${plural(e.daysUntil, 'day')}`;
}

function actions(e) {
  const b = (to, label, cls) => `<button class="btn sc-act ${cls || ''}" data-id="${e.id}" data-to="${to}">${label}</button>`;
  return `<span class="sc-e-acts">
    ${e.status === 'scheduled'
      ? `${b('done', 'Went')}${b('missed', 'Missed')}${b('cancelled', 'Cancelled')}`
      : b('scheduled', 'Reopen')}
    <button class="sc-del" data-del="${e.id}" title="Delete this entry">×</button>
  </span>`;
}

function eventItem(e, opts) {
  const o = opts || {};
  return `
    <li class="sc-event sc-${e.state.replace(/\s+/g, '-')}${e.resolved ? ' sc-resolved' : ''}">
      <span class="sc-e-main">
        <span class="sc-e-title">
          ${esc(e.title)}
          <span class="sc-tag">${esc(e.kind)}</span>
          ${e.resolved ? `<span class="sc-tag sc-tag-status">${esc(e.status)}</span>` : ''}
        </span>
        <span class="sc-e-when">${o.showDate === false ? esc(whenLine(e).split(' · ').slice(1).join(' · ') || 'all day') : esc(whenLine(e))}</span>
        ${o.showRel === false ? '' : `<span class="sc-e-rel">${esc(relLine(e))}</span>`}
        ${e.leadTimeDays !== null && e.status === 'scheduled' ? `<span class="sc-e-lead">${esc(e.leadTimeNote)}</span>` : ''}
        ${e.note ? `<span class="sc-e-note">${esc(e.note)}</span>` : ''}
      </span>
      ${actions(e)}
    </li>`;
}

// --------------------------------------------------------------------------- overdue
function renderOverdue(d) {
  const el = root.querySelector('#scOverdue');
  const card = root.querySelector('#scDecideCard');

  if (!d.overdue.count) {
    // Absence is SHOWN, not omitted. A card that vanishes when there is nothing overdue is
    // indistinguishable from a card that failed to render, and the reader has no way to
    // tell "nothing has slipped" from "this half did not load".
    card.classList.remove('sc-alarm');
    el.innerHTML = `<p class="sc-quiet">${esc(d.overdue.note)}</p>`;
    return;
  }

  card.classList.add('sc-alarm');
  el.innerHTML = `
    <p class="sc-warn">${esc(d.overdue.note)}</p>
    <ul class="sc-events">${d.overdue.events.map((e) => eventItem(e)).join('')}</ul>
    <p class="sc-hint sc-dim">Saying which it was is the whole point — an entry only stops being
    overdue once you have decided. Nothing here decides for you.</p>
  `;
  wire(el);
}

// --------------------------------------------------------------------------- agenda
function renderAgenda(d) {
  const el = root.querySelector('#scAgenda');

  if (d.state === 'empty') {
    // "There is nothing" is a different sentence from "that did not load", and the two must
    // never look the same on screen.
    el.innerHTML = `<p class="empty-hint">${esc(d.message)}</p>`;
    return;
  }

  const dayHead = (day) => {
    const rel = day.daysUntil === 0 ? 'Today' : day.daysUntil === 1 ? 'Tomorrow' : `in ${plural(day.daysUntil, 'day')}`;
    return `<h3 class="sc-day-head${day.isToday ? ' sc-is-today' : ''}">
      <span class="sc-day-rel">${esc(rel)}</span>
      <span class="sc-dim">${esc(dayLabel(day.date, day.weekday))}</span>
    </h3>`;
  };

  el.innerHTML = `
    ${d.days.length ? d.days.map((day) => `
      ${dayHead(day)}
      <ul class="sc-events">${day.events.map((e) => eventItem(e, { showDate: false, showRel: false })).join('')}</ul>
    `).join('') : `<p class="empty-hint">Nothing in the next ${plural(d.window.days, 'day')}.</p>`}

    ${d.counts.beyondWindowScheduled ? `<p class="sc-hint sc-beyond">
      ${entries(d.counts.beyondWindowScheduled)} sit past this ${plural(d.window.days, 'day')} window
      and are not shown above — the next is ${esc(d.counts.nextBeyondWindow)}.</p>` : ''}

    <p class="sc-hint sc-dim">${esc(d.derived)}</p>
  `;
  wire(el);
}

// --------------------------------------------------------------------------- 14-day shape
function renderShape(d) {
  const el = root.querySelector('#scShape');
  const fb = d.freeBusy;

  // Two states, separated by fill AND by border style — never two tints of one hue, which
  // measured indistinguishable elsewhere in this dashboard. Today is a MARK under the
  // column, not a third shade, so it composes with either state.
  //
  // The weekday initial sits UNDER the cell, not inside it. Inside a filled cell it was
  // measured at 3.41:1 against --long in the dark theme — below AA for 0.6rem text. Under
  // the cell it is --muted on --card: 4.96:1 light, 5.66:1 dark.
  const cell = (s) => `<span class="sc-day-col${s.isToday ? ' sc-d-today' : ''}"
      title="${esc(s.date)} ${esc(s.weekday)} — ${s.free ? 'nothing written down' : entries(s.eventCount)}"
    ><span class="sc-day-cell ${s.free ? 'sc-d-free' : 'sc-d-busy'}"></span><span class="sc-d-wd">${esc(s.weekday[0])}</span></span>`;

  el.innerHTML = `
    <div class="sc-strip">${fb.series.map(cell).join('')}</div>
    <ul class="sc-legend">
      <li><span class="sc-day-cell sc-d-busy"></span> something on</li>
      <li><span class="sc-day-cell sc-d-free"></span> nothing written down</li>
      <li><span class="sc-day-col sc-d-today"><span class="sc-day-cell sc-d-free"></span></span> today</li>
    </ul>
    <ul class="sc-facts">
      <li><b>${fb.freeDays}</b> of the next ${fb.days} days have nothing on them</li>
      <li><b>${fb.busyDays}</b> have something</li>
      ${fb.excluded.cancelled ? `<li><b>${fb.excluded.cancelled}</b> cancelled ${fb.excluded.cancelled === 1 ? 'entry is' : 'entries are'} not counted as busy</li>` : ''}
    </ul>
    <p class="sc-hint sc-dim">${esc(fb.note)}</p>
  `;
}

// --------------------------------------------------------------------------- wiring
function wire(el) {
  el.querySelectorAll('.sc-act').forEach((b) => b.addEventListener('click', async () => {
    const mine = token;
    b.disabled = true;
    let msg;
    try {
      const r = await api(`/events/${b.dataset.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ status: b.dataset.to }),
      });
      msg = [`${r.title}: ${r.statusNote || 'back to scheduled.'}`, 'ok'];
    } catch (err) {
      msg = [`Not changed: ${err.message}`, 'bad'];
    }
    if (mine !== token) return;
    await load();                        // reload first, then speak — otherwise the
    if (mine !== token) return;          // re-render wipes the line it just produced
    echo(msg[0], msg[1]);
  }));

  el.querySelectorAll('.sc-del').forEach((b) => b.addEventListener('click', async () => {
    const mine = token;
    // Deleting is the one irreversible thing this panel can do, and it is not the same act
    // as cancelling — which is why it asks and the status buttons do not.
    if (!window.confirm('Delete this entry outright? Marking it "Cancelled" keeps the record that it existed.')) return;
    let msg;
    try {
      const r = await api(`/events/${b.dataset.del}`, { method: 'DELETE' });
      msg = [`Deleted "${r.title}" (${r.startsAt}). ${r.note}`, 'ok'];
    } catch (err) {
      msg = [`Not deleted: ${err.message}`, 'bad'];
    }
    if (mine !== token) return;
    await load();
    if (mine !== token) return;
    echo(msg[0], msg[1]);
  }));
}

// --------------------------------------------------------------------------- load
async function load() {
  const mine = token;
  let d;
  try {
    d = await api('/');
  } catch (err) {
    if (mine !== token) return;
    // Every region says it failed, in its own words. A silent empty render would claim
    // "nothing overdue" and "nothing coming up" — which is the one lie this panel could
    // tell that you would never think to check.
    root.querySelector('#scBadge').textContent = 'not loaded';
    root.querySelector('#scDecideCard').classList.remove('sc-alarm');
    root.querySelector('#scOverdue').innerHTML = `<p class="sc-error">Could not read the schedule: ${esc(err.message)}<br>
      This is a failed read, not an empty diary — nothing below was computed, and nothing here means "nothing is overdue".</p>`;
    root.querySelector('#scAgenda').innerHTML = `<p class="sc-error">Could not read the schedule: ${esc(err.message)}</p>`;
    root.querySelector('#scShape').innerHTML = `<p class="sc-error">No free/busy shape — the read failed.</p>`;
    return;
  }
  if (mine !== token) return;

  renderedToday = d.today;

  root.querySelector('#scBadge').textContent = d.overdue.count
    ? `${entries(d.overdue.count)} overdue`
    : (d.nextUp ? (d.nextUp.daysUntil === 0 ? 'something today' : `next in ${plural(d.nextUp.daysUntil, 'day')}`)
      : (d.counts.total ? 'nothing coming up' : 'nothing scheduled'));

  const dateField = root.querySelector('#scDate');
  if (!dateField.value) dateField.value = d.today;   // the server's today, not the browser's

  renderOverdue(d);
  renderAgenda(d);
  renderShape(d);
}

export default {
  mount(el) {
    root = el;
    token += 1;
    el.innerHTML = TEMPLATE;

    el.querySelector('#scAdd').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const mine = token;
      const title = el.querySelector('#scTitle').value.trim();
      const date = el.querySelector('#scDate').value;
      const time = el.querySelector('#scTime').value;
      if (!title || !date) return;

      // No time typed means all day, and the server infers exactly the same thing from a
      // date with no time — so the rule lives in one place and this only has to send what
      // was entered.
      const startsAt = time ? `${date}T${time}` : date;
      try {
        const r = await api('/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({
            title,
            startsAt,
            kind: el.querySelector('#scKind').value,
            location: el.querySelector('#scWhere').value.trim() || null,
          }),
        });
        if (mine !== token) return;
        el.querySelector('#scTitle').value = '';
        el.querySelector('#scTime').value = '';
        el.querySelector('#scWhere').value = '';
        await load();
        if (mine !== token) return;
        // The derived value comes straight back: you find out how far away it is at the
        // moment you write it down, which is the only reason typing it is worth doing.
        echo(r.warning || `Added "${r.title}" — ${relLine(r).toLowerCase()}, ${whenLine(r)}.`, r.warning ? 'bad' : 'ok');
      } catch (err) {
        if (mine === token) echo(`Not added: ${err.message}`, 'bad');
      }
    });

    // Refreshes when you come back to the tab. Not polling and not a reminder: it fires only
    // when you are already looking.
    onVisible = () => { if (!document.hidden && root) load(); };
    document.addEventListener('visibilitychange', onVisible);

    // The one timer. Everything on this panel is relative to today, so a panel left open
    // overnight would keep calling an appointment "tomorrow" on the day it happens and would
    // not call a missed one overdue. This compares the BROWSER's date against the SERVER's
    // last-rendered today purely to detect the rollover — the authoritative today is still
    // whatever the server says on the reload it triggers.
    dayTimer = setInterval(() => {
      if (!root || !renderedToday) return;
      const n = new Date();
      const browserToday = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
      if (browserToday !== renderedToday) load();
    }, 60000);

    load();
  },

  // Not optional. The interval would keep firing at a detached DOM every minute for the rest
  // of the session, and the visibility handler would fetch against a panel that no longer
  // exists. Bumping the token also strands anything still in flight.
  unmount() {
    token += 1;
    if (dayTimer) clearInterval(dayTimer);
    if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    dayTimer = null;
    onVisible = null;
    renderedToday = null;
    root = null;
  },
};
