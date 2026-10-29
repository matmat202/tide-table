// Tide Table — the arithmetic, with no DOM and no network, so it can be tested directly.
//
// NOAA returns each prediction as {t, v, type}: `t` is a wall-clock string in the
// STATION's own local time ("2026-10-27 06:01", no zone, DST already applied by NOAA),
// `v` is the height, `type` is "H" or "L".
//
// WALL CLOCK, NOT INSTANTS. Everything below compares station wall-clock strings against
// a station wall-clock "now" that `wallNow` derives with Intl. Two reasons, both
// deliberate:
//   * NOAA has already done the DST work for every station, which is its job and not
//     ours. Re-deriving it from an offset would be a second, worse answer.
//   * "YYYY-MM-DD HH:MM" sorts lexicographically in chronological order, so ordering is
//     exact with no Date parsing and no zone to get wrong.
// The viewer's own clock is never used for anything a reader sees.

export const H = 'H';
export const L = 'L';

// ---- parsing ------------------------------------------------------------------------

// NOAA's JSON -> typed rows. Anything malformed is dropped rather than coerced: a tide at
// NaN feet drawn on a chart is worse than a tide missing from it.
export function parseRows(payload) {
  const raw = (payload && payload.predictions) || [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r.t !== 'string') continue;
    const t = r.t.trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)) continue;
    const v = Number(r.v);
    if (!Number.isFinite(v)) continue;
    const type = r.type === H ? H : r.type === L ? L : null;
    if (!type) continue;
    out.push({ t, v, type });
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

// NOAA reports an error as a payload with no predictions; distinguish that from "no tides
// in this window", because one is a fault to show and the other is just a quiet day.
export function errorOf(payload) {
  if (!payload) return 'no response';
  if (payload.error && payload.error.message) return String(payload.error.message).trim();
  return null;
}

// ---- the station's clock -------------------------------------------------------------

const wallFmt = new Map();

