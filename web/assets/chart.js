export function lineChart(days, seriesList, width) {
  const W = Math.max(300, Math.min(760, Math.round(width || 640))), H = 180;
  const PAD = { l: 34, r: 10, t: 12, b: 22 };
  const max = Math.max(1, ...seriesList.flatMap(s => s.values));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (i / Math.max(1, days.length - 1)) * iw;
  const y = (v) => PAD.t + ih - (v / max) * ih;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(H));

  const add = (tag, attrs, text) => {
    const el = document.createElementNS(ns, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  for (let g = 0; g <= 2; g++) {
    const v = (max / 2) * g;
    add('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v),
                  stroke: 'rgba(255,255,255,.09)', 'stroke-width': 1 });
    add('text', { x: PAD.l - 8, y: y(v) + 4, 'text-anchor': 'end',
                  fill: 'rgba(255,255,255,.4)', 'font-size': 10 },
        v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v));
  }
  for (const s of seriesList) {
    if (!s.values.some(v => v > 0)) continue;
    add('polyline', { points: s.values.map((v, i) => `${x(i)},${y(v)}`).join(' '), fill: 'none',
                      stroke: s.color, 'stroke-width': 2,
                      'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  }
  add('text', { x: PAD.l, y: H - 4, fill: 'rgba(255,255,255,.4)', 'font-size': 10 },
      new Date(days[0] + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  add('text', { x: W - PAD.r, y: H - 4, 'text-anchor': 'end',
                fill: 'rgba(255,255,255,.4)', 'font-size': 10 }, 'today');

  const wrap = document.createElement('div');
  wrap.appendChild(svg);
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13px;color:var(--muted)';
  legend.innerHTML = seriesList.map(s =>
    `<span style="display:inline-flex;align-items:center;gap:7px">` +
    `<i style="width:10px;height:3px;background:${s.color};display:inline-block"></i>${s.label}</span>`).join('');
  wrap.appendChild(legend);
  return wrap;
}
