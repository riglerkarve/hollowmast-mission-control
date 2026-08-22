//
// lede — a utility that other panels call to show a one-line summary at the top.
//
// NOT a nav panel. This module is imported by other panels that want a lede:
//
//   import { fetchLede, renderLede } from '/panels/lede/lede.js';
//
//   // Just get the text:
//   const text = await fetchLede('board');
//
//   // Or render it into a container (inserts <p class="panel-lede"> at the top):
//   await renderLede('board', containerEl);
//
// The lede style: small muted text, one line, sits between the panel header and
// the first card. See lede.css for the styling — it uses shell.css tokens.

/**
 * Fetch the lede for a panel. Returns a Promise<string>.
 * On error, returns a static fallback string so the panel never breaks.
 * @param {string} panelName — the panel slug (board, machine, focus, etc.)
 * @returns {Promise<string>} the lede text
 */
export async function fetchLede(panelName) {
  try {
    const r = await fetch(`/api/lede/${panelName}`, {
      headers: { 'x-mc-by': 'you' },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();
    return data.lede || '';
  } catch (e) {
    // A failed fetch returns empty string — the panel should not break because
    // the lede service is unavailable. renderLede handles empty by not inserting.
    return '';
  }
}

/**
 * Fetch and render the lede into a container element. Inserts a
 * <p class="panel-lede"> at the top of the container, before the first card.
 *
 * If a lede already exists in the container, it is replaced. If the fetch
 * returns empty (error or missing), nothing is inserted.
 *
 * @param {string} panelName — the panel slug
 * @param {HTMLElement} containerEl — the panel's root container element
 * @returns {Promise<void>}
 */
export async function renderLede(panelName, containerEl) {
  if (!containerEl) return;

  const text = await fetchLede(panelName);
  if (!text) return;

  // Remove any existing lede so repeated calls don't stack.
  const existing = containerEl.querySelector(':scope > .panel-lede');
  if (existing) existing.remove();

  const p = document.createElement('p');
  p.className = 'panel-lede';
  p.textContent = text;

  // Insert after the panel header (if one exists), otherwise at the top.
  const header = containerEl.querySelector(':scope > .panel-header');
  if (header && header.nextSibling) {
    header.parentNode.insertBefore(p, header.nextSibling);
  } else if (header) {
    header.parentNode.insertBefore(p, header.nextSibling);
  } else {
    containerEl.insertBefore(p, containerEl.firstChild);
  }
}