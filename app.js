// Tide Table — the page. All arithmetic lives in tide-logic.js, which is tested directly;
// this file fetches, renders and handles input, and holds no tide maths of its own.
import * as T from './tide-logic.js';

const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let STATIONS = [];
let GAUGES = [];             // stations where NOAA also measures the water (g:1)
let current = null;          // the station being shown
let rows = [];               // high/low predictions
let hourly = [];             // NOAA's harmonic series, when the station has one
let month = [];              // high/low for the next 30 days, for the daylight lows
let dayIndex = null;
let water = null;            // what the nearest gauge measured: { gauge, dep, temp }

// ---- data ---------------------------------------------------------------------------

const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

// A window around today, wide enough that "next tide" always has an answer and the day
// strip has somewhere to go. Asked for in the STATION's local time (lst_ldt): NOAA applies
// each station's DST itself, which is the one thing this page must not try to redo.
function predictionUrl(station, interval, ahead = 5) {
  const now = new Date();
  const from = new Date(now.getTime() - 86400000);
  const to = new Date(now.getTime() + ahead * 86400000);
  const q = new URLSearchParams({
    product: 'predictions', application: 'tide-table',
    begin_date: ymd(from), end_date: ymd(to),
    datum: 'MLLW', station, time_zone: 'lst_ldt', units: 'english',
    format: 'json', interval,
  });
  return `${API}?${q}`;
}

// The last two hours at a gauge, in its own local time: measured levels, or the six-minute
// prediction for the same minutes, which is what the measurement is paired against.
function gaugeUrl(id, product) {
  const q = new URLSearchParams({
    product, application: 'tide-table', station: id, range: '2',
    datum: 'MLLW', time_zone: 'lst_ldt', units: 'english', format: 'json',
  });
  if (product === 'predictions') q.set('interval', '6');
  if (product === 'water_temperature') { q.delete('range'); q.delete('datum'); q.set('date', 'latest'); }
  return `${API}?${q}`;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`NOAA returned ${r.status}`);
  return r.json();
}

// Requests started before the station list is in. Each is taken once, by the first
// getJson for the same URL; a miss (a different date, a different station) just fetches.
const early = new Map();
function prefetch(url) {
  const p = fetchJson(url);
  p.catch(() => {});   // one nobody takes must not log an unhandled rejection
  early.set(url, p);
}
function getJson(url) {
  const p = early.get(url);
  if (!p) return fetchJson(url);
  early.delete(url);
  return p;
}

// ---- rendering -----------------------------------------------------------------------

function message(text, bad = false) {
  const out = $('#out');
  out.replaceChildren();
  out.append(el('div', bad ? 'msg bad' : 'msg', text));
}

function headline(station, now) {
  const box = el('div', 'now');
  box.append(el('p', 'station', `${station.name} · ${station.region} · station ${station.id}`));

  const { next, prev } = T.nextTide(rows, now);
  if (!next) {
    box.append(el('p', 'headline', 'No further tides in the fetched window.'));
    if (water) box.append(measured(water));
    return box;
  }
  const kind = next.type === T.H ? 'High' : 'Low';
  const p = el('p', 'headline');
  p.append(document.createTextNode(`${kind} water `));
  const b = el('b', null, T.clockText(next.t));
  p.append(b);
  p.append(document.createTextNode(`, ${T.untilText(now, next.t)}`));
  box.append(p);

  const after = rows[T.nextTide(rows, now).index + 1];
  const bits = [`${T.heightText(next.v)} above MLLW`];
  if (prev) bits.push(`last ${prev.type === T.H ? 'high' : 'low'} was ${T.clockText(prev.t)}`);
  if (after) bits.push(`then ${after.type === T.H ? 'high' : 'low'} at ${T.clockText(after.t)}`);
  box.append(el('p', 'after', bits.join(' · ')));
  if (water) box.append(measured(water));
  return box;
}

// A reading more than this old is said to be old rather than passed off as 'now'.
const STALE_MIN = 90;

