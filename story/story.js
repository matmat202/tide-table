/* The scrolling story: each <section class="step"> names a layout in data-kind; as the
 * reader scrolls from one step to the next, every dot flies from the old layout to the
 * new one. Numbers in the prose are not typed in: a <b data-fact="..."> is filled from
 * story.json, so the text cannot drift from the chart. Modelled on stanford-on-github/story. */
import { dots, maps, map, lend, columns } from './layout.js';
import { createPoints } from './gl.js';

// 0 ink, 1 borrowed / far (red), 2 gold, 3 own tide (green), 4 slate, 5 grey
const PAL = [[0.11, 0.1, 0.09], [0.7, 0.13, 0.11], [0.85, 0.62, 0.18], [0.24, 0.5, 0.33], [0.17, 0.33, 0.52], [0.8, 0.78, 0.74]];

/* Shares: whole percent from 10% up, one decimal below it ("4.4%"); 0 is "none". */
export const pct = (v) => (v === 0 ? 'none' : v >= 0.095 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`);
const fmt = (n) => n.toLocaleString('en-US');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/* NOAA's names shout in places ("KEY WEST", "PAGO PAGO Harbor"): title-case each all-caps word. */
export const title = (s) => s.replace(/\b[A-Z]{2,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
const place = (s) => title(s.split(',')[0].replace(/\s*\(.*\)/, ''));

/* "sub" -> "64%". Unknown kinds throw: a typo must not render as blank. */
export function fact(D, spec) {
  const [kind, a] = spec.split(':');
  const X = D.control, T = D.dist;
  switch (kind) {
    case 'n': return fmt(D.n);
    case 'ref': return fmt(D.ref);
    case 'refshare': return pct(D.ref / D.n);
    case 'sub': return fmt(D.sub);
    case 'subshare': return pct(D.sub / D.n);
    case 'lent': return fmt(D.sub - D.self.length);
    case 'lenders': return fmt(D.lenders);
    case 'idle': return fmt(D.idle);
    case 'topname': return place(D.top[Number(a)].name);
    case 'topn': return fmt(D.top[Number(a)].n);
    case 'top10': return pct(D.top10);
    case 'median': return `${Math.round(T.median)} km`;
    case 'within50': return fmt(T.within50);
    case 'distn': return fmt(T.n);
    case 'far': return fmt(T.far);
    case 'farkm': return `${fmt(T.farkm)} km`;
    case 'over1000': return fmt(T.over1000);
    case 'farelse': return fmt(T.farelse);
    case 'farlend': return place(T.farlend[Number(a)].name);
    case 'farlendn': return fmt(T.farlend[Number(a)].n);
    case 'farthest': return place(T.farthest.name);
    case 'farthestkm': return `${fmt(T.farthest.km)} km`;
    case 'farfrom': return place(T.farthest.from);
    case 'usn': return fmt(X.us.n);
    case 'ussub': return pct(X.us.sub);
    case 'elsen': return fmt(X.else.n);
    case 'elsesub': return pct(X.else.sub);
    case 'state': return pct(X.states[a].sub);
    case 'staten': return fmt(X.states[a].n);
    case 'listed': { const [y, m, d] = D.listed.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; }
    case 'bad': return D.bad.map(place).join(' and ');
    case 'self': return D.self.map(place).join(', ');
    case 'offmap': return D.offmap.map(place).join(' and ');
    default: throw new Error(`unknown fact ${spec}`);
  }
}

/* data-kind -> layout */
export function layoutFor(step, ds, D, aspect) {
  const k = step.dataset.kind;
  if (k === 'lend') return lend(ds, aspect, D.aspect);
  if (k === 'dist') return columns(ds, D.dist.bins.length + 1, aspect);
  if (!maps[k]) throw new Error(`unknown layout ${k}`);
  return map(ds, aspect, D.aspect, maps[k]);
}

/* The distance columns' labels: "<10", "10–25", … "1,000+". */
export function binLabels(D) {
  const B = D.dist.bins;
  return [`<${B[0]}`, ...B.slice(1).map((b, i) => `${fmt(B[i])}–${fmt(b)}`), `${fmt(B.at(-1))}+`];
}

async function main() {
  const D = await (await fetch('story.json')).json();
  for (const el of document.querySelectorAll('[data-fact]')) el.textContent = fact(D, el.dataset.fact);
  const ds = dots(D);

  const steps = [...document.querySelectorAll('.step')];
  const canvas = document.getElementById('gl');
  const plot = document.getElementById('plot');
  const axes = document.getElementById('axes');

  let layouts = [];
  const relayout = () => {
    const a = plot.clientWidth / Math.max(1, plot.clientHeight);
    layouts = steps.map((s) => layoutFor(s, ds, D, a));
    window.__story = { dots: ds.length, layouts: layouts.map((l) => ({ kind: l.kind, per: l.per })) };
  };
  relayout();

  const pts = createPoints(canvas, ds.length, PAL);
  if (!pts) { document.body.classList.add('nogl'); return; }
  const dpr = Math.min(2, devicePixelRatio || 1);
  let shown = -1;
  const resize = () => {
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
    relayout();
    shown = -1;
  };
  resize();
  addEventListener('resize', resize);

  // the step whose top has crossed mid-viewport is "from", and t runs 0 -> 1 as the next
  // step's top rises from the bottom to the middle
  const progress = () => {
    const line = innerHeight * 0.5;
    let i = 0;
    for (let k = 0; k < steps.length; k++) if (steps[k].getBoundingClientRect().top < line) i = k;
    const next = steps[i + 1];
    if (!next) return { i, t: 0 };
    const top = next.getBoundingClientRect().top;
    return { i, t: Math.min(1, Math.max(0, 1 - (top - line) / (innerHeight - line))) };
  };

  const labels = binLabels(D);
  const drawAxes = (lay) => {
    const html = [];
    if (lay.kind === 'columns') {
      const narrow = plot.clientWidth < 600;
      labels.forEach((lab, i) => {
        const x = ((i + 0.5) / lay.K) * 100;
        html.push(`<span class="tick" style="left:${x}%">${narrow ? lab.replace(',000', 'k') : lab}</span>`);
        html.push(`<span class="val ${i >= 6 ? '' : 'ink'}" style="left:${x}%">${fmt(D.dist.count[i])}</span>`);
      });
      html.push(`<span class="unit">borrowed stations, by km to the station they borrow from</span>`);
    }
    axes.innerHTML = html.join('');
  };

  const t0 = performance.now();
  const frame = () => {
    const { i, t } = progress();
    const j = Math.min(i + 1, steps.length - 1);
    const A = layouts[i], Bl = layouts[j];
    pts.set(A.slots, Bl.slots);
    const cur = t > 0.5 ? j : i;
    if (cur !== shown) {
      shown = cur;
      drawAxes(layouts[cur]);
      document.body.dataset.step = cur;
    }
    axes.style.opacity = String(Math.abs(t - 0.5) * 2);
    const r = plot.getBoundingClientRect();
    const sz = (l) => (l.kind === 'columns' ? Math.max(2, l.cell * r.width * 0.86) : Math.max(2.5, r.width / 170));
    const size = sz(A) + (sz(Bl) - sz(A)) * t;
    pts.draw({ t, time: (performance.now() - t0) / 1000, size, rect: [r.left, r.top, r.width, r.height], dpr });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') main().catch((e) => {
  document.body.classList.add('failed');
  document.getElementById('err').textContent = String(e.message || e);
  console.error(e);
});
