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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
