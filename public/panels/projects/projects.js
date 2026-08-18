// PROJECTS — every project, its state, and a way into the control centres that exist.
//
// Reads only /api/projects. The route derives git state; this file renders it and adds
// nothing of its own. Deliberately NOT a bookmarks page: the question it answers that a
// list of links cannot is "which of these has drifted", so the commit age and the
// uncommitted count are the point and the link is the convenience.
//
// ---------------------------------------------------------------------------------------
// BACKLOG #M19 — the control centres open HERE, in a frame, instead of leaving the page.
//
// The item said to check before building, because the served pages set their own styles
// and might assume a full window. Measured on 18 Aug 2026 by loading each one in a real
// iframe and reading document.scrollingElement.scrollWidth against the frame's clientWidth.
// There are exactly three URLs the pane offers:
//
// The finding is PER-WIDTH, not per-target: all three embed cleanly at desktop widths, and
// at phone width PrintProfit's <table> breaks out of the frame while the other two are close
// to the edge. That is why the fit line under each frame is MEASURED LIVE on every load and
// every resize.
//
// THE FIGURES THAT USED TO BE HERE ARE GONE, and their removal is the point. This comment
// carried a stamped 3x3 table of overflow amounts and, in the same breath, argued that
// stamping figures was the wrong thing to do. Re-measured on 18 Aug the stamped numbers were
// already wrong in the FLATTERING direction — every one understated the overflow, and the
// Garage's stamped "0px over" was a false negative reading as "fits" when it does not. They
// are claims about three pages that other sessions edit, and nothing re-derives them.
// The live read under each frame is the only figure here that can be trusted, so it is now
// the only one offered.
//
// The check distinguishes four states deliberately, because "fine", "broken", "could not
// look" and "never arrived" are four different facts:
//   fits      loaded, readable, scrollWidth <= clientWidth
//   overflows loaded, readable, scrollWidth  > clientWidth   -> says by how much
//   opaque    loaded, contentDocument unreadable (another origin, or framing refused)
//   failed    no load event inside the timeout
//
// The probe was proven able to fail before any of this was believed: a synthetic 2000px
// bar in a 671px frame reported 1329px of overflow and named div.fatbar, and the same
// /garage/ URL read `opaque` under a sandbox without allow-same-origin and `loaded` with it.
//
// WHAT THIS MEASUREMENT DOES NOT COVER, stated because a clean result hides its exclusions:
//   - 8 of the 11 projects have no URL at all (href: null). Nothing here applies to them.
//   - It keys on DOCUMENT-level horizontal overflow only. It cannot see clipped text, a
//     canvas sized to the wrong viewport, or an element overflowing a scroll container
//     inside the page. Those pages can be wrong in ways this reports as "fits".
//   - It is a measurement of today's build of three pages that other sessions edit.
//
// The new-tab link is KEPT on every project, next to the frame toggle. Framing is the
// convenience; the tab is the escape, and it is never the thing that gets removed.
// ---------------------------------------------------------------------------------------

const TEMPLATE = `
  <div class="panel panel-wide prj-panel">
    <div class="panel-header">
      <h1>Projects</h1>
      <div class="badge"><span class="badge-icon">▤</span><span id="prjCount">—</span></div>
    </div>

    <section class="card">
      <p class="prj-lede">Control centres open inside this page. The line under each frame is
        read from that frame every time it loads or the window resizes — so if a page stops
        fitting, it says so here rather than quietly rendering badly.</p>
      <div id="prjList"></div>
    </section>

    <section class="card">
      <h2 class="prj-h2">What this serves, and what it refuses</h2>
      <div id="prjSafety"></div>
    </section>
  </div>
`;

// Withheld from this list, and each omission is the point: allow-top-navigation is absent,
// so a framed page cannot navigate the whole dashboard away. Verified rather than assumed —
// top.location.href from inside this exact sandbox threw SecurityError and the shell stayed
// on #projects. allow-same-origin is present because these are first-party pages whose own
// scripts must run, and because the fit check needs to read the document; with it, this is
// containment against an accidental escape, NOT a security boundary against hostile content.
const SANDBOX = 'allow-same-origin allow-scripts allow-forms allow-popups';

const LOAD_TIMEOUT_MS = 15000;

let root = null;
let openId = null;          // only one frame at a time — a page of live iframes is not a page
let onResize = null;

// Bumped by every mount AND every unmount. The obvious guard — remember the element and
// check it is still the one in `root` — CANNOT WORK here and passed a twelve-case test
// while being wrong: shell.js reuses the single #panelRoot node for every panel, so the
// element is identical before and after a remount and the comparison is always false.
// A counter has no such blind spot: it is the panel's identity, not its container's.
let generation = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(p) {
  const r = await fetch(`/api/projects${p}`, { headers: { 'x-mc-by': 'you' } });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
  return b;
}

