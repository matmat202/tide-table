// node site/tide-logic.test.mjs — the page's pure logic against reference answers
// recomputed in Python (test/facts.json, made by test/facts.py) and against NOAA's own
// harmonic hourly predictions. Exit 1 on any failure.
//   test/plant.sh   # mutates a copy of the logic; each mutant must FAIL this suite
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const L = await import(process.env.LOGIC ? pathToFileURL(process.env.LOGIC).href : './tide-logic.js');
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pick = (...ps) => ps.find((p) => existsSync(here(p)));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
// Key-ORDER-independent deep compare. test/facts.json is written by Python with sorted
// keys, so {t,v,type} from the page and {t,type,v} from the reference are the same record
// and must not read as a failure. Values still compare exactly.
const canon = (x) => (Array.isArray(x) ? x.map(canon)
  : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])]))
    : x);
const str = (x) => JSON.stringify(canon(x));
const eq = (name, a, b) => ok(name, str(a) === str(b), `got ${str(a)} want ${str(b)}`);
const near = (name, a, b, tol) => ok(name, Math.abs(a - b) <= tol, `got ${a} want ${b} ±${tol}`);

const facts = JSON.parse(readFileSync(here(pick('../test/facts.json', 'test/facts.json')), 'utf8'));
const noaaDir = pick('../test/noaa', 'test/noaa');
const load = (sid, prod) => JSON.parse(readFileSync(here(`${noaaDir}/${sid}-${prod}.json`), 'utf8'));

// --- parsing -------------------------------------------------------------------------
eq('a malformed row is dropped, not coerced', L.parseRows({ predictions: [
  { t: '2026-03-01 05:00', v: '1.5', type: 'H' },
  { t: 'not a time', v: '1.0', type: 'L' },
  { t: '2026-03-01 11:00', v: 'abc', type: 'L' },
  { t: '2026-03-01 17:00', v: '0.5', type: 'X' },
] }), [{ t: '2026-03-01 05:00', v: 1.5, type: 'H' }]);
eq('rows come back in time order', L.parseRows({ predictions: [
  { t: '2026-03-02 01:00', v: '1', type: 'H' },
  { t: '2026-03-01 01:00', v: '2', type: 'L' },
] }).map((r) => r.t), ['2026-03-01 01:00', '2026-03-02 01:00']);
eq('no payload is an error, not an empty day', L.errorOf(null), 'no response');
eq("NOAA's own error message is surfaced", L.errorOf({ error: { message: ' bad station ' } }), 'bad station');
eq('a good payload reports no error', L.errorOf({ predictions: [] }), null);
// Hourly rows carry no `type`; parseRows must drop them and parseHourly must keep them.
eq('parseRows drops typeless hourly rows', L.parseRows({ predictions: [{ t: '2026-03-01 05:00', v: '1.5' }] }), []);
eq('parseHourly keeps them', L.parseHourly({ predictions: [{ t: '2026-03-01 05:00', v: '1.5' }] }),
  [{ t: '2026-03-01 05:00', v: 1.5 }]);
// parseHourly validates too. Found by a surviving mutant: stripping its checks entirely
// passed the suite, because nothing fed it a bad row.
eq('parseHourly drops malformed rows', L.parseHourly({ predictions: [
  { t: '2026-03-01 05:00', v: '1.5' },
  { t: 'not a time', v: '2.0' },
  { t: '2026-03-01 06:00', v: 'abc' },
  { v: '3.0' },
  null,
] }), [{ t: '2026-03-01 05:00', v: 1.5 }]);
eq('parseHourly sorts by time', L.parseHourly({ predictions: [
  { t: '2026-03-01 06:00', v: '2' }, { t: '2026-03-01 05:00', v: '1' },
] }).map((r) => r.t), ['2026-03-01 05:00', '2026-03-01 06:00']);

// --- the station's clock, never the viewer's -------------------------------------------
const inst = new Date('2026-03-01T20:30:00Z');
eq('wall clock in Los Angeles', L.wallNow(inst, 'America/Los_Angeles'), '2026-03-01 12:30');
eq('wall clock in New York', L.wallNow(inst, 'America/New_York'), '2026-03-01 15:30');
eq('wall clock in Honolulu', L.wallNow(inst, 'Pacific/Honolulu'), '2026-03-01 10:30');
eq('wall clock in UTC', L.wallNow(inst, 'UTC'), '2026-03-01 20:30');
// Etc/GMT signs are inverted by the standard: Etc/GMT+8 is UTC-8. Pinned, because getting
// it backwards moves a station a whole ocean and still looks plausible.
eq('Etc/GMT+8 is UTC-8', L.wallNow(inst, 'Etc/GMT+8'), '2026-03-01 12:30');
eq('Etc/GMT-10 is UTC+10', L.wallNow(inst, 'Etc/GMT-10'), '2026-03-02 06:30');
// DST is NOT ours to compute: Intl must do it. US spring-forward 2026 is the second
// Sunday in March, 2026-03-08, at 02:00 local standard time = 07:00 UTC. These two
// instants straddle that, so the offset must differ across them: -5 then -4.
eq('before US spring-forward', L.wallNow(new Date('2026-03-08T06:30:00Z'), 'America/New_York'), '2026-03-08 01:30');
eq('after US spring-forward', L.wallNow(new Date('2026-03-08T11:30:00Z'), 'America/New_York'), '2026-03-08 07:30');
// A zone that does not observe it must not shift on the same instants.
eq('Honolulu ignores spring-forward', [
  L.wallNow(new Date('2026-03-08T09:30:00Z'), 'Pacific/Honolulu'),
  L.wallNow(new Date('2026-03-08T11:30:00Z'), 'Pacific/Honolulu'),
], ['2026-03-07 23:30', '2026-03-08 01:30']);
// Wall-clock strings sort chronologically; the whole module leans on this.
ok('wall strings sort chronologically', '2026-03-01 09:05' < '2026-03-01 10:00'
  && '2026-03-09 23:59' < '2026-03-10 00:00');

