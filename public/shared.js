export function renderBarChart(container, items, opts = {}) {
  const {
    value = (item) => item.count,
    label = () => '',
    tooltip = (item) => String(value(item)),
    isHighlighted = () => false,
  } = opts;

  const maxVal = Math.max(1, ...items.map(value));

  container.innerHTML = '';
  items.forEach((item) => {
    const v = value(item);

    const col = document.createElement('div');
    col.className = 'bar-col' + (isHighlighted(item) ? ' is-today' : '') + (v === 0 ? ' is-zero' : '');

    const track = document.createElement('div');
    track.className = 'bar-track';

    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.height = `${(v / maxVal) * 100}%`;

    const tip = document.createElement('div');
    tip.className = 'bar-tooltip';
    tip.textContent = tooltip(item);
    fill.appendChild(tip);

    track.appendChild(fill);

    const lbl = document.createElement('div');
    lbl.className = 'bar-label';
    lbl.textContent = label(item);

    col.appendChild(track);
    col.appendChild(lbl);
    container.appendChild(col);
  });
}