function ago(gauge, t) {
  const m = T.wallMinutes(T.wallNow(new Date(), gauge.tz)) - T.wallMinutes(t);
  return Number.isFinite(m) ? m : 0;
}

// What the water is actually doing: the gap between the gauge and the prediction, which is
// the one thing a tide table cannot know in advance.
function measured({ gauge, dep, temp }) {
  const box = el('div', 'water');
  const where = gauge.km > 0
    ? `At ${gauge.name}, the nearest NOAA gauge (${gauge.km < 10 ? gauge.km.toFixed(1) : Math.round(gauge.km)} km away)`
    : 'At this station\'s NOAA gauge';
  if (dep) {
    const p = el('p', 'meas');
    const calm = Math.abs(dep.diff) < T.CALM_FT;
    p.append(document.createTextNode(`${where}, the water measured ${T.heightText(dep.v)} at ${T.clockText(dep.t)}: `));
    p.append(el('b', calm ? null : dep.diff > 0 ? 'up' : 'down', T.departureText(dep.diff)));
    p.append(document.createTextNode('.'));
    box.append(p);
    if (!calm) {
      box.append(el('p', 'note', `Wind, air pressure and river flow move the water as well as the moon. While this lasts, tides ${gauge.km > 0 ? 'nearby' : 'here'} run about ${Math.abs(dep.diff).toFixed(1)} ft ${dep.diff > 0 ? 'higher' : 'lower'} than the table below.`));
    }
    if (ago(gauge, dep.t) > STALE_MIN) box.append(el('p', 'note', `That is the gauge's latest reading; it has not reported since ${T.clockText(dep.t)}.`));
  } else {
    box.append(el('p', 'note', `${where} has no reading for the last two hours.`));
  }
  if (temp && ago(gauge, temp.t) <= STALE_MIN) box.append(el('p', 'temp', `Water ${temp.v.toFixed(1)} °F (${((temp.v - 32) / 1.8).toFixed(1)} °C) at ${T.clockText(temp.t)}.`));
  return box;
}