// --- minutes and durations ---------------------------------------------------------------
eq('an hour is 60 minutes', L.wallMinutes('2026-03-01 11:00') - L.wallMinutes('2026-03-01 10:00'), 60);
eq('midnight crosses a day', L.wallMinutes('2026-03-02 00:10') - L.wallMinutes('2026-03-01 23:50'), 20);
eq('a month boundary', L.wallMinutes('2026-04-01 00:00') - L.wallMinutes('2026-03-31 23:00'), 60);
eq('a leap day', L.wallMinutes('2024-03-01 00:00') - L.wallMinutes('2024-02-29 00:00'), 1440);
eq('a malformed time is null', L.wallMinutes('nonsense'), null);
eq('hours and minutes', L.untilText('2026-03-01 09:00', '2026-03-01 12:12'), 'in 3h 12m');
eq('minutes alone', L.untilText('2026-03-01 09:00', '2026-03-01 09:47'), 'in 47m');
eq('a whole hour drops the zero', L.untilText('2026-03-01 09:00', '2026-03-01 11:00'), 'in 2h');
eq('the same minute is now', L.untilText('2026-03-01 09:00', '2026-03-01 09:00'), 'now');
// Never render a negative countdown.
eq('a past tide is clamped, not negative', L.untilText('2026-03-01 12:00', '2026-03-01 09:00'), 'now');

// --- next tide, against Python's answer ------------------------------------------------
for (const st of facts.stations) {
  const rows = L.parseRows(load(st.id, 'hilo'));
  const tag = st.name;
  eq(`${tag}: row count matches Python`, rows.length, st.hilo_rows);
  eq(`${tag}: first row matches Python`, rows[0], st.first);
  eq(`${tag}: last row matches Python`, rows[rows.length - 1], st.last);

  const { next, prev } = L.nextTide(rows, st.probe);
  eq(`${tag}: next tide matches Python`, next, st.next);
  eq(`${tag}: previous tide matches Python`, prev, st.prev);
  ok(`${tag}: the next tide is not before the probe`, !next || next.t >= st.probe);
  // The boundary: a tide happening at this very minute IS the next one, not the previous.
  // A mutant using `>` instead of `>=` survived until this existed, because no fixture
  // tide falls exactly on the probe minute.
  const exact = L.nextTide(rows, rows[1].t);
  eq(`${tag}: a tide at this exact minute is next`, exact.next, rows[1]);
  eq(`${tag}: and the one before it is previous`, exact.prev, rows[0]);
  ok(`${tag}: the previous tide is before the probe`, !prev || prev.t < st.probe);

  const days = L.groupByDay(rows);
  eq(`${tag}: day count matches Python`, days.length, st.days.length);
  for (let i = 0; i < days.length; i++) {
    eq(`${tag} ${st.days[i].date}: tides that day`, days[i].tides.length, st.days[i].count);
    if (st.days[i].range_ft === null) eq(`${tag} ${st.days[i].date}: no range`, days[i].range, null);
    else near(`${tag} ${st.days[i].date}: range`, days[i].range, st.days[i].range_ft, 1e-9);
  }
}

// Pensacola is DIURNAL — one high and one low a day. A page that assumes four tides a day
// is wrong there, so the fixture pins it.
const pens = facts.stations.find((s) => s.id === '8729840');
ok('Pensacola really is diurnal in the fixture', pens.days.every((d) => d.count <= 2), JSON.stringify(pens.days.map((d) => d.count)));

// --- the curve, scored against NOAA's harmonic hourly series ------------------------------
for (const st of facts.stations) {
  if (!st.curve_error) continue;
  const hilo = L.parseRows(load(st.id, 'hilo'));
  const hourly = L.parseHourly(load(st.id, 'h'));
  ok(`${st.name}: hourly rows present`, hourly.length === st.hourly_rows);
  // The JS interpolation, sampled at NOAA's own hourly instants, must reproduce the error
  // Python measured. Same approximation, two languages.
  let worst = 0, sum = 0, n = 0;
  for (const h of hourly) {
    const m = L.wallMinutes(h.t);
    for (let i = 0; i < hilo.length - 1; i++) {
      const am = L.wallMinutes(hilo[i].t), bm = L.wallMinutes(hilo[i + 1].t);
      if (am <= m && m <= bm && bm > am) {
        const got = L.between(hilo[i], hilo[i + 1], (m - am) / (bm - am));
        worst = Math.max(worst, Math.abs(got - h.v)); sum += Math.abs(got - h.v); n++;
        break;
      }
    }
  }
  eq(`${st.name}: curve samples match Python's count`, n, st.curve_error.n);
  near(`${st.name}: worst curve error matches Python`, worst, st.curve_error.max_ft, 5e-4);
  near(`${st.name}: mean curve error matches Python`, sum / n, st.curve_error.mean_ft, 5e-4);
}
// The measured fact that justifies preferring the hourly series: Anchorage is the bad case.
const anch = facts.stations.find((s) => s.id === '9455920');
ok('Anchorage interpolation really is poor (why hourly wins)', anch.curve_error.max_ft > 3,
  String(anch.curve_error.max_ft));
const sf = facts.stations.find((s) => s.id === '9414290');
ok('San Francisco interpolation is good', sf.curve_error.max_ft < 0.5, String(sf.curve_error.max_ft));
// A subordinate station has no hourly series, so the fallback must stay.
const sub = facts.stations.find((s) => s.id === '9501801');
eq('a subordinate station has no hourly rows', sub.hourly_rows, 0);
eq('and no curve error could be scored', sub.curve_error, null);

