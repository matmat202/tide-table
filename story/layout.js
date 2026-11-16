/* Pure logic for "Borrowed tides": story.json -> per-chapter particle slots. No DOM, no GL,
 * so node can test it (test/story.test.mjs).
 *
 * One dot is one NOAA tide prediction station, the same dot in every chapter. Map chapters
 * put it where the station is; the lending chapter gathers every borrowed station round the
 * station it borrows from; the distance chapter stacks borrowed stations in columns by how
 * far that is. A layout is N slots of [x, y, colour, alpha] in plot space: x, y in 0..1, y up.
 * Every number the prose prints is computed by build_story.py, never from the dots. */

export const F = { sub: 1, us: 2, hidden: 4 };

/* The dots, in story.json's fixed order. */
export function dots(D) {
  return D.dots.map(([x, y, f, ref, bin], i) => {
    if (ref >= D.dots.length || ref === i) throw new Error(`dot ${i}: bad reference ${ref}`);
    if (bin >= D.dist.bins.length + 1) throw new Error(`dot ${i}: bad distance column ${bin}`);
    return { i, x, y, sub: !!(f & F.sub), us: !!(f & F.us), hidden: !!(f & F.hidden), ref, bin };
  });
}

/* Colours are palette indices (story.js): 0 ink, 1 red, 2 gold, 3 green, 4 slate, 5 grey. */
export const C = { ink: 0, red: 1, gold: 2, green: 3, slate: 4, grey: 5 };

export const TOP = 0.9; // the plot's top tenth is left for the axis labels

/* Where the map sits in a plot of aspect a (width / height): as large as fits, centred,
 * keeping the map's own aspect m so the coast is not squashed. */
export function mapBox(a, m) {
  const W = 0.98, H = TOP - 0.02;
  if (m > (W * a) / H) { const h = (W * a) / m; return { x: 0.01, y: 0.02 + (H - h) / 2, w: W, h }; }
  const w = (H * m) / a;
  return { x: (1 - w) / 2, y: 0.02, w, h: H };
}
const place = (box, d) => [box.x + d.x * box.w, box.y + d.y * box.h];

/* Map chapters: every dot where its station is, coloured and lit by the chapter.
 * A hidden dot (wrong coordinates, or far off the map) sits mid-plot with alpha 0. */
export const maps = {
  map: { colour: () => C.ink, alpha: () => 0.85 },
  kind: { colour: (d) => (d.sub ? C.grey : C.green), alpha: () => 1 },
  us: { colour: (d) => (d.sub ? C.grey : C.green), alpha: (d) => (d.us ? 1 : 0.1) },
  far: { colour: (d) => (d.bin >= FARBIN ? C.red : C.grey), alpha: (d) => (d.bin >= FARBIN ? 1 : 0.35) },
};
export const FARBIN = 6; // the columns from 500 km up (story.json dist.bins)

export function map(ds, a, m, ch = maps.map) {
  const box = mapBox(a, m), slots = new Float32Array(ds.length * 4);
  for (const d of ds) {
    const [x, y] = d.hidden ? [0.5, 0.45] : place(box, d);
    slots.set([x, y, ch.colour(d), d.hidden ? 0 : ch.alpha(d)], d.i * 4);
  }
  return { kind: 'map', slots, box };
}

/* Every borrowed station gathered round its lender in a sunflower spiral, so a lender's
 * patch grows with the number it lends to. Lenders red, borrowers red too, harmonic
 * stations that lend to nobody faint. `r0` is the spacing in plot widths. */
export function lend(ds, a, m, r0 = 0.0042) {
  const box = mapBox(a, m), slots = new Float32Array(ds.length * 4), seen = new Map();
  const lenders = new Set(ds.filter((d) => d.ref >= 0).map((d) => d.ref));
  const G = Math.PI * (3 - Math.sqrt(5));
  for (const d of ds) {
    if (d.hidden) { slots.set([0.5, 0.45, C.grey, 0], d.i * 4); continue; }
    if (d.ref < 0) {
      const [x, y] = place(box, d);
      slots.set([x, y, lenders.has(d.i) ? C.red : C.grey, lenders.has(d.i) ? 1 : 0.3], d.i * 4);
      continue;
    }
    const k = (seen.get(d.ref) || 0) + 1;
    seen.set(d.ref, k);
    const [cx, cy] = place(box, ds[d.ref]), r = r0 * Math.sqrt(k);
    slots.set([cx + r * Math.cos(k * G), cy + r * Math.sin(k * G) * a, C.red, 0.9], d.i * 4);
  }
  return { kind: 'lend', slots, box };
}

/* The fewest dots a row (so the biggest dots) that still fit the tallest column under TOP,
 * with square cells in a plot of aspect a. */
export function perRow(maxN, K, a, top = TOP) {
  const barW = (1 / K) * 0.8;
  for (let k = 1; k <= 200; k++) if (Math.ceil(maxN / k) * (barW / k) * a <= top) return k;
  throw new Error(`no row width fits ${maxN} dots`);
}

/* Borrowed stations stacked by distance column, nearest first; everything else unlit. */
export function columns(ds, K, a) {
  const n = new Array(K).fill(0);
  for (const d of ds) if (d.bin >= 0) n[d.bin]++;
  const per = perRow(Math.max(...n), K, a), colW = 1 / K, barW = colW * 0.8, cw = barW / per, chh = cw * a;
  const slots = new Float32Array(ds.length * 4), at = new Array(K).fill(0);
  for (const d of ds) {
    if (d.bin < 0) { slots.set([0.5, 0.45, C.grey, 0], d.i * 4); continue; }
    const j = at[d.bin]++, r = Math.floor(j / per), c = j % per;
    slots.set([d.bin * colW + (colW - barW) / 2 + (c + 0.5) * cw, (r + 0.5) * chh, d.bin >= FARBIN ? C.red : C.slate, 1], d.i * 4);
  }
  return { kind: 'columns', slots, per, cell: cw, K };
}

/* "nearly two in three" style: a share as the nearest x in 10. */
export const inTen = (p) => `${Math.round(p * 10)} in 10`;
