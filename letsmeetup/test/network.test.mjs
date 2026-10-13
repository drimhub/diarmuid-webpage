import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { anchorsHash, createNetwork, encodeMinutes, decodeMinutes, makeTable, loadTransitTable, WALK_ONLY, UNREACHABLE, MAX_MINUTES } from '../src/calc/network.js';
import { generateCandidateAreas } from '../src/calc/candidates.js';
import { computeSuggestions } from '../src/calc/index.js';
import { DEFAULTS } from '../src/calc/config.js';
import { haversineKm } from '../src/calc/geo.js';
import { compactJourneys, strippedMinutes, tableValue } from '../scripts/lib/tfl-journey.mjs';
import { createFakePlaces, createFakeRouting } from '../testing/fake-providers.mjs';

const dataUrl = new URL('../src/data/transit-times.json', import.meta.url);
const areas = JSON.parse(readFileSync(new URL('../public/areas.json', import.meta.url), 'utf8'));
const area = (id) => areas.find((a) => a.id === id);
const origin = (id, areaId, mode = 'transit', maxMinutes = null) => ({ id, areaId, lat: area(areaId).lat, lng: area(areaId).lng, mode, maxMinutes });

// A synthetic city: transit minutes grow with distance, except for the pairs given. Symmetric, like the real table.
function syntheticTable(special = {}) {
  const n = areas.length;
  const bytes = new Uint8Array(n * n);
  const idx = new Map(areas.map((a, i) => [a.id, i]));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    bytes[i * n + j] = Math.min(MAX_MINUTES, Math.round(haversineKm(areas[i], areas[j]) * 3.5 + 4));
  }
  for (const [pair, v] of Object.entries(special)) {
    const [a, b] = pair.split('>');
    bytes[idx.get(a) * n + idx.get(b)] = v;
    bytes[idx.get(b) * n + idx.get(a)] = v;
  }
  return makeTable({ areas, bytes, source: 'test', basis: 'synthetic', builtAt: '2026-10-09' });
}
const network = (special) => createNetwork(syntheticTable(special), areas);

// ---------- the table ----------

test('minutes round-trip through base64, including a large matrix', () => {
  const bytes = new Uint8Array(282 * 282).map((_, i) => i % 256);
  assert.deepEqual(decodeMinutes(encodeMinutes(bytes)), bytes);
});

test('a table reads back symmetric, with the sentinels', () => {
  const net = network({ 'stockwell>euston': 12, 'angel>bank': WALK_ONLY, 'acton>abbey-wood': UNREACHABLE });
  assert.equal(net.minutes('stockwell', 'euston'), 12);
  assert.equal(net.minutes('euston', 'stockwell'), 12);
  assert.equal(net.minutes('angel', 'bank'), WALK_ONLY);
  assert.equal(net.minutes('abbey-wood', 'acton'), UNREACHABLE);
  assert.equal(net.minutes('stockwell', 'stockwell'), 0);
  assert.equal(net.minutes('stockwell', 'nowhere'), null);
  assert.ok(WALK_ONLY > MAX_MINUTES && UNREACHABLE > WALK_ONLY);
});

test('a stale, corrupt or empty table is refused (geometry takes over)', () => {
  const good = syntheticTable();
  assert.ok(createNetwork(good, areas));
  const moved = areas.map((a) => (a.id === 'angel' ? { ...a, lat: a.lat + 0.01 } : a));
  assert.equal(createNetwork(good, moved), null, 'an anchor moved');
  assert.equal(createNetwork(good, areas.slice(1)), null, 'an area was removed');
  assert.equal(createNetwork({ ...good, minutes: good.minutes.slice(0, 100) }, areas), null, 'truncated matrix');
  assert.equal(createNetwork({ ...good, minutes: '%%%not base64%%%' }, areas), null);
  assert.equal(createNetwork({ ...good, format: 2 }, areas), null);
  assert.equal(createNetwork(null, areas), null);
  assert.equal(createNetwork({ format: 1, areas: [], minutes: '', anchorsHash: '' }, areas), null);
});

test('the anchors hash ignores order and notices any moved coordinate', () => {
  assert.equal(anchorsHash(areas), anchorsHash([...areas].reverse()));
  assert.notEqual(anchorsHash(areas), anchorsHash(areas.map((a) => (a.id === 'angel' ? { ...a, lng: a.lng + 0.0001 } : a))));
});

test('the bundled table either is not built yet, or matches areas.json (rebuild it if this fails)', () => {
  const json = JSON.parse(readFileSync(dataUrl, 'utf8'));
  if (json.source === null) return; // not built yet: the calculation uses geometry alone
  assert.ok(createNetwork(json, areas), 'areas.json changed since the table was built: run scripts/build-transit-table.mjs');
  assert.ok(loadTransitTable(areas));
  assert.match(json.attribution, /TfL Open Data/);
});