// A day with only one kind of tide has no range to report. Found by a surviving mutant:
// every day in the fixture has both a high and a low, so the guard was never reached.
// STRICT null, not eq: JSON.stringify(-Infinity) is "null", so comparing serialised forms
// let a mutant that dropped this guard pass. Math.max of nothing is -Infinity, and that is
// exactly what the guard exists to prevent reaching the page.
ok('a day of highs alone has no range', L.rangeOf([
  { t: '2026-03-01 05:00', v: 3, type: 'H' }, { t: '2026-03-01 17:00', v: 4, type: 'H' },
]) === null, String(L.rangeOf([{ t: 'x', v: 3, type: 'H' }])));
ok('a day of lows alone has no range',
  L.rangeOf([{ t: '2026-03-01 05:00', v: 1, type: 'L' }]) === null);
ok('no tides at all have no range', L.rangeOf([]) === null);
near('highest high minus lowest low', L.rangeOf([
  { t: '2026-03-01 02:00', v: 5, type: 'H' }, { t: '2026-03-01 08:00', v: -1, type: 'L' },
  { t: '2026-03-01 14:00', v: 7, type: 'H' }, { t: '2026-03-01 20:00', v: 0.5, type: 'L' },
]), 8, 1e-12);
ok('groupByDay carries that null through', L.groupByDay([
  { t: '2026-03-01 05:00', v: 3, type: 'H' },
])[0].range === null);

// --- curve mechanics -----------------------------------------------------------------------
const lo = { t: '2026-03-01 06:00', v: 0 }, hi = { t: '2026-03-01 12:00', v: 10 };
near('the curve touches the low exactly', L.between(lo, hi, 0), 0, 1e-12);
near('the curve touches the high exactly', L.between(lo, hi, 1), 10, 1e-12);
near('half way is half the range', L.between(lo, hi, 0.5), 5, 1e-12);
ok('the curve is monotone between extremes', (() => {
  let p = -Infinity;
  for (let i = 0; i <= 20; i++) { const v = L.between(lo, hi, i / 20); if (v < p - 1e-12) return false; p = v; }
  return true;
})());
eq('a fraction outside [0,1] is clamped', [L.between(lo, hi, -3), L.between(lo, hi, 4)], [0, 10]);
eq('one tide defines no curve', L.curve([{ t: '2026-03-01 06:00', v: 1, type: 'L' }]), []);
eq('no tides define no curve', L.curve([]), []);
const c = L.curve(L.parseRows(load('9414290', 'hilo')), 50);
eq('the curve has the requested number of samples', c.length, 50);
ok('curve samples increase in time', c.every((p, i) => i === 0 || p.m > c[i - 1].m));
eq('hourly curve points are sorted and numeric', (() => {
  const pts = L.curveFromHourly([{ t: '2026-03-01 02:00', v: 2 }, { t: '2026-03-01 01:00', v: 1 }]);
  return [pts.length, pts[0].v, pts[1].v];
})(), [2, 1, 2]);

// --- phase ------------------------------------------------------------------------------------
near('phase at the start', L.phase(lo, hi, '2026-03-01 06:00'), 0, 1e-12);
near('phase at the end', L.phase(lo, hi, '2026-03-01 12:00'), 1, 1e-12);
near('phase in the middle', L.phase(lo, hi, '2026-03-01 09:00'), 0.5, 1e-12);
eq('phase needs both ends', [L.phase(null, hi, '2026-03-01 09:00'), L.phase(lo, null, '2026-03-01 09:00')], [null, null]);
eq('phase is clamped to [0,1]', [L.phase(lo, hi, '2026-03-01 03:00'), L.phase(lo, hi, '2026-03-01 23:00')], [0, 1]);

// --- stations ------------------------------------------------------------------------------------
const shipped = JSON.parse(readFileSync(here(pick('data/stations.json', '../site/data/stations.json')), 'utf8')).stations;
ok('3,400+ stations ship', shipped.length > 3400, String(shipped.length));
ok('every station has an id, name, coords and a zone', shipped.every((s) =>
  s.id && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.tz));
ok('no station sits at 0,0', shipped.every((s) => !(s.lat === 0 && s.lng === 0)));
ok('every zone is one Intl accepts', shipped.every((s) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: s.tz }); return true; } catch { return false; }
}));
ok('station ids are unique', new Set(shipped.map((s) => s.id)).size === shipped.length);
// Known distances, so "nearest" is checked against geography and not just against itself.
near('SF to LA is about 560 km', L.distanceKm(37.7749, -122.4194, 34.0522, -118.2437), 559, 3);
near('the same point is 0 km', L.distanceKm(10, 20, 10, 20), 0, 1e-9);
near('a degree of latitude is ~111 km', L.distanceKm(0, 0, 1, 0), 111.19, 0.05);
const nearSF = L.nearest(shipped, 37.8063, -122.4659, 5);
eq('nearest to the SF gauge is the SF gauge', nearSF[0].id, '9414290');
near('and it is ~0 km away', nearSF[0].km, 0, 1);
ok('nearest comes back in distance order', nearSF.every((s, i) => i === 0 || s.km >= nearSF[i - 1].km));
eq('nearest respects the limit', L.nearest(shipped, 37.8, -122.4, 3).length, 3);
eq('bad coordinates give nothing', L.nearest(shipped, NaN, -122.4, 3), []);
// Three elements, out of order: a two-element array only compares one pair and would let a
// broken comparator pass.
eq('ordering holds for three', L.nearest([
  { id: 'c', name: 'c', region: 'r', lat: 3, lng: 0, tz: 'UTC' },
  { id: 'a', name: 'a', region: 'r', lat: 1, lng: 0, tz: 'UTC' },
  { id: 'b', name: 'b', region: 'r', lat: 2, lng: 0, tz: 'UTC' },
], 0, 0, 3).map((s) => s.id), ['a', 'b', 'c']);