// The curve, as an SVG. NOAA's hourly series where it exists, the interpolation otherwise.
function chart(day, now) {
  // AXIS is a reserved strip at the bottom for the hour labels. Without it the hour text
  // and a low-water label landed on top of each other, which bin/audit reports as
  // overlapping blocks -- two labels in the same place are unreadable whatever the colour.
  const W = 700, Hh = 248, padX = 34, padY = 22, AXIS = 30;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
  svg.setAttribute('role', 'img');

  const dayRows = day.tides;
  if (dayRows.length < 2) {
    svg.setAttribute('aria-label', 'Not enough tides on this day to draw a curve.');
    return { svg, usedHourly: false };
  }
  const t0 = T.wallMinutes(`${day.date} 00:00`), t1 = t0 + 1440;
  const inDay = (m) => m >= t0 && m <= t1;

  const hourlyPts = T.curveFromHourly(hourly).filter((p) => inDay(p.m));
  const usedHourly = hourlyPts.length > 6;
  // The interpolation needs the neighbouring extremes, or the curve stops at midnight.
  const pts = usedHourly ? hourlyPts : T.curve(rows, 480).filter((p) => inDay(p.m));
  if (!pts.length) {
    svg.setAttribute('aria-label', 'No curve available for this day.');
    return { svg, usedHourly };
  }

  const vs = pts.map((p) => p.v).concat(dayRows.map((r) => r.v));
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo || 1;
  const floorY = Hh - padY - AXIS;           // the curve's baseline, above the axis strip
  const x = (m) => padX + ((m - t0) / 1440) * (W - padX * 2);
  const y = (v) => floorY - ((v - lo) / span) * (floorY - padY);

  // Midnight, 06, 12, 18 gridlines, so the curve can be read against the clock.
  for (let h = 0; h <= 24; h += 6) {
    const gx = x(t0 + h * 60);
    const line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', gx); line.setAttribute('x2', gx);
    line.setAttribute('y1', padY - 8); line.setAttribute('y2', floorY);
    line.setAttribute('stroke', 'var(--rule)');
    svg.append(line);
    const lab = document.createElementNS(svg.namespaceURI, 'text');
    lab.setAttribute('x', gx); lab.setAttribute('y', Hh - 9);
    lab.setAttribute('text-anchor', 'middle');
    lab.setAttribute('font-size', '11'); lab.setAttribute('fill', 'var(--muted)');
    lab.textContent = h === 24 ? '24' : String(h).padStart(2, '0');
    svg.append(lab);
  }

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.m).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const fill = document.createElementNS(svg.namespaceURI, 'path');
  fill.setAttribute('d', `${d}L${x(pts[pts.length - 1].m).toFixed(1)},${floorY}L${x(pts[0].m).toFixed(1)},${floorY}Z`);
  fill.setAttribute('fill', 'var(--sea-2)'); fill.setAttribute('opacity', '0.55');
  svg.append(fill);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--sea)'); path.setAttribute('stroke-width', '2.5');
  svg.append(path);

  // The extremes themselves, which are the exact numbers, marked on the sketch.
  for (const r of dayRows) {
    const m = T.wallMinutes(r.t);
    const c = document.createElementNS(svg.namespaceURI, 'circle');
    c.setAttribute('cx', x(m)); c.setAttribute('cy', y(r.v)); c.setAttribute('r', '4');
    c.setAttribute('fill', r.type === T.H ? 'var(--high)' : 'var(--low)');
    svg.append(c);
    const lab = document.createElementNS(svg.namespaceURI, 'text');
    lab.setAttribute('x', Math.min(W - padX, Math.max(padX, x(m))));
    lab.setAttribute('y', Math.min(floorY - 4, Math.max(padY + 2, y(r.v) + (r.type === T.H ? -10 : 17))));
    lab.setAttribute('text-anchor', 'middle');
    lab.setAttribute('font-size', '11.5'); lab.setAttribute('fill', 'var(--ink-2)');
    lab.textContent = T.clockText(r.t);
    svg.append(lab);
  }

  // Where we are now, but only on the day that actually contains now.
  if (T.dayOf(now) === day.date) {
    const m = T.wallMinutes(now);
    if (inDay(m)) {
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', x(m)); line.setAttribute('x2', x(m));
      line.setAttribute('y1', padY - 8); line.setAttribute('y2', floorY);
      line.setAttribute('stroke', 'var(--alert)'); line.setAttribute('stroke-width', '2');
      svg.append(line);
    }
  }

  const kinds = dayRows.map((r) => `${r.type === T.H ? 'high' : 'low'} ${T.clockText(r.t)} at ${T.heightText(r.v)}`);
  svg.setAttribute('aria-label', `Tide curve for ${day.date}: ${kinds.join(', ')}.`);
  return { svg, usedHourly };
}

function table(day) {
  const t = el('table');
  const head = el('tr');
  for (const [h, cls] of [['Tide', ''], ['Time', 'num'], ['Height', 'num']]) {
    const th = el('th', cls, h);
    if (cls) th.style.textAlign = 'right';
    head.append(th);
  }
  // Node.append() returns undefined, so this cannot be chained. Caught by the browser
  // shot, which is the only test that runs the real DOM.
  const thead = el('thead');
  thead.append(head);
  t.append(thead);
  const body = el('tbody');
  for (const r of day.tides) {
    const tr = el('tr');
    const kind = el('td', 'kind');
    kind.append(el('span', `tag ${r.type === T.H ? 'h' : 'l'}`, r.type === T.H ? 'High' : 'Low'));
    tr.append(kind);
    tr.append(el('td', 'num', T.clockText(r.t)));
    tr.append(el('td', 'num', T.heightText(r.v)));
    body.append(tr);
  }
  t.append(body);
  return t;
}