// "2 minutes ago" vs "9 days ago" — git's own wording, kept rather than reformatted so the
// figure cannot drift from what `git log` would tell you at a prompt.
function gitCell(g) {
  if (g === null) return '<span class="prj-dim">not a git repo</span>';
  if (g.error) return `<span class="prj-warn">${esc(g.error)}</span>`;
  const dirty = g.uncommitted === null
    ? '<span class="prj-warn">uncommitted count unreadable</span>'
    : g.uncommitted > 0
      ? `<span class="prj-dirty">${g.uncommitted} uncommitted</span>`
      : '<span class="prj-clean">clean</span>';
  return `<span class="prj-git">${esc(g.hash)} · ${esc(g.ago)}</span> · ${dirty}
          <span class="prj-subject">${esc(g.subject)}</span>`;
}

// The frame fills what is left of the window. The height is DERIVED — window height less
// where the frame starts, less the shell's own bottom padding read off the sheet rather
// than retyped — so it cannot drift from .content. The floor lives in the stylesheet as
// min-height: it stops a scrolled frame collapsing to nothing, and it is a lower bound on
// a container, not a threshold anything is judged against.
function sizeFrame(f) {
  const content = document.querySelector('.content');
  const gap = content ? parseFloat(getComputedStyle(content).paddingBottom) || 0 : 0;
  const top = f.getBoundingClientRect().top;
  f.style.height = `${Math.round(Math.max(0, window.innerHeight - top - gap))}px`;
}

// Four outcomes, rendered four ways. `fits` is muted and `overflows`/`opaque`/`failed` take
// the accent, which is the convention already set by .prj-dirty: the eye lands on the thing
// that needs you, never on the thing that is fine.
function reportFit(f, out) {
  let doc = null;
  try { doc = f.contentDocument; } catch { doc = null; }

  if (!doc) {
    out.dataset.state = 'opaque';
    out.textContent = 'Could not measure this frame — it is on another origin, or it refused '
      + 'to be framed. That is a failure to look, not a report that the page is fine. Use the new tab.';
    return;
  }

  const se = doc.scrollingElement || doc.documentElement;
  const over = se.scrollWidth - se.clientWidth;

  if (over > 0) {
    // Name what overflows. "It is too wide" is unactionable; "a <table> is 315px in a 277px
    // frame" tells you which element and whether it is worth chasing.
    let worst = null;
    for (const el of doc.querySelectorAll('*')) {
      const w = el.getBoundingClientRect().width;
      if (w > se.clientWidth + 1 && (!worst || w > worst.w)) worst = { tag: el.tagName.toLowerCase(), w: Math.round(w) };
    }
    out.dataset.state = 'overflows';
    out.textContent = `Overflows this frame by ${over}px (content ${se.scrollWidth}px in ${se.clientWidth}px`
      + `${worst ? `, widest is <${worst.tag}> at ${worst.w}px` : ''}). It scrolls sideways inside the frame `
      + 'rather than pushing the dashboard about — but it reads better in a tab.';
    return;
  }

  out.dataset.state = 'fits';
  out.textContent = `Fits: no horizontal overflow at ${se.clientWidth}px, measured in this frame just now.`;
}

function closeEmbed() {
  if (!root || !openId) return;
  const box = root.querySelector(`#prj-emb-${CSS.escape(openId)}`);
  const btn = root.querySelector(`.prj-toggle[data-id="${CSS.escape(openId)}"]`);
  if (box) { box.innerHTML = ''; box.hidden = true; }        // drop the iframe, not just hide it
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Open here'; }
  openId = null;
}

function openEmbed(id, href, name, row) {
  closeEmbed();
  openId = id;

  const box = root.querySelector(`#prj-emb-${CSS.escape(id)}`);
  const btn = root.querySelector(`.prj-toggle[data-id="${CSS.escape(id)}"]`);
  if (!box) return;
  if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Close'; }

  box.hidden = false;
  box.innerHTML = `
    <div class="prj-frame-bar">
      <code class="prj-frame-url">${esc(href)}</code>
      <button type="button" class="prj-btn prj-reload">Reload frame</button>
      <a class="prj-btn" href="${esc(href)}" target="_blank" rel="noopener">New tab ↗</a>
    </div>
    <iframe class="prj-frame" title="${esc(name)} control centre" sandbox="${SANDBOX}"></iframe>
    <p class="prj-fit" data-state="checking">Loading the frame…</p>`;

  const frame = box.querySelector('.prj-frame');
  const fit = box.querySelector('.prj-fit');

  // A frame that has wandered — the Garage console carries an external link — is recovered
  // by re-pointing it at the entry URL. Where it went cannot be read once it is off-origin,
  // so "go back" is not offerable; "start again" always is.
  box.querySelector('.prj-reload').addEventListener('click', () => {
    fit.dataset.state = 'checking';
    fit.textContent = 'Reloading the frame…';
    frame.src = href;
  });

  const timer = setTimeout(() => {
    if (fit.dataset.state !== 'checking') return;
    fit.dataset.state = 'failed';
    fit.textContent = `No load event in ${LOAD_TIMEOUT_MS / 1000}s. The frame did not arrive — `
      + 'that is different from arriving empty, and different again from arriving broken.';
  }, LOAD_TIMEOUT_MS);

  // Fires again if you navigate inside the frame, so the fit line describes the page that
  // is actually showing rather than the one that was loaded first.
  frame.addEventListener('load', () => {
    clearTimeout(timer);
    sizeFrame(frame);
    reportFit(frame, fit);
  });

  frame.src = href;

  // Put the row at the top before measuring, so the frame gets the window rather than
  // whatever slice was left below the scroll position.
  row.scrollIntoView({ block: 'start' });
  sizeFrame(frame);
}