// --- search ---------------------------------------------------------------------------------------
eq('folding strips accents and case', L.fold('Cañaveral  Hárbor'), 'canaveral harbor');
eq('an empty query finds nothing', L.search(shipped, '   '), []);
ok('searching finds San Francisco', L.search(shipped, 'san francisco').some((s) => s.id === '9414290'));
ok('an accentless query still matches', L.search(shipped, 'canaveral').length > 0);
ok('a prefix match outranks a mid-word one', (() => {
  const r = L.search(shipped, 'boston');
  return r.length > 0 && L.fold(r[0].name).startsWith('boston');
})());
ok('a station id finds its station', L.search(shipped, '9414290').some((s) => s.id === '9414290'));
eq('search respects the limit', L.search(shipped, 'bay', 7).length, 7);

// --- formatting -------------------------------------------------------------------------------------
eq('morning', L.clockText('2026-03-01 06:01'), '6:01 am');
eq('afternoon', L.clockText('2026-03-01 19:02'), '7:02 pm');
eq('noon is 12 pm', L.clockText('2026-03-01 12:00'), '12:00 pm');
eq('midnight is 12 am', L.clockText('2026-03-01 00:00'), '12:00 am');
eq('a malformed time formats to nothing', L.clockText('oops'), '');
eq('a height', L.heightText(6.646), '6.6 ft');
eq('a negative height uses a real minus sign', L.heightText(-1.044), '−1.0 ft');
eq('zero is not negative zero', L.heightText(0), '0.0 ft');
eq('metres if asked', L.heightText(2.03, 'm'), '2.0 m');

// --- the month's best low tides, in daylight ------------------------------------------------------
// Sun times pinned to the Daylight site's sun-logic.js (itself checked against NOAA's solar
// calculator) at the minute; Honolulu's 5:50/7:16 solstice is also the published almanac value.
eq('San Francisco sunrise/sunset', L.sunWall('2026-10-27', 37.8063, -122.4659, 'America/Los_Angeles'),
  { rise: '2026-10-27 07:30', set: '2026-10-27 18:16', polar: null });
eq('Honolulu solstice', L.sunWall('2026-06-21', 21.3067, -157.867, 'Pacific/Honolulu'),
  { rise: '2026-06-21 05:50', set: '2026-06-21 19:16', polar: null });
eq('New York on the DST day', L.sunWall('2026-03-08', 40.7, -74.01, 'America/New_York'),
  { rise: '2026-03-08 07:18', set: '2026-03-08 18:55', polar: null });
eq('Utqiagvik midwinter is polar night', L.sunWall('2026-12-21', 71.29, -156.79, 'America/Anchorage').polar, 'night');
eq('Utqiagvik midsummer is polar day', L.sunWall('2026-06-21', 71.29, -156.79, 'America/Anchorage').polar, 'day');
{
  const sf = { lat: 37.8063, lng: -122.4659, tz: 'America/Los_Angeles' };
  const r = (t, v, type = 'L') => ({ t, v, type });
  const rows = [
    r('2026-10-27 03:10', -1.9),          // lowest, but in the dark
    r('2026-10-27 07:40', -0.3),          // just after sunrise
    r('2026-10-27 07:20', -1.5),          // just before sunrise: dark
    r('2026-10-28 18:10', 0.4),           // just before sunset
    r('2026-10-28 18:30', -1.2),          // just after sunset: dark
    r('2026-10-29 12:00', 6.1, 'H'),      // a high, however placed
    r('2026-10-30 12:00', -0.3),          // ties the 07:40 low on height
    r('2026-10-31 13:00', 1.0),
    r('2026-10-26 12:00', -2.5),          // the past
  ].sort((a, b) => (a.t < b.t ? -1 : 1));
  const got = L.daylightLows(rows, sf, '2026-10-27 00:00', 3);
  eq('daylight lows: dark, high and past tides excluded, lowest first, tie earliest first', got,
    [r('2026-10-27 07:40', -0.3), r('2026-10-30 12:00', -0.3), r('2026-10-28 18:10', 0.4)]);
  eq('daylight lows respect the limit', L.daylightLows(rows, sf, '2026-10-27 00:00', 1).length, 1);
  eq('a daylight high is not a low', L.daylightLows([r('2026-10-27 12:00', -3, 'H')], sf, '2026-10-27 00:00'), []);
  eq('a low at now still counts', L.daylightLows([r('2026-10-27 12:00', 1)], sf, '2026-10-27 12:00').length, 1);
  const north = { lat: 71.29, lng: -156.79, tz: 'America/Anchorage' };
  eq('polar day: a midnight low is in daylight', L.daylightLows([r('2026-06-21 00:30', 0.2)], north, '2026-06-20 00:00').length, 1);
  eq('polar night: no low is in daylight', L.daylightLows([r('2026-12-21 12:00', 0.2)], north, '2026-12-20 00:00').length, 0);
}