// Which day the strip should start on. The fetched window opens YESTERDAY, so index 0 is
// the wrong answer and showing it was a real bug the browser shot caught: the page opened
// on yesterday's tides with no now-marker anywhere.
function todayIndex(days, now) {
  const i = days.findIndex((d) => d.date === T.dayOf(now));
  return i < 0 ? 0 : i;
}

function render() {
  if (!current) return;
  const now = T.wallNow(new Date(), current.tz);
  const days = T.groupByDay(rows);
  if (!days.length) { message('NOAA returned no predictions for this station.', true); return; }
  if (dayIndex === null) dayIndex = todayIndex(days, now);
  dayIndex = Math.min(Math.max(0, dayIndex), days.length - 1);
  const day = days[dayIndex];

  const out = $('#out');
  out.replaceChildren();
  out.append(headline(current, now));

  const strip = el('div', 'days');
  days.forEach((d, i) => {
    const b = el('button', null, d.date === T.dayOf(now)
      ? 'Today' : new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }));
    b.type = 'button';
    if (i === dayIndex) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => { dayIndex = i; render(); });
    strip.append(b);
  });
  out.append(strip);

  const fig = el('figure');
  const { svg, usedHourly } = chart(day, now);
  fig.append(svg);
  const range = day.range === null ? 'only one kind of tide this day, so no range'
    : `range ${day.range.toFixed(1)} ft`;
  fig.append(el('figcaption', null, usedHourly
    ? `${day.date} · ${range} · curve from NOAA's hourly harmonic series.`
    : `${day.date} · ${range} · curve interpolated between high and low water (this station publishes no hourly series).`));
  out.append(fig);

  out.append(el('h3', null, `Tides on ${day.date}`));
  out.append(table(day));
  if (month.length) out.append(lows(T.daylightLows(month, current, now, 5)));
}