test('the bundled table stays small enough for the Worker bundle', () => {
  assert.ok(statSync(dataUrl).size < 200 * 1024);
});

// ---------- TfL journey parsing (build-time only) ----------

const leg = (mode, from, to) => ({ mode: { id: mode }, departureTime: `2026-10-20T19:${String(from).padStart(2, '0')}:00`, arrivalTime: `2026-10-20T19:${String(to).padStart(2, '0')}:00` });
const body = (...journeys) => ({ journeys: journeys.map((legs) => ({ legs })) });

test('end walks are stripped, interchange walks and waits are kept', () => {
  const j = compactJourneys(body([leg('walking', 0, 9), leg('tube', 9, 19), leg('walking', 21, 24), leg('tube', 26, 40), leg('walking', 40, 49)]));
  assert.equal(strippedMinutes(j[0]), 31); // 19:09 to 19:40: ride, interchange walk and the waits
  assert.equal(tableValue(j), 31);
});

test('bus legs count as transit, so a bus-first journey keeps its bus time', () => {
  const j = compactJourneys(body([leg('walking', 0, 3), leg('bus', 3, 20), leg('tube', 22, 30), leg('walking', 30, 33)]));
  assert.equal(tableValue(j), 27);
});

test('the shortest stripped journey is used, not the shortest overall', () => {
  const j = compactJourneys(body(
    [leg('walking', 0, 20), leg('tube', 20, 30)], // 10 on the network, long first walk
    [leg('walking', 0, 2), leg('tube', 2, 22)],   // 20 on the network
  ));
  assert.equal(tableValue(j), 10);
});

test('a journey with no transit left is walk-only, and no journey is unreachable', () => {
  assert.equal(tableValue(compactJourneys(body([leg('walking', 0, 12)]))), WALK_ONLY);
  assert.equal(tableValue(compactJourneys(body([leg('walking', 0, 12)], [leg('walking', 0, 14)]))), WALK_ONLY);
  assert.equal(tableValue(compactJourneys({ journeys: [] })), UNREACHABLE);
  assert.equal(tableValue(compactJourneys(undefined)), UNREACHABLE);
  assert.equal(tableValue([]), UNREACHABLE);
});

test('values are at least 1 and at most MAX_MINUTES', () => {
  assert.equal(tableValue(compactJourneys(body([leg('walking', 0, 1), leg('tube', 1, 1), leg('walking', 1, 2)]))), 1);
  const long = { journeys: [{ legs: [{ mode: { id: 'tube' }, departureTime: '2026-10-20T01:00:00', arrivalTime: '2026-10-20T09:00:00' }] }] };
  assert.equal(tableValue(compactJourneys(long)), MAX_MINUTES);
});

// ---------- candidates ----------

const ids = (cands) => cands.map((c) => c.area.id);
const EUSTON_FAST = { 'stockwell>euston': 10, 'hampstead>euston': 8 };

test('toy city: the table finds the quick interchange that straight lines miss', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'hampstead')];
  const geometry = generateCandidateAreas(origins, areas, DEFAULTS);
  assert.ok(!ids(geometry).includes('euston'), 'precondition: geometry alone misses Euston');
  const withNet = generateCandidateAreas(origins, areas, DEFAULTS, network(EUSTON_FAST));
  assert.ok(ids(withNet).includes('euston'));
  assert.deepEqual(withNet.find((c) => c.area.id === 'euston').heuristics, ['network']);
  assert.equal(withNet[0].area.id, 'euston', 'and it is the best candidate');
  assert.ok(withNet.length <= DEFAULTS.maxCandidates);
});

test('network candidates fill at most network.candidates slots; geometry fills the rest', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'hampstead')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS, network(EUSTON_FAST));
  assert.ok(c.filter((x) => x.heuristics.includes('network')).length <= DEFAULTS.network.candidates);
  assert.ok(c.some((x) => x.heuristics.some((h) => h !== 'network')), 'geometry still contributes');
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) assert.ok(haversineKm(c[i].area, c[j].area) >= DEFAULTS.candidateSpacingKm);
  assert.deepEqual(c.map((x) => x.score), c.map((x) => x.score).sort((p, q) => p - q));
});

test('no area has duplicate tags, and an area both methods propose keeps both', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'hampstead')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS, network());
  for (const x of c) assert.equal(new Set(x.heuristics).size, x.heuristics.length);
  assert.equal(new Set(ids(c)).size, c.length, 'no area twice');
});

test('no transit travellers: no network candidates, exactly the geometric result', () => {
  const origins = [origin('a', 'stockwell', 'bike'), origin('b', 'hampstead', 'walk')];
  const net = network({ 'stockwell>euston': 1, 'hampstead>euston': 1 });
  assert.deepEqual(generateCandidateAreas(origins, areas, DEFAULTS, net), generateCandidateAreas(origins, areas, DEFAULTS));
});