// --- what the water is doing now, against Python's answer --------------------------------
for (const g of facts.gauges) {
  const obs = L.parseObserved(load(g.id, 'water_level'));
  const pred = L.parseHourly(load(g.id, 'predictions'));
  const d = L.departure(obs, pred);
  eq(`gauge ${g.id}: latest paired reading matches Python`, [d.t, d.v, d.predicted, d.n], [g.t, g.v, g.predicted, g.n]);
  near(`gauge ${g.id}: departure matches Python`, d.diff, g.diff, 1e-9);
  eq(`gauge ${g.id}: temperature matches Python`, L.parseTemp(load(g.id, 'water_temperature')), g.temp);
}
{
  const sf = facts.gauges.find((g) => g.id === '9414290');
  ok('SF was running high on Oct 20 (the fixture is not a calm one)', sf.diff > 1);
  eq('a sensor that is down reads null, not zero', L.parseTemp({ error: { message: 'No data was found.' } }), null);
  const o = (t, v) => ({ t, v });
  // NOAA writes a missing reading as v:"" and Number("") is 0: a gap must not become datum.
  eq('a blank reading is dropped, not read as 0 ft', L.parseObserved({ data: [{ t: '2026-10-20 00:00', v: '' }, { t: '2026-10-20 00:06', v: ' ' }, { t: '2026-10-20 00:12', v: 'x' }, { t: '2026-10-20 00:18', v: '1.5' }] }), [o('2026-10-20 00:18', 1.5)]);
  eq('a reading at a malformed time is dropped', L.parseObserved({ data: [{ t: '20 Oct 00:00', v: '1' }] }), []);
  eq('observed rows come out in time order', L.parseObserved({ data: [{ t: '2026-10-20 00:06', v: '2' }, { t: '2026-10-20 00:00', v: '1' }, { t: '2026-10-20 00:12', v: '3' }] }).map((r) => r.t), ['2026-10-20 00:00', '2026-10-20 00:06', '2026-10-20 00:12']);
  // Departure: only readings with a prediction at the same minute count, the latest `span`.
  const pr = [o('00:00', 1), o('00:06', 1), o('00:12', 1), o('00:18', 1)];
  const ob = [o('00:00', 9), o('00:06', 2), o('00:12', 3), o('00:15', 50), o('00:24', 50)];
  const d = L.departure(ob, pr, 2);
  eq('departure: unpaired readings ignored, last span averaged', [d.t, d.v, d.predicted, d.n, d.diff], ['00:12', 3, 1, 2, 1.5]);
  eq('departure: a gauge with no paired reading is null, not zero', L.departure([o('00:03', 1)], pr), null);
  eq('departure: the latest reading is reported, not the first', L.departure(ob, pr).t, '00:12');
  near('departure: below is negative', L.departure([o('00:00', 0.5)], pr).diff, -0.5, 1e-12);
  eq('words: calm', L.departureText(0.2), 'about as predicted');
  eq('words: calm below', L.departureText(-0.24), 'about as predicted');
  eq('words: just over calm', L.departureText(0.25), '0.3 ft above the prediction');
  eq('words: above', L.departureText(1.16), '1.2 ft above the prediction');
  eq('words: below', L.departureText(-0.6), '0.6 ft below the prediction');
  eq('words: no number, no words', L.departureText(NaN), '');
  // Which gauge to read.
  const st = (id, lat, lng, g) => ({ id, lat, lng, ...(g ? { g: 1 } : {}) });
  const gs = [st('A', 37.0, -122.0, 1), st('B', 37.2, -122.0, 1), st('C', 38.0, -122.0, 1)];
  eq('a gauge station reads itself', L.gaugeFor(st('B', 37.2, -122.0, 1), gs).id, 'B');
  eq('a gauge station reads itself even off the list', L.gaugeFor(st('D', 37.01, -122.0, 1), gs).id, 'D');
  eq('a gauge station is 0 km from itself', L.gaugeFor(st('B', 37.2, -122.0, 1), gs).km, 0);
  eq('a station without one reads the nearest', L.gaugeFor(st('X', 37.15, -122.0), gs).id, 'B');
  eq('nearest, from the other side', L.gaugeFor(st('X', 37.05, -122.0), gs).id, 'A');
  near('and says how far', L.gaugeFor(st('X', 37.15, -122.0), gs).km, 5.56, 0.05);
  eq('no gauge within reach is null, not a far one', L.gaugeFor(st('X', 40.0, -122.0), gs), null);
  eq('the reach is 40 km: 39 km counts', L.gaugeFor(st('X', 37.0 - 39 / 111.195, -122.0), gs).id, 'A');
  eq('the reach is 40 km: 41 km does not', L.gaugeFor(st('X', 37.0 - 41 / 111.195, -122.0), gs), null);
  // Against the shipped list: every flagged gauge is a real station, and temperature only on gauges.
  const shipped = JSON.parse(readFileSync(here(pick('./data/stations.json', 'site/data/stations.json')), 'utf8')).stations;
  const flagged = shipped.filter((s) => s.g);
  ok('shipped list carries the gauges (238 on 2026-10-27)', flagged.length >= 200, `got ${flagged.length}`);
  ok('temperature only where there is a gauge', shipped.every((s) => !s.w || s.g));
  ok('San Francisco is a gauge', shipped.find((s) => s.id === '9414290').g === 1);
}

// --- lines bin/mutate found unguarded (2026-10-27) --------------------------------------
//
// `bin/mutate site/tide-logic.js site/tide-logic.test.mjs --sibling test` scored 185/327
// and an output sweep (state/scratch/tide-equiv/sweep.mjs, control 5/5) said 62 of the
// survivors genuinely change what the page answers. These are those lines. Grouped by the
// function they belong to rather than by mutant, because the point is the guarantee.

// parseRows/parseObserved: a null ROW, not merely a malformed one. `!r || typeof r.t` must
// short-circuit; as `&&` it reaches null.t and the whole payload throws.
eq('a null row is dropped, not thrown on', L.parseRows({ predictions: [
  null, { t: '2026-03-01 05:00', v: '1.5', type: 'H' }] }).length, 1);
eq('a row with no time at all is dropped', L.parseRows({ predictions: [{ v: '1.5', type: 'H' }] }), []);
eq('an observed null row is dropped', L.parseObserved({ data: [null, { t: '2026-03-01 05:00', v: '1.5' }] }).length, 1);
eq('an observed blank reading is not a tide at datum', L.parseObserved({ data: [
  { t: '2026-03-01 05:00', v: '' }, { t: '2026-03-01 05:06', v: '   ' }] }), []);