async function load(gen) {
  // The panel can be unmounted OR remounted while this is still awaiting the API, and
  // /api/projects shells out to `git log` and `git status` for each of eleven directories —
  // measured at 310–460 ms, so the window is enormous by UI standards. Switching tab and
  // back inside half a second is all it takes.
  //
  // A stale load that writes anyway throws on the first missing node and the pane renders
  // NOTHING, with an uncaught rejection as the only trace: an empty panel and a crashed one
  // looking identical is precisely what this project forbids. So a load whose generation has
  // been superseded discards its result instead.
  const el = root;
  const box = el.querySelector('#prjList');
  let d;
  try {
    d = await api('/');
  } catch (err) {
    if (gen !== generation || !root) return;
    box.innerHTML = `<p class="prj-error">Could not read the project list: ${esc(err.message)}
      — that is a failure to look, not a report that you have no projects.</p>`;
    return;
  }
  if (gen !== generation || !root) return;

  el.querySelector('#prjCount').textContent = `${d.projects.length} projects`;

  const byTrack = {};
  for (const p of d.projects) (byTrack[p.track] = byTrack[p.track] || []).push(p);

  box.innerHTML = Object.entries(byTrack).map(([track, list]) => `
    <h3 class="prj-track">${esc(track)}</h3>
    <ul class="prj-list">
      ${list.map((p) => `
        <li class="${p.exists ? '' : 'prj-gone'}" data-row="${esc(p.id)}">
          <div class="prj-top">
            <span class="prj-name">${esc(p.name)}</span>
            ${p.href
    ? `<span class="prj-actions">
         <button type="button" class="prj-btn prj-toggle" data-id="${esc(p.id)}" data-href="${esc(p.href)}"
                 data-name="${esc(p.name)}" aria-expanded="false" aria-controls="prj-emb-${esc(p.id)}">Open here</button>
         <a class="prj-open" href="${esc(p.href)}" target="_blank" rel="noopener">New tab ↗</a>
       </span>`
    : `<span class="prj-none">${esc(p.state)}</span>`}
          </div>
          <div class="prj-meta">${gitCell(p.git)}</div>
          <div class="prj-note">${esc(p.note)}</div>
          ${p.href ? `<div class="prj-embed" id="prj-emb-${esc(p.id)}" hidden></div>` : ''}
        </li>`).join('')}
    </ul>`).join('');

  box.querySelectorAll('.prj-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { id, href, name } = btn.dataset;
      if (openId === id) closeEmbed();
      else openEmbed(id, href, name, btn.closest('li'));
    });
  });

  el.querySelector('#prjSafety').innerHTML = `
    <p class="prj-note">${esc(d.servedFrom)}</p>
    <p class="prj-note">${esc(d.caveat)}</p>
    <p class="prj-note prj-dim">Servable file types: <code>${esc(d.servable)}</code></p>`;
}

export default {
  async mount(el) {
    el.innerHTML = TEMPLATE;
    root = el;

    // Width is the variable that decides whether a page fits, so a resize re-measures as
    // well as re-sizes. Without this the fit line would be a claim about a window that is
    // no longer the one on screen.
    onResize = () => {
      if (!root || !openId) return;
      const frame = root.querySelector('.prj-frame');
      const fit = root.querySelector('.prj-fit');
      if (!frame || !fit) return;
      sizeFrame(frame);
      if (fit.dataset.state === 'fits' || fit.dataset.state === 'overflows') reportFit(frame, fit);
    };
    window.addEventListener('resize', onResize);

    load(++generation);
  },
  unmount() {
    // unmount() is not optional: the resize listener would otherwise keep firing against a
    // dead DOM every time the window moved, for the rest of the session. Bumping the
    // generation here as well as in mount() is what makes an in-flight load discard itself
    // when the panel is left and NOT returned to.
    generation += 1;
    if (onResize) window.removeEventListener('resize', onResize);
    onResize = null;

    // Drop the frame explicitly rather than waiting for the shell to clear the root. An
    // open iframe is a live cross-document context -- it keeps loading, keeps running its
    // own timers, and can still fire load handlers -- so between unmount() and the next
    // mount there was a frame this panel believed it had released. It always did get
    // cleared, so nothing leaked; but unmount() claiming to have released something it had
    // not is what the next change would rely on.
    if (root) root.querySelectorAll('iframe').forEach((f) => { f.src = 'about:blank'; f.remove(); });

    openId = null;
    root = null;
  },
};