// The wall-clock string it is right now at a station, in the same shape NOAA uses.
// `en-CA` yields YYYY-MM-DD; the pieces are assembled rather than string-matched so a
// locale surprise cannot silently reorder them.
export function wallNow(date, tz) {
  const key = tz || 'UTC';
  if (!wallFmt.has(key)) {
    wallFmt.set(key, new Intl.DateTimeFormat('en-CA', {
      timeZone: key, year: 'numeric', month: '2-digit', day: '2-digit',
      // hourCycle h23 explicitly, NOT hour12:false. They differ at exactly one instant:
      // hour12:false can yield the h24 cycle, where midnight formats as "24:00" of the
      // PREVIOUS day. h23 makes it "00:00" of the right one, which removes the need for a
      // defensive fold that no test could ever reach.
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  const p = {};
  for (const part of wallFmt.get(key).formatToParts(date)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Minutes since an arbitrary epoch, for differences only. Wall-clock arithmetic, so a DST
// jump inside the interval is off by an hour — acceptable because this is only ever used
// for "in 3h 12m" on an interval of at most ~12 hours, and NOAA's own times are the thing
// being differenced.
export function wallMinutes(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 60000;
}

// ---- the next tide --------------------------------------------------------------------

// The first tide at or after `now`, and the one before it. Either may be null at the edge
// of the fetched window, and the caller must cope: a page that assumes both exist shows
// "undefined" on the first and last day of its own data.
export function nextTide(rows, now) {
  let prev = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].t >= now) return { next: rows[i], prev, index: i };
    prev = rows[i];
  }
  return { next: null, prev, index: -1 };
}

// "in 3h 12m" / "in 47m" / "now". Never negative: a past tide is the caller's bug to fix,
// not something to render as "in -2h".
export function untilText(now, then) {
  const a = wallMinutes(now), b = wallMinutes(then);
  if (a === null || b === null) return '';
  const d = Math.max(0, b - a);
  if (d === 0) return 'now';
  const h = Math.floor(d / 60), m = d % 60;
  if (h === 0) return `in ${m}m`;
  if (m === 0) return `in ${h}h`;
  return `in ${h}h ${m}m`;
}

// How far through the stretch between two tides we are, 0..1. Drives the curve marker.
export function phase(prev, next, now) {
  if (!prev || !next) return null;
  const a = wallMinutes(prev.t), b = wallMinutes(next.t), n = wallMinutes(now);
  if (a === null || b === null || n === null || b <= a) return null;
  return Math.min(1, Math.max(0, (n - a) / (b - a)));
}

// ---- days ------------------------------------------------------------------------------

export const dayOf = (t) => (typeof t === 'string' ? t.slice(0, 10) : '');

// Rows grouped into calendar days, in order, each with its own range.
export function groupByDay(rows) {
  const days = new Map();
  for (const r of rows) {
    const d = dayOf(r.t);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  return [...days.entries()].map(([date, tides]) => ({ date, tides, range: rangeOf(tides) }));
}

// The day's tidal range: highest high minus lowest low. Null when the day has only one
// kind of tide, because "range" would then be a difference against nothing.
export function rangeOf(tides) {
  const hi = tides.filter((t) => t.type === H).map((t) => t.v);
  const lo = tides.filter((t) => t.type === L).map((t) => t.v);
  if (!hi.length || !lo.length) return null;
  return Math.max(...hi) - Math.min(...lo);
}

// ---- the curve ---------------------------------------------------------------------------

// Height between two consecutive extremes, as a half-cosine. This is the standard
// approximation a tide table is drawn with (the "rule of twelfths" is its coarse integer
// form), and it is exactly right at both ends, which is what keeps the drawn curve
// touching the plotted highs and lows.
export function between(prev, next, frac) {
  const f = Math.min(1, Math.max(0, frac));
  return prev.v + (next.v - prev.v) * (1 - Math.cos(Math.PI * f)) / 2;
}

// `steps` samples across the whole series, as {t, v} in wall-clock minutes. Returns [] for
// fewer than two rows: one tide defines no curve, and inventing one would be decoration.
export function curve(rows, steps = 240) {
  if (rows.length < 2 || steps < 2) return [];
  const t0 = wallMinutes(rows[0].t), t1 = wallMinutes(rows[rows.length - 1].t);
  if (t0 === null || t1 === null || t1 <= t0) return [];
  const out = [];
  let seg = 0;
  for (let i = 0; i < steps; i++) {
    const m = t0 + ((t1 - t0) * i) / (steps - 1);
    while (seg < rows.length - 2 && wallMinutes(rows[seg + 1].t) < m) seg++;
    const a = rows[seg], b = rows[seg + 1];
    const am = wallMinutes(a.t), bm = wallMinutes(b.t);
    out.push({ m, v: bm > am ? between(a, b, (m - am) / (bm - am)) : a.v });
  }
  return out;
}

// NOAA's hourly series as curve points. Preferred over `curve` wherever it exists,
// because it comes from the full harmonic model instead of an interpolation between
// extremes. That is not a stylistic preference, it is measured: scored against these very
// rows in test/facts.json, the interpolation is within 0.05-0.58 ft at San Francisco,
// Boston, Pensacola and Honolulu, but reaches 6.06 ft at ANCHORAGE, whose Cook Inlet tide
// floods fast and ebbs slow and so is nothing like a symmetric cosine.
//
// Subordinate stations have no hourly series at all (NOAA computes one only for harmonic
// reference stations; station 9501801 returns zero rows), which is why `curve` stays as
// the fallback rather than being deleted.
export function curveFromHourly(rows) {
  const out = [];
  for (const r of rows) {
    const m = wallMinutes(r.t);
    if (m !== null && Number.isFinite(r.v)) out.push({ m, v: r.v });
  }
  out.sort((a, b) => a.m - b.m);
  return out;
}

// Hourly rows carry no `type`, so parseRows would drop every one of them. Same validation
// otherwise: a height that is not a number is dropped rather than coerced.
export function parseHourly(payload) {
  const raw = (payload && payload.predictions) || [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r.t !== 'string') continue;
    const t = r.t.trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)) continue;
    const v = Number(r.v);
    if (!Number.isFinite(v)) continue;   // hourly: same validation, no type to check
    out.push({ t, v });
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

// ---- what the water is doing now ----------------------------------------------------------
//
// A prediction is astronomy; the water also answers to wind, pressure and river flow, and
// at a gauge NOAA publishes what it actually measured every six minutes. The gap between
// the two is the thing a prediction cannot tell you: a storm surge, or a king tide running
// higher than the table says. Measured over Sep 26 - Oct 26 2026 at 30 random gauges
// (state/scratch/tide-now/lever.py), see BRIEF.md for the numbers.

// Six-minute water levels. Same row shape as the hourly predictions and the same rule: a
// reading that is not a number is dropped, not drawn. NOAA marks a reading it could not
// take with v:"" -- Number("") is 0, so the empty string must be refused explicitly or a
// missing reading becomes a tide at datum.
export function parseObserved(payload) {
  const raw = (payload && payload.data) || [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r.t !== 'string') continue;
    const t = r.t.trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)) continue;
    if (typeof r.v !== 'string' || r.v.trim() === '') continue;
    const v = Number(r.v);
    if (!Number.isFinite(v)) continue;
    out.push({ t, v });
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

// Observed minus predicted, averaged over the latest `span` readings that have a
// prediction at the same minute. Averaged because one six-minute reading carries waves
// and seiche; an hour of them is the water's level. Null when nothing pairs up -- a gauge
// that is down is not a gauge reading zero.
export function departure(observed, predicted, span = 10) {
  const p = new Map(predicted.map((r) => [r.t, r.v]));
  const pairs = observed.filter((r) => p.has(r.t));
  if (!pairs.length) return null;
  const last = pairs.slice(-span);
  const diff = last.reduce((a, r) => a + (r.v - p.get(r.t)), 0) / last.length;
  const now = last[last.length - 1];
  return { t: now.t, v: now.v, predicted: p.get(now.t), diff, n: last.length };
}

// Within a quarter of a foot the honest word is 'as predicted': that is about the spread
// of an ordinary calm day at most gauges, and calling 0.1 ft 'above' would be noise.
export const CALM_FT = 0.25;
export function departureText(diff) {
  if (!Number.isFinite(diff)) return '';
  if (Math.abs(diff) < CALM_FT) return 'about as predicted';
  return `${Math.abs(diff).toFixed(1)} ft ${diff > 0 ? 'above' : 'below'} the prediction`;
}

// Water temperature: NOAA's `date=latest` returns one reading. Null on anything else.
export function parseTemp(payload) {
  const rows = parseObserved(payload);
  return rows.length ? rows[rows.length - 1] : null;
}

// The gauge to read for a station: the station itself if it has one, else the nearest
// gauge within `maxKm`. A surge is spread over tens of kilometres of coast, so a nearby
// gauge says something true about the water here; a far one does not, and none is better
// than a wrong one. `gauges` are stations carrying g:1.
export function gaugeFor(station, gauges, maxKm = 40) {
  if (!station) return null;
  if (station.g) return { ...station, km: 0 };
  let best = null;
  for (const g of gauges) {
    const km = distanceKm(station.lat, station.lng, g.lat, g.lng);
    if (km <= maxKm && (!best || km < best.km || (km === best.km && g.id < best.id))) best = { ...g, km };
  }
  return best;
}

// ---- stations ----------------------------------------------------------------------------

const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

// Great-circle distance in km. Haversine, which is stable for the short distances that
// decide "nearest station" (the law of cosines loses precision under a kilometre).
export function distanceKm(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

// The `n` stations closest to a point, nearest first, each carrying its distance.
export function nearest(stations, lat, lng, n = 8) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  return stations
    .map((s) => ({ ...s, km: distanceKm(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, n));
}

// Substring search over name and region, ranked so a prefix match beats a mid-word one.
// Accent- and case-folded, because "Cañaveral" is typed "canaveral".
export const fold = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function search(stations, q, limit = 20) {
  const needle = fold(q);
  if (!needle) return [];
  const hits = [];
  for (const s of stations) {
    const name = fold(s.name), region = fold(s.region);
    const i = name.indexOf(needle);
    const j = i < 0 ? region.indexOf(needle) : -1;
    if (i < 0 && j < 0 && !fold(s.id).startsWith(needle)) continue;
    // Rank: name-prefix, then name-substring, then region, then bare id.
    const rank = i === 0 ? 0 : i > 0 ? 1 : j >= 0 ? 2 : 3;
    hits.push({ s, rank, name });
  }
  hits.sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return hits.slice(0, limit).map((h) => h.s);
}

// ---- formatting ----------------------------------------------------------------------------

// "6:01 am". Built from the wall-clock string itself rather than via Date, so it cannot
// pick up the viewer's zone -- the bug this whole module is shaped to avoid.
export function clockText(t) {
  const m = /\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})$/.exec(t || '');
  if (!m) return '';
  let h = Number(m[1]);
  const suffix = h < 12 ? 'am' : 'pm';
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${m[2]} ${suffix}`;
}

export const heightText = (v, unit = 'ft') =>
  `${v >= 0 ? '' : '\u2212'}${Math.abs(v).toFixed(1)} ${unit}`;

// ---- the month's best low tides, in daylight ----------------------------------------------
//
// The day strip shows six days, and the lowest daylight low of the next month fell outside
// it at 37 of 40 sampled stations (2026-10-27). Tidepooling wants exactly that tide, so it
// is listed on its own. Sun times are NOAA's solar-position equations, copied from the
// Daylight site's sun-logic.js (tested there against NOAA's calculator); here they only
// decide whether a low tide falls between sunrise and sunset.

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const ZENITH = 90.833;

function solar(jd) {
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eot = 4 * DEG * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  return { decl, eot };
}

const cosH = (lat, decl) => Math.cos(ZENITH * RAD) / (Math.cos(lat * RAD) * Math.cos(decl * RAD))
  - Math.tan(lat * RAD) * Math.tan(decl * RAD);

// Sunrise and sunset on a station's calendar date, as station wall-clock strings, so they
// compare directly against NOAA's rows. `polar` is 'day' or 'night' when the sun never
// sets or never rises; rise and set are then null.
export function sunWall(date, lat, lng, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d) / 86400e3 + 2440587.5;
  let noon = 720 - 4 * lng;
  for (let i = 0; i < 2; i++) noon = 720 - 4 * lng - solar(base + noon / 1440).eot;
  const c = cosH(lat, solar(base + noon / 1440).decl);
  if (c > 1) return { rise: null, set: null, polar: 'night' };
  if (c < -1) return { rise: null, set: null, polar: 'day' };
  const event = (sign) => {
    let t = noon + sign * 4 * Math.acos(c) * DEG;
    for (let i = 0; i < 2; i++) {
      const s = solar(base + t / 1440);
      const cc = Math.max(-1, Math.min(1, cosH(lat, s.decl)));
      t = 720 - 4 * lng - s.eot + sign * 4 * Math.acos(cc) * DEG;
    }
    return wallNow(new Date(Date.UTC(y, m - 1, d) + t * 60e3), tz);
  };
  return { rise: event(-1), set: event(1), polar: null };
}

// The `n` lowest low tides between sunrise and sunset, lowest first (earlier first on a
// tie), from `now` on. A low at 3 am is no use to anyone on the rocks, however low it is.
export function daylightLows(rows, station, now, n = 5) {
  const sun = new Map();
  const lit = (r) => {
    const date = dayOf(r.t);
    if (!sun.has(date)) sun.set(date, sunWall(date, station.lat, station.lng, station.tz));
    const s = sun.get(date);
    if (s.polar) return s.polar === 'day';
    return r.t >= s.rise && r.t <= s.set;
  };
  return rows.filter((r) => r.type === L && r.t >= now && lit(r))
    .sort((a, b) => a.v - b.v || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .slice(0, n > 0 ? n : 0);
}

// ---- currents (tide-currents) -------------------------------------------------------------

export const SLACK = 'slack', FLOOD = 'flood', EBB = 'ebb';

// NOAA's MAX_SLACK rows -> { t, type, kn, dir }, time-ordered. `kn` is the speed, always
// positive: NOAA signs ebb negative, and "-1.85 kn" reads as a typo. `dir` is the compass
// heading the water runs TOWARD at a peak, and null at slack, where it runs nowhere.
export function parseCurrents(payload) {
  const cp = payload && payload.current_predictions && payload.current_predictions.cp;
  if (!Array.isArray(cp)) return [];
  const out = [];
  for (const r of cp) {
    if (!r || typeof r.Time !== 'string') continue;
    const t = r.Time.trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)) continue;
    const type = r.Type === SLACK || r.Type === FLOOD || r.Type === EBB ? r.Type : null;
    if (!type) continue;
    if (r.Velocity_Major === null || r.Velocity_Major === '' || r.Velocity_Major === undefined) continue;
    const v = Number(r.Velocity_Major);
    if (!Number.isFinite(v)) continue;
    const d = type === SLACK ? NaN : Number(type === EBB ? r.meanEbbDir : r.meanFloodDir);
    out.push({ t, type, kn: Math.abs(v), dir: Number.isFinite(d) ? d : null });
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

// The current station to read for a tide station: the nearest within `maxKm`. Currents
// change across a single channel, so the bar is tighter than the gauge's 40 km: 15 km is
// what the kill-rule measurement paired stations at (state/scratch/tide-currents).
export function currentFor(station, currents, maxKm = 15) {
  if (!station) return null;
  let best = null;
  for (const c of currents) {
    const km = distanceKm(station.lat, station.lng, c.lat, c.lng);
    if (km <= maxKm && (!best || km < best.km || (km === best.km && c.id < best.id))) best = { ...c, km };
  }
  return best;
}

// The next slack, the next peak flood and the next peak ebb at or after `now`.
export function nextCurrents(rows, now) {
  const out = { slack: null, flood: null, ebb: null };
  for (const r of rows) {
    if (r.t >= now && !out[r.type]) out[r.type] = r;
  }
  return out;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
// 0-360 degrees -> the nearest of 16 compass points. 348.75 and up is N again.
export function compass(deg) {
  if (!Number.isFinite(deg)) return '';
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// Minutes from the nearest high or low water to a slack, signed: +38 is 38 minutes AFTER
// the tide turned. This is the number that makes the block worth having -- slack is not
// high or low tide (median 38 min apart over 30 sampled pairs, 6 over an hour), and a
// paddler who times a crossing by the tide table alone is off by exactly this much.
export function slackOffset(slack, tides) {
  const s = slack && wallMinutes(slack.t);
  if (s === null || s === undefined || !tides || !tides.length) return null;
  let best = null;
  for (const r of tides) {
    const m = wallMinutes(r.t);
    if (m === null) continue;
    if (best === null || Math.abs(s - m) < Math.abs(best.min)) best = { min: s - m, tide: r };
  }
  return best;
}