// nextTide past the end: the loop must stop AT rows.length (one past is undefined.t), and
// say index -1 rather than 0, which a caller would read as "the first tide".
{
  const rows = L.parseRows(load('9414290', 'hilo'));
  const past = L.nextTide(rows, '2999-01-01 00:00');
  eq('after the last tide there is no next', past.next, null);
  eq('and the previous one is the last row', past.prev.t, rows[rows.length - 1].t);
  eq('and the index says "none", not "the first"', past.index, -1);
  const first = L.nextTide(rows, '1900-01-01 00:00');
  eq('before the first tide there is no previous', first.prev, null);
  eq('and the index is the first row', first.index, 0);
}

// dayOf must take exactly the date, not a character of the time.
eq('a day is ten characters, not eleven', L.dayOf('2026-03-01 06:01'), '2026-03-01');

// untilText needs BOTH times; as `&&` one bad argument yields "in NaNm".
eq('one unparseable time gives no countdown', [
  L.untilText('2026-03-01 06:00', 'oops'), L.untilText('oops', '2026-03-01 06:00')], ['', '']);
eq('a whole number of hours drops the minutes', L.untilText('2026-03-01 06:00', '2026-03-01 08:00'), 'in 2h');
eq('under an hour is minutes only', L.untilText('2026-03-01 06:00', '2026-03-01 06:47'), 'in 47m');
eq('the same minute is "now"', L.untilText('2026-03-01 06:00', '2026-03-01 06:00'), 'now');

// phase: an unparseable `now`, and two tides that do not straddle anything.
eq('phase needs a readable now', L.phase(lo, hi, 'oops'), null);
eq('phase of a zero-length stretch is nothing', L.phase(lo, lo, '2026-03-01 06:00'), null);
eq('phase of a backwards stretch is nothing', L.phase(hi, lo, '2026-03-01 09:00'), null);

// curve: the shape of the sampling itself. Two rows are enough for a curve; fewer than two
// samples is not a curve; and the samples must START and END on the real extremes, which is
// what makes the drawn line touch the plotted highs and lows.
{
  const two = [{ t: '2026-03-01 06:00', v: 0, type: 'L' }, { t: '2026-03-01 12:00', v: 10, type: 'H' }];
  eq('two tides are enough for a curve', L.curve(two, 2).length, 2);
  eq('fewer than two samples is not a curve', [L.curve(two, 1), L.curve(two, 0), L.curve(two, -5)], [[], [], []]);
  eq('the default is 240 samples', L.curve(two).length, 240);
  const c2 = L.curve(two, 2);
  eq('the first sample sits on the first tide', [c2[0].m, c2[0].v], [L.wallMinutes(two[0].t), 0]);
  eq('the last sample sits on the last tide', [c2[1].m, c2[1].v], [L.wallMinutes(two[1].t), 10]);

  // Three tides, sampled so one lands exactly on the middle extreme: the walk to the next
  // segment has to happen, and happen at the right row.
  const three = [
    { t: '2026-03-01 06:00', v: 0, type: 'L' },
    { t: '2026-03-01 12:00', v: 10, type: 'H' },
    { t: '2026-03-01 18:00', v: 2, type: 'L' },
  ];
  const c3 = L.curve(three, 3);
  eq('a three-tide curve touches all three', c3.map((p) => +p.v.toFixed(9)), [0, 10, 2]);
  eq('and its samples are the three tide times', c3.map((p) => p.m), three.map((r) => L.wallMinutes(r.t)));
  ok('a sample inside the second segment follows the second pair', (() => {
    const c = L.curve(three, 5);                       // samples at 06, 09, 12, 15, 18
    const want = L.between(three[1], three[2], 0.5);    // 15:00 is half way through pair 2
    return Math.abs(c[3].v - want) < 1e-9;
  })());
  eq('a curve over rows that share one minute is empty', L.curve([
    { t: '2026-03-01 06:00', v: 0, type: 'L' }, { t: '2026-03-01 06:00', v: 1, type: 'H' }], 5), []);
}

// distanceKm: pin the earth's radius itself. Half the equator is pi*R, so this fixes R to
// the metre; the "about 560 km" check above tolerates 3 km and cannot.
near('half way round the world is pi times the radius', L.distanceKm(0, 0, 0, 180), Math.PI * 6371, 1e-6);

// nearest: asking for none must give none, not one.
eq('nearest with a limit of zero is empty', L.nearest(shipped, 37.8, -122.4, 0), []);
eq('a negative limit is empty too', L.nearest(shipped, 37.8, -122.4, -3), []);

// gaugeFor: the two guarantees the shipped gauge block rests on and nothing covered --
// the exact edge of the reach, and that NEARNESS beats the id tie-break. A gauge list is
// built so the nearer gauge has the LARGER id: if the tie-break's `&&` ever becomes `||`,
// or `===` becomes `!==`, the page reads a gauge that is not the closest one.
{
  const g = (id, lat, lng) => ({ id, lat, lng, name: id, region: 'r', state: 'X', tz: 'UTC', g: 1 });
  const here0 = { id: 'HERE', lat: 37.1, lng: -122.0, tz: 'UTC' };
  const far = g('A', 37.1, -122.5), near0 = g('Z', 37.1, -122.1);
  eq('the nearer gauge wins even with the later id', L.gaugeFor(here0, [far, near0]).id, 'Z');
  eq('and in the other input order', L.gaugeFor(here0, [near0, far]).id, 'Z');
  // Exactly equidistant, three of them handed over in the wrong order: a two-gauge tie
  // compares one pair and would let a broken tie-break through.
  const tie = [g('M', 37.1, -121.9), g('A', 37.1, -122.1), g('Z', 37.1, -121.9)];
  eq('an exact tie is broken by the lower id', L.gaugeFor(here0, tie).id, 'A');
  eq('the tie-break does not depend on input order', L.gaugeFor(here0, [...tie].reverse()).id, 'A');
  // The reach is inclusive at its exact edge, which 39/41 km cannot show.
  const d = L.distanceKm(here0.lat, here0.lng, far.lat, far.lng);
  eq('a gauge exactly at the reach counts', L.gaugeFor(here0, [far], d).id, 'A');
  ok('a hair beyond it does not', L.gaugeFor(here0, [far], d - 1e-9) === null);
  eq('no gauges at all is null', L.gaugeFor(here0, []), null);
  eq('no station is null', L.gaugeFor(null, [near0]), null);
}