// The month's lowest daylight lows. The day strip covers six days; the tide a tidepooler
// wants is usually outside them (37 of 40 sampled stations), so it gets its own list.
function lows(list) {
  const sec = el('section', 'lows');
  sec.append(el('h3', null, 'Lowest daylight tides, next 30 days'));
  if (!list.length) {
    sec.append(el('p', 'note', 'No low tide falls between sunrise and sunset here in the next 30 days.'));
    return sec;
  }
  sec.append(el('p', 'note', 'Low water between sunrise and sunset at the station, lowest first — the ones worth going out on the rocks for. Below 0 ft is a minus tide.'));
  const t = el('table');
  const head = el('tr');
  for (const [h, cls] of [['Day', ''], ['Time', 'num'], ['Height', 'num']]) {
    const th = el('th', cls, h);
    if (cls) th.style.textAlign = 'right';
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  t.append(thead);
  const body = el('tbody');
  for (const r of list) {
    const tr = el('tr');
    tr.append(el('td', null, new Date(`${T.dayOf(r.t)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })));
    tr.append(el('td', 'num', T.clockText(r.t)));
    tr.append(el('td', r.v < 0 ? 'num minus' : 'num', T.heightText(r.v)));
    body.append(tr);
  }
  t.append(body);
  sec.append(t);
  return sec;
}

// ---- choosing a station -----------------------------------------------------------------

async function show(station) {
  current = station;
  dayIndex = null;      // resolved to today's index in render(), once the days are known
  month = [];
  water = null;
  $('#hits').replaceChildren();
  $('#q').value = station.name;
  message(`Loading tides for ${station.name}…`);
  try {
    // Both asked for at once: each is a full round trip to NOAA, and in series the hourly
    // one held the first draw back by ~0.6 s on a phone link (site-speed, 2026-10-28).
    const hourlyP = getJson(predictionUrl(station.id, 'h')).then(T.parseHourly).catch(() => []);
    const hiloRaw = await getJson(predictionUrl(station.id, 'hilo'));
    const err = T.errorOf(hiloRaw);
    if (err) { message(`NOAA could not predict this station: ${err}`, true); return; }
    rows = T.parseRows(hiloRaw);
    if (!rows.length) { message('NOAA returned no high or low water for this station.', true); return; }
    // The hourly series is a bonus: subordinate stations have none, and the page is fully
    // usable without it, so its failure must never take the page down.
    hourly = await hourlyP;   // [] falls back to the interpolated curve
    const url = new URL(location.href);
    url.searchParams.set('station', station.id);
    history.replaceState(null, '', url);
    render();
    // Not awaited: the gauge is independent of the month list, and waiting behind that
    // 30-day request held the block back by seconds on the live site (2026-10-27).
    readGauge(station);
    // The month is a second, larger request and the page is complete without it, so it
    // renders after, and only if the reader has not moved on to another station meanwhile.
    try {
      const got = T.parseRows(await getJson(predictionUrl(station.id, 'hilo', 30)));
      if (current === station) { month = got; render(); }
    } catch { /* the list is a bonus; its failure leaves the page as it was */ }
  } catch (e) {
    message(`Could not reach NOAA: ${e.message}`, true);
  }
}

// The gauge is a bonus too: most stations are not one, and a gauge can be down. Nothing
// here may take the page down; the worst case is that the block is simply absent.
async function readGauge(station) {
  const gauge = T.gaugeFor(station, GAUGES);
  if (!gauge) return;
  try {
    const [obs, pred] = await Promise.all([
      getJson(gaugeUrl(gauge.id, 'water_level')), getJson(gaugeUrl(gauge.id, 'predictions'))]);
    const dep = T.departure(T.parseObserved(obs), T.parseHourly(pred));
    let temp = null;
    if (gauge.w) {
      try { temp = T.parseTemp(await getJson(gaugeUrl(gauge.id, 'water_temperature'))); } catch { /* none */ }
    }
    if (current === station) { water = { gauge, dep, temp }; render(); }
  } catch { /* no block */ }
}

function showHits(list) {
  const ul = $('#hits');
  ul.replaceChildren();
  for (const s of list) {
    const li = el('li');
    const b = el('button');
    b.type = 'button';
    b.append(el('span', null, s.name));
    b.append(document.createTextNode(' '));
    b.append(el('span', 'where', `${s.region} · ${s.id}`));
    b.addEventListener('click', () => show(s));
    li.append(b);
    ul.append(li);
  }
}

$('#q').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  showHits(q.length < 2 ? [] : T.search(STATIONS, q, 12));
});

$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) { message('This browser will not share a location.', true); return; }
  message('Asking your browser where you are…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const near = T.nearest(STATIONS, pos.coords.latitude, pos.coords.longitude, 8);
      if (!near.length) { message('No station found near you.', true); return; }
      showHits(near);
      show(near[0]);
    },
    () => message('Your browser would not share a location. Search for a station instead.', true),
    { timeout: 10000 },
  );
});

// ---- start -------------------------------------------------------------------------------

(async () => {
  // The start station's id is known before the 470 KB list is: it is in the URL, or it is
  // San Francisco. Its two NOAA requests go out now, alongside the list, instead of after
  // it -- on a phone link that was the difference between 5.6 s and ~2.5 s to the answer.
  const startId = new URL(location.href).searchParams.get('station') || '9414290';
  if (/^[0-9A-Z]{5,10}$/.test(startId)) {
    prefetch(predictionUrl(startId, 'h'));
    prefetch(predictionUrl(startId, 'hilo'));
  }
  try {
    STATIONS = (await getJson('data/stations.json')).stations;
    GAUGES = STATIONS.filter((s) => s.g);
  } catch {
    message('Could not load the station list.', true);
    return;
  }
  const want = new URL(location.href).searchParams.get('station');
  const start = (want && STATIONS.find((s) => s.id === want))
    || STATIONS.find((s) => s.id === '9414290')   // San Francisco: a mixed tide, well known
    || STATIONS[0];
  if (start) show(start);
})();
