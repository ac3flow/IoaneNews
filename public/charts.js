// Small SVG/DOM chart builders. They take ready-made strings (already translated, already formatted)
// and never read story text as markup. Colours come from CSS classes (.f1 .f2 ... .col), so light
// and dark themes need no code here.

import { h, svg } from './dom.js';

/** Columns over time, e.g. stories per hour. items: [{ n, label, tip }]. */
export function columnChart(items, { aria, labelEvery = 6 } = {}) {
  const W = 320;
  const H = 150;
  const pl = 6;
  const pr = 6;
  const pt = 24;
  const pb = 22;
  const step = (W - pl - pr) / items.length;
  const bw = Math.max(2, step - 3);
  const max = Math.max(1, ...items.map((i) => i.n));
  const base = H - pb;
  const peak = items.reduce((p, i, idx) => (i.n > (items[p]?.n ?? 0) ? idx : p), 0);
  const y = (n) => pt + (1 - n / max) * (base - pt);

  const kids = [
    svg('path', { class: 'grid', d: `M${pl} ${pt}H${W - pr}M${pl} ${((pt + base) / 2).toFixed(0)}H${W - pr}M${pl} ${base}H${W - pr}` }),
  ];
  items.forEach((it, i) => {
    const x = pl + i * step + (step - bw) / 2;
    const top = it.n > 0 ? y(it.n) : base - 2;
    kids.push(
      svg('rect', { class: `col${it.n === 0 ? ' zero' : i === peak ? ' peak' : ''}`, x: x.toFixed(1), y: top.toFixed(1), width: bw.toFixed(1), height: (base - top).toFixed(1), rx: 2 }, svg('title', {}, it.tip)),
    );
    if (i % labelEvery === 0 || i === items.length - 1) kids.push(svg('text', { x: (x + bw / 2).toFixed(1), y: H - 6, 'text-anchor': 'middle' }, it.label));
  });
  if (items[peak] && items[peak].n > 0) {
    const x = pl + peak * step + step / 2;
    kids.push(svg('text', { class: 'val', x: x.toFixed(1), y: (y(items[peak].n) - 6).toFixed(1), 'text-anchor': 'middle' }, String(items[peak].n)));
  }
  return svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria }, kids);
}

/** Horizontal bars. items: [{ label, value, text }]. `max` fixes the scale (default: the largest value). */
export function hbars(items, { max, firstAccent = true } = {}) {
  const top = max ?? Math.max(1e-9, ...items.map((i) => Math.abs(i.value)));
  return h(
    'div',
    { class: 'bars' },
    items.map((it, n) =>
      h(
        'div',
        { class: 'bar-row' },
        h('span', { text: it.label, title: it.label }),
        h('b', { text: it.text ?? String(it.value) }),
        svg(
          'svg',
          { class: 'bar', viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
          svg('rect', { class: 'trk', width: 100, height: 8 }),
          svg('rect', { class: it.value < 0 ? 'fneg' : n === 0 && firstAccent ? 'f1' : 'f2', width: Math.min(100, (Math.abs(it.value) / top) * 100).toFixed(1), height: 8 }),
        ),
      ),
    ),
  );
}

const FILLS = ['f1', 'f2', 'f3', 'f4', 'f5'];

/** One stacked bar with a legend. items: [{ label, n, text }]. */
export function splitBar(items) {
  const parts = items.slice(0, 5);
  const total = parts.reduce((s, i) => s + i.n, 0) || 1;
  let x = 0;
  const segs = parts.map((it, n) => {
    const w = (it.n / total) * 100;
    const r = svg('rect', { class: FILLS[n], x: x.toFixed(2), width: Math.max(0, w - 0.6).toFixed(2), height: 14 });
    x += w;
    return r;
  });
  return h(
    'div',
    {},
    svg('svg', { class: 'splitbar', viewBox: '0 0 100 14', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, segs),
    h(
      'ul',
      { class: 'legend' },
      parts.map((it, n) => h('li', {}, svg('svg', { viewBox: '0 0 10 10', 'aria-hidden': 'true' }, svg('rect', { class: FILLS[n], width: 10, height: 10 })), h('span', { text: it.label }), h('b', { text: it.text ?? String(it.n) }))),
    ),
  );
}

/** Figure tiles. items: [{ label, value }]. */
export function kpiTiles(items) {
  return h(
    'div',
    { class: 'kpis' },
    items.map((i) => h('div', { class: 'kpi' }, h('p', { class: 'kpi-v', text: i.value }), h('p', { class: 'kpi-l', text: i.label }))),
  );
}

/** Vertical timeline. items: [{ when, who, url }]. */
export function timeline(items) {
  return h(
    'ol',
    { class: 'tl' },
    items.map((i) => h('li', {}, h('b', { text: i.when }), i.url ? h('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: i.who }) : h('span', { text: i.who }))),
  );
}