// search: the four ranks, in the wrong input order, on a list built for it. Done against
// synthetic stations so each branch is reached on purpose rather than by luck.
{
  const st = (id, name, region) => ({ id, name, region, lat: 1, lng: 1, tz: 'UTC' });
  const list = [
    st('555', 'Nowhere', 'Bayview County'),      // rank 2: region only
    st('bay777', 'Nowhere Else', 'Nowhere'),     // rank 3: id prefix only
    st('111', 'Old Bay Light', 'Nowhere'),       // rank 1: mid-name
    st('222', 'Bay Harbor', 'Nowhere'),          // rank 0: name prefix
  ];
  eq('ranks: name-prefix, mid-name, region, then bare id',
    L.search(list, 'bay').map((s) => s.id), ['222', '111', '555', 'bay777']);
  // Same rank, three of them, handed over in reverse: the name tie-break must sort them.
  const same = [st('1', 'Bay Charlie', 'r'), st('2', 'Bay Bravo', 'r'), st('3', 'Bay Alpha', 'r')];
  eq('equal ranks are ordered by name', L.search(same, 'bay').map((s) => s.id), ['3', '2', '1']);
  // Rank must BEAT alphabetical order, or a collapsed rank reads as correct: the two are
  // only distinguishable when they disagree. 'Bay Zulu' is a name-prefix match that sorts
  // after 'Abraham Bay', a mid-name one, so rank has to be what decides.
  const fight = [
    st('mid', 'Abraham Bay', 'Nowhere'),
    st('pre', 'Bay Zulu', 'Nowhere'),
    st('reg', 'Nowhere', 'Bayside'),
  ];
  eq('a name-prefix match outranks an earlier-sorting mid-name one',
    L.search(fight, 'bay').map((s) => s.id), ['pre', 'mid', 'reg']);
  // And on the shipped list, which is what the reader types into: every hit on the first
  // page of a common word must be a real name-prefix match.
  ok('the first page of "bay" is all name-prefix matches', (() => {
    const r = L.search(shipped, 'bay', 10);
    return r.length === 10 && r.every((x) => L.fold(x.name).startsWith('bay'));
  })());
  // 21 stations in the shipped list share a folded name with another. Equal rank and equal
  // name must keep the order they came in: an inconsistent comparator reverses them.
  const same3 = [st('3', 'Bay Point', 'r'), st('1', 'Bay Point', 'r'), st('2', 'Bay Point', 'r')];
  eq('stations sharing a name keep their input order',
    L.search(same3, 'bay').map((x) => x.id), ['3', '1', '2']);
  const many = Array.from({ length: 30 }, (_, i) => st('id' + i, 'Bay Same', 'r'));
  eq('and still do past the length where the sort changes strategy',
    L.search(many, 'bay', 30).map((x) => x.id), many.map((x) => x.id));
  // A match one character into the name is still a mid-name match, not a region or id one.
  // Reachable by typing a word short of its first letter ('akland' for Oakland).
  eq('a match at the second character ranks as mid-name',
    L.search([st('x', 'Oakland Pier', 'Nowhere'), st('y', 'Nowhere', 'Akland County')], 'akland')
      .map((z) => z.id), ['x', 'y']);
  eq('a limit of zero finds nothing', L.search(list, 'bay', 0), []);
  eq('a station matched only by its id still comes back', L.search(list, 'bay777').map((s) => s.id), ['bay777']);
  eq('nothing matches nothing', L.search(list, 'zzz'), []);
}

// daylightLows: asking for none must give none. `n > 0 ? n : 0` guards a negative limit,
// and slice(0, 1) would hand the page a tide it did not ask for.
{
  const sf2 = { lat: 37.8063, lng: -122.4659, tz: 'America/Los_Angeles' };
  const low = [{ t: '2026-10-27 12:00', v: 1, type: 'L' }];
  eq('no lows asked for, none given', [
    L.daylightLows(low, sf2, '2026-10-27 00:00', 0),
    L.daylightLows(low, sf2, '2026-10-27 00:00', -4)], [[], []]);
}

// --- the sun, against Python's own implementation ----------------------------------------
//
// sunWall decides which low tides the month list shows, and three hand-pinned days left
// the solar coefficients unguarded: 24 mutants of them changed the page's answer and the
// suite passed every one. test/facts.py now recomputes sunrise and sunset in Python over a
// grid of places and dates -- the same published NOAA algorithm, every coefficient and sign
// transcribed separately, which is the class of fault that survived -- and anchors itself
// to NOAA's solar calculator at the three days above (facts.py asserts those anchors when
// it writes the file, so this grid cannot drift away from an outside source unnoticed).
eq('the sun reference carries its outside anchors', facts.sun_anchors.length, 3);
ok('the sun grid spans the year and both polar cases',
  facts.sun.length >= 90 && facts.sun.some((r) => r.polar === 'day') && facts.sun.some((r) => r.polar === 'night'),
  `${facts.sun.length} place-days`);
{
  let agree = 0;
  const wrong = [];
  for (const r of facts.sun) {
    const got = L.sunWall(r.date, r.lat, r.lng, r.tz);
    if (got.rise === r.rise && got.set === r.set && got.polar === r.polar) agree++;
    else if (wrong.length < 4) wrong.push(`${r.place} ${r.date}: ${JSON.stringify(got)} vs ${r.rise}/${r.set}/${r.polar}`);
  }
  ok(`sunrise and sunset agree with Python at every place-day (${facts.sun.length})`,
    agree === facts.sun.length, wrong.join(' | '));
}

