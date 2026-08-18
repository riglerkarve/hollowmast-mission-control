// Mail — where it comes from, and how old the unread is.
//
// TWO COUNTS AND NO OPINION. There is deliberately no inbox-zero figure, no streak, no
// target, no "you should unsubscribe", and no colour that means bad. A dashboard that scores
// your inbox has started having views about you, and this one reports what is there.
//
// The unread caveat comes from the ROUTE rather than being written here, so anything else
// that reads /attention carries it too. 93% of this mailbox is unread, which is the clearest
// possible evidence that the flag is not being used to track anything — presenting 64,204 as
// a backlog would be inventing a debt out of an unused label.
let root = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-GB');

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Mail</h1></div>
    <section class="card" id="mlHead"><p class="empty-hint">Reading the mailbox…</p></section>
    <section class="card" id="mlSenders"></section>
    <section class="card" id="mlUnread"></section>
    <section class="card" id="mlLedger"></section>
  </div>`;

// M39. Two directions, kept apart because they mean opposite things. A service that stopped
// charging but is STILL EMAILING may have moved to a different trading name on the statement.
// One that charges with NO MAIL AT ALL has no paper trail to check the charge against.
async function loadLedger() {
  if (!root) return;
  let d;
  try {
    const r = await fetch('/api/mail/vs-ledger', { headers: { 'X-MC-By': 'mail-panel' } });
    d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    if (!root) return;
    root.querySelector('#mlLedger').innerHTML =
      `<p class="empty-hint">Could not compare against the ledger: ${esc(err.message)}<br>`
      + '<small>That is a failure to look, not a report that nothing matched.</small></p>';
    return;
  }
  if (!root) return;
  if (d.state !== 'ok') {
    root.querySelector('#mlLedger').innerHTML = `<p class="empty-hint">${esc(d.message)}</p>`;
    return;
  }

  const row = (x, right) => `<li class="ml-row ml-lrow">
      <span class="ml-addr"><strong>${esc(x.name)}</strong></span>
      <span class="ml-when">last charged ${esc(x.lastOn)}</span>
      <span class="ml-when">${right}</span></li>`;

  root.querySelector('#mlLedger').innerHTML = `
    <h2 class="ml-h2">Mail against the ledger</h2>
    <p class="ml-note">${esc(d.caption)}</p>
    <h3 class="ml-h3">Still emailing after the last charge (${d.talking.length})</h3>
    <ul class="ml-list">${d.talking.map((x) => row(x,
    `mail to ${esc(x.lastMail)} &middot; ${n(x.messages)} from ${esc(x.sender)}`)).join('')}</ul>
    <h3 class="ml-h3">Charged, but nothing in the mailbox matches (${d.silent.length})</h3>
    <ul class="ml-list">${d.silent.map((x) => row(x,
    `${n(x.charges)} charge(s) &middot; no matching sender`)).join('')}</ul>
    <p class="ml-caveat">${esc(d.blindTo)}${d.tooShort.length
    ? ` Dropped as too short to match safely: ${d.tooShort.map(esc).join(', ')}.` : ''}
      Compared ${d.counted} service(s) the ledger reports.</p>`;
}

async function load() {
  if (!root) return;
  let d;
  try {
    const r = await fetch('/api/mail/attention', { headers: { 'X-MC-By': 'mail-panel' } });
    d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    if (!root) return;
    // A failed read and an empty mailbox must not look the same.
    root.querySelector('#mlHead').innerHTML =
      `<p class="empty-hint">Could not read the mail figures: ${esc(err.message)}<br>`
      + '<small>That is a failure to look, not a report that you have no mail.</small></p>';
    return;
  }
  if (!root) return;

  if (d.state === 'empty') {
    root.querySelector('#mlHead').innerHTML = `<p class="empty-hint">${esc(d.message)}</p>`;
    return;
  }

  root.querySelector('#mlHead').innerHTML = `
    <h2 class="ml-h2">${n(d.total)} messages from ${n(d.distinctSenders)} senders</h2>
    <p class="ml-note">Coverage ${d.coverage == null ? 'unknown' : `${d.coverage}%`} of the mailbox
      — every figure below is over that, not over a sample.</p>`;

  root.querySelector('#mlSenders').innerHTML = `
    <h2 class="ml-h2">Where it comes from</h2>
    <p class="ml-note">The top 12 senders are <strong>${d.top12Share}%</strong> of everything you
      have received. ${n(d.distinctSenders)} senders in total.</p>
    <ul class="ml-list">${d.senders.map((s) => `
      <li class="ml-row">
        <span class="ml-addr">${esc(s.addr)}</span>
        <span class="ml-bar"><span class="ml-bar-fill" style="width:${Math.max(2, s.pct * (100 / d.senders[0].pct))}%"></span></span>
        <span class="ml-n">${n(s.n)}</span><span class="ml-pct">${s.pct}%</span>
      </li>`).join('')}</ul>`;

  loadLedger();

  const maxBand = Math.max(...d.ageing.map((b) => b.n), 1);
  root.querySelector('#mlUnread').innerHTML = `
    <h2 class="ml-h2">Unread, by age</h2>
    <ul class="ml-list">${d.ageing.map((b) => `
      <li class="ml-row">
        <span class="ml-addr">${esc(b.band)}</span>
        <span class="ml-bar"><span class="ml-bar-fill" style="width:${Math.max(2, 100 * b.n / maxBand)}%"></span></span>
        <span class="ml-n">${n(b.n)}</span><span class="ml-pct"></span>
      </li>`).join('')}</ul>
    <p class="ml-caveat">${esc(d.unreadCaveat)}</p>`;
}

export default {
  mount(el) { root = el; el.innerHTML = TEMPLATE; load(); },
  unmount() { root = null; },
};