test('without a table, or with it disabled, geometry alone, exactly as before', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'hampstead')];
  const base = generateCandidateAreas(origins, areas, DEFAULTS);
  assert.deepEqual(generateCandidateAreas(origins, areas, DEFAULTS, null), base);
  const off = { ...DEFAULTS, network: { ...DEFAULTS.network, enabled: false } };
  assert.deepEqual(generateCandidateAreas(origins, areas, off, network({ 'stockwell>euston': 1 })), base);
});

test('a mixed group combines the table (transit) with the estimate (bike)', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'hampstead'), origin('c', 'blackfriars', 'bike')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS, network(EUSTON_FAST));
  const euston = c.find((x) => x.area.id === 'euston');
  assert.ok(euston, 'still found');
  assert.equal(euston.estimate.times[0], DEFAULTS.network.scale * 10 + DEFAULTS.network.offset);
  assert.ok(euston.estimate.times[2] > 5, 'the cyclist uses the straight-line estimate');
});

test('a personal limit prunes network candidates too', () => {
  const origins = [origin('a', 'stockwell', 'transit', 12), origin('b', 'hampstead')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS, network({ 'stockwell>euston': 30, 'hampstead>euston': 5 }));
  const euston = c.find((x) => x.area.id === 'euston');
  assert.ok(!euston || !euston.heuristics.includes('network'), 'Euston is 38 min for a 12 min limit (x1.4 slack)');
});

test('an unreachable pair rules the area out for that person', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'hampstead')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS, network({ 'hampstead>euston': 5, 'stockwell>euston': UNREACHABLE }));
  const euston = c.find((x) => x.area.id === 'euston');
  assert.ok(!euston || !euston.heuristics.includes('network'));
});

test('walk-only pairs use the walking estimate, never zero', () => {
  const origins = [origin('a', 'brixton'), origin('b', 'stockwell')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS, network({ 'brixton>stockwell': WALK_ONLY }));
  const atStockwell = c.find((x) => x.area.id === 'stockwell');
  assert.ok(atStockwell, 'a candidate where one of them already is');
  const walkMin = (haversineKm(area('brixton'), area('stockwell')) * DEFAULTS.estimate.detour / DEFAULTS.estimate.speedKmh.walk) * 60;
  assert.ok(Math.abs(atStockwell.estimate.times[0] - walkMin) < 0.01, `${atStockwell.estimate.times[0]} vs ${walkMin}`);
  assert.ok(atStockwell.estimate.times.every((t) => t > 0));
});

test('two close people and one distant: network candidates serve the distant person', () => {
  const origins = [origin('a', 'brixton'), origin('b', 'stockwell'), origin('c', 'hampstead')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS, network({ 'brixton>stockwell': WALK_ONLY })).filter((x) => x.heuristics.includes('network'));
  assert.ok(c.length >= 2);
  const nearClose = c.filter((x) => haversineKm(x.area, area('stockwell')) < 1.5);
  assert.ok(nearClose.length <= 1, 'not a pile of near-duplicates around the close pair');
  const distant = area('hampstead');
  assert.ok(c.some((x) => haversineKm(x.area, distant) < haversineKm(area('stockwell'), distant) - 2), 'at least one candidate is out towards the distant person');
});

// ---------- the whole calculation ----------

const START = '2026-10-10T18:30:00.000Z';
const trio = () => [
  { id: 'diarmuid', areaId: 'stockwell', mode: 'transit', maxMinutes: null },
  { id: 'cian', areaId: 'blackfriars', mode: 'bike', maxMinutes: null },
  { id: 'friend', areaId: 'hampstead', mode: 'transit', maxMinutes: null },
];
const go = (net) => computeSuggestions({
  event: { eventType: 'drinks', startAt: START, tags: [] }, participants: trio(), areas, providers: { places: createFakePlaces(), routing: createFakeRouting() }, network: net,
});

test('with a table the run succeeds, includes network candidates, and costs the same per run', async () => {
  const without = await go(null);
  const withNet = await go(network({ ...EUSTON_FAST, 'blackfriars>euston': 20 }));
  assert.equal(withNet.status, 'ok');
  assert.ok(withNet.candidates.some((c) => c.heuristics.includes('network')));
  assert.ok(withNet.candidates.length <= DEFAULTS.maxCandidates);
  assert.equal(withNet.cost.routing.requests, without.cost.routing.requests);
  assert.equal(withNet.cost.places.requests, without.cost.places.requests, 'Places searches stay at the same count');
});

test('a stale table is ignored by the loader, and the run still succeeds on geometry', async () => {
  const stale = createNetwork(syntheticTable(), areas.map((a) => (a.id === 'angel' ? { ...a, lat: a.lat + 0.01 } : a)));
  assert.equal(stale, null);
  const r = await go(stale);
  assert.equal(r.status, 'ok');
  assert.ok(r.candidates.every((c) => !c.heuristics.includes('network')));
});