// --- tidal currents (tide-currents) -------------------------------------------------------
for (const st of facts.currents) {
  const rows = L.parseCurrents(load(st.id, 'currents'));
  eq(`currents at ${st.id} read as Python reads them`, rows, st.rows);
  for (const [now, want] of Object.entries(st.next)) {
    eq(`next slack/flood/ebb at ${st.id} from ${now}`, L.nextCurrents(rows, now), want);
  }
}
{
  const gg = facts.currents[0].rows;
  ok('the fixture has all three kinds', ['slack', 'flood', 'ebb'].every((k) => gg.some((r) => r.type === k)));
  ok('an ebb speed is positive', gg.filter((r) => r.type === 'ebb').every((r) => r.kn > 0));
  const row = (o) => ({ current_predictions: { cp: [o] } });
  const good = { Type: 'flood', Time: '2026-03-01 05:00', Velocity_Major: 2.5, meanFloodDir: 61, meanEbbDir: 239 };
  eq('a good flood row', L.parseCurrents(row(good)), [{ t: '2026-03-01 05:00', type: 'flood', kn: 2.5, dir: 61 }]);
  eq('an ebb runs toward the ebb heading, unsigned',
    L.parseCurrents(row({ ...good, Type: 'ebb', Velocity_Major: -1.85 })), [{ t: '2026-03-01 05:00', type: 'ebb', kn: 1.85, dir: 239 }]);
  eq('slack has no heading', L.parseCurrents(row({ ...good, Type: 'slack', Velocity_Major: -0.01 }))[0].dir, null);
  eq('an unknown type is dropped', L.parseCurrents(row({ ...good, Type: 'max' })), []);
  eq('a bad time is dropped', L.parseCurrents(row({ ...good, Time: '2026-03-01T05:00' })), []);
  eq('a missing speed is dropped, not read as slack', L.parseCurrents(row({ ...good, Velocity_Major: null })), []);
  eq('a non-numeric speed is dropped', L.parseCurrents(row({ ...good, Velocity_Major: 'x' })), []);
  eq('an error payload is no rows', L.parseCurrents({ error: { message: 'Currents predictions are not available' } }), []);
  eq('no payload is no rows', L.parseCurrents(null), []);
  eq('three rows out of order come back in order', L.parseCurrents({ current_predictions: { cp: [
    { ...good, Time: '2026-03-01 09:00' }, { ...good, Time: '2026-03-01 01:00' }, { ...good, Time: '2026-03-01 05:00' },
  ] } }).map((r) => r.t), ['2026-03-01 01:00', '2026-03-01 05:00', '2026-03-01 09:00']);
  const n = L.nextCurrents([{ t: '2026-03-01 05:00', type: 'slack' }], '2026-03-01 05:00');
  ok('a slack at now still counts as next', n.slack && n.slack.t === '2026-03-01 05:00');
  eq('nothing after now is null', L.nextCurrents([{ t: '2026-03-01 05:00', type: 'slack' }], '2026-03-01 06:00').slack, null);

  const c = (id, lat, lng) => ({ id, name: id, lat, lng });
  const cs = [c('FAR', 37.5, -122.0), c('B', 37.05, -122.0), c('A', 37.1, -122.0)];
  const tideSt = { lat: 37.0, lng: -122.0 };
  eq('the nearest current station wins', L.currentFor(tideSt, cs).id, 'B');
  ok('it carries its distance', Math.abs(L.currentFor(tideSt, cs).km - 5.56) < 0.05);
  eq('none within 15 km is none', L.currentFor({ lat: 30, lng: -122 }, cs), null);
  eq('15 km is the default bar', L.currentFor(tideSt, [c('E', 37.14, -122.0)]), null);
  eq('a tie goes to the lower id', L.currentFor(tideSt, [c('Z', 37.05, -122.0), c('Y', 37.05, -122.0)]).id, 'Y');
  eq('no station, no current', L.currentFor(null, cs), null);

  eq('0 degrees is N', L.compass(0), 'N');
  eq('61 degrees is ENE', L.compass(61), 'ENE');
  eq('239 degrees is WSW', L.compass(239), 'WSW');
  eq('225 degrees is SW', L.compass(225), 'SW');
  eq('350 degrees is N', L.compass(350), 'N');
  eq('348 degrees is NNW', L.compass(348), 'NNW');
  eq('no heading is blank', L.compass(null), '');
}

{
  const tides = [{ t: '2026-03-01 04:00', v: 5, type: 'H' }, { t: '2026-03-01 10:00', v: 1, type: 'L' }, { t: '2026-03-01 16:00', v: 5, type: 'H' }];
  const o = L.slackOffset({ t: '2026-03-01 10:38' }, tides);
  eq('slack 38 min after the low', [o.min, o.tide.type], [38, 'L']);
  eq('slack before a high is negative', L.slackOffset({ t: '2026-03-01 15:10' }, tides).min, -50);
  eq('the nearest tide wins, not the first', L.slackOffset({ t: '2026-03-01 15:00' }, [tides[2], tides[0], tides[1]]).tide.t, '2026-03-01 16:00');
  eq('it crosses midnight', L.slackOffset({ t: '2026-03-02 00:20' }, [{ t: '2026-03-01 23:50', v: 1, type: 'L' }]).min, 30);
  eq('no tides, no offset', L.slackOffset({ t: '2026-03-01 10:38' }, []), null);
  eq('no slack, no offset', L.slackOffset(null, tides), null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
