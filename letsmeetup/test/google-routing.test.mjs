import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleRouting, planChunks, normaliseElement } from '../src/providers/routing/google.js';
import { ProviderError } from '../src/providers/types.js';
import { createGoogleStub } from '../testing/google-stub.mjs';
import { fakeTravel } from '../testing/fake-providers.mjs';

const env = { GOOGLE_MAPS_API_KEY: 'SECRET-KEY-123' };
const noSleep = async () => {};
const NOW = Date.parse('2026-10-08T10:00:00Z');
const ARRIVE = '2026-10-08T18:30:00.000Z';

function make(stubOpts) {
  const stub = createGoogleStub(stubOpts);
  return { stub, routing: createGoogleRouting({ env, fetch: stub.fetch, sleep: noSleep, now: () => NOW }) };
}
const spots = (n, lat0 = 51.5) => Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * 0.001, lng: -0.1 - i * 0.0007 }));
const people = (n, mode = 'transit') => spots(n, 51.45).map((p) => ({ ...p, mode }));

test('planChunks respects the element cap', () => {
  for (const [o, d, cap] of [[4, 30, 100], [4, 5, 100], [1, 500, 100], [150, 2, 100], [30, 30, 625], [1, 1, 100]]) {
    const chunks = planChunks(o, d, cap);
    let covered = 0;
    for (const c of chunks) {
      assert.ok(c.oCount * c.dCount <= cap, `${o}x${d} chunk too big`);
      covered += c.oCount * c.dCount;
    }
    assert.equal(covered, o * d, `${o}x${d} not fully covered`);
  }
});

test('one request when it fits, several when transit exceeds 100 elements', async () => {
  const small = make();
  await small.routing.getTravelTimes({ origins: people(4), destinations: spots(5), arriveBy: ARRIVE });
  assert.equal(small.stub.calls.length, 1);

  const big = make(); // 4 x 30 = 120 transit elements: the stub rejects any request over 100
  const { times, cost } = await big.routing.getTravelTimes({ origins: people(4), destinations: spots(30), arriveBy: ARRIVE });
  assert.ok(big.stub.calls.length >= 2);
  assert.equal(times.length, 4);
  assert.ok(times.every((row) => row.length === 30 && row.every((c) => c.status === 'ok')));
  assert.equal(cost.elements, 120);
  assert.equal(cost.requests, big.stub.calls.length);
});

test('results land in the right cells even though Google returns elements unordered', async () => {
  const { routing } = make();
  const o = people(3);
  const d = spots(7);
  const { times } = await routing.getTravelTimes({ origins: o, destinations: d, arriveBy: ARRIVE });
  for (let i = 0; i < o.length; i++) {
    for (let j = 0; j < d.length; j++) {
      assert.equal(times[i][j].durationS, fakeTravel(o[i], d[j], 'transit').durationS, `cell ${i},${j}`);
    }
  }
});

test('identical origins are sent once and shared (cost saving)', async () => {
  const { stub, routing } = make();
  const p = { lat: 51.4613, lng: -0.1156, mode: 'transit' };
  const { times, cost } = await routing.getTravelTimes({ origins: [p, { ...p }, { lat: 51.52, lng: -0.08, mode: 'transit' }], destinations: spots(4), arriveBy: ARRIVE });
  assert.equal(stub.calls[0].body.origins.length, 2);
  assert.equal(cost.elements, 8);
  assert.deepEqual(times[0], times[1]);
  assert.notEqual(times[0], times[1]); // separate copies, not the same array
});

test('mixed modes use separate requests with the right travel mode', async () => {
  const { stub, routing } = make();
  const o = [
    { lat: 51.46, lng: -0.11, mode: 'transit' },
    { lat: 51.46, lng: -0.11, mode: 'bike' }, // same spot, different mode: must not be merged
    { lat: 51.55, lng: -0.17, mode: 'walk' },
  ];
  const { times } = await routing.getTravelTimes({ origins: o, destinations: spots(2), arriveBy: ARRIVE });
  assert.deepEqual(stub.calls.map((c) => c.body.travelMode).sort(), ['BICYCLE', 'TRANSIT', 'WALK']);
  assert.ok(times[0][0].durationS !== times[1][0].durationS); // transit vs bike differ
});

test('arrival time applies to transit only, and a past time is dropped with a warning', async () => {
  const a = make();
  await a.routing.getTravelTimes({ origins: [{ ...people(1)[0] }, { lat: 51.5, lng: -0.1, mode: 'bike' }], destinations: spots(2), arriveBy: ARRIVE });
  const transit = a.stub.calls.find((c) => c.body.travelMode === 'TRANSIT').body;
  const bike = a.stub.calls.find((c) => c.body.travelMode === 'BICYCLE').body;
  assert.equal(transit.arrivalTime, ARRIVE);
  assert.equal(bike.arrivalTime, undefined);
  assert.equal(bike.departureTime, undefined);

  const b = make();
  const { warnings } = await b.routing.getTravelTimes({ origins: people(1), destinations: spots(1), arriveBy: '2026-10-08T09:00:00.000Z' });
  assert.equal(b.stub.calls[0].body.arrivalTime, undefined);
  assert.match(warnings.join(' '), /in the past/);

  const c = make();
  await c.routing.getTravelTimes({ origins: people(1), destinations: spots(1), departAt: ARRIVE });
  assert.equal(c.stub.calls[0].body.departureTime, ARRIVE);
});

test('element-level failures become flagged cells, not exceptions', async () => {
  const { routing } = make({ breakCells: ['0:1'], noRoute: ['1:0'] });
  const { times, warnings } = await routing.getTravelTimes({ origins: people(2), destinations: spots(2), arriveBy: ARRIVE });
  assert.equal(times[0][1].status, 'error');
  assert.equal(times[1][0].status, 'no_route');
  assert.equal(times[0][0].status, 'ok');
  assert.ok(warnings.length > 0);
});

test('normaliseElement', () => {
  assert.deepEqual(normaliseElement({ status: {}, condition: 'ROUTE_EXISTS', duration: '1005s', distanceMeters: 5959 }), { status: 'ok', durationS: 1005, distanceM: 5959 });
  assert.equal(normaliseElement({ status: { code: 5 } }).status, 'error');
  assert.equal(normaliseElement({ status: {}, condition: 'ROUTE_NOT_FOUND' }).status, 'no_route');
  assert.equal(normaliseElement({ status: {}, condition: 'ROUTE_EXISTS', duration: 'soon' }).status, 'error');
  assert.equal(normaliseElement(undefined).status, 'error');
});

test('HTTP failures throw ProviderError without leaking the key; transient ones are retried', async () => {
  const bad = make({ fail: [403, 403, 403, 403] });
  await assert.rejects(bad.routing.getTravelTimes({ origins: people(1), destinations: spots(1) }), (e) => e instanceof ProviderError && !/SECRET-KEY-123/.test(e.message));
  const retry = make({ fail: [503] });
  const { times, cost } = await retry.routing.getTravelTimes({ origins: people(1), destinations: spots(1), arriveBy: ARRIVE });
  assert.equal(times[0][0].status, 'ok');
  assert.equal(cost.requests, 2);
});

test('empty and invalid input', async () => {
  const { routing } = make();
  assert.deepEqual((await routing.getTravelTimes({ origins: [], destinations: spots(2) })).times, []);
  assert.deepEqual((await routing.getTravelTimes({ origins: people(2), destinations: [] })).times, [[], []]);
  await assert.rejects(routing.getTravelTimes({ origins: [{ lat: 1, lng: 1, mode: 'teleport' }], destinations: spots(1) }), TypeError);
  await assert.rejects(routing.getTravelTimes({ origins: people(1), destinations: [{ lat: 'x', lng: 1 }] }), TypeError);
  await assert.rejects(routing.getTravelTimes({ origins: people(1), destinations: spots(1), arriveBy: 'whenever' }), TypeError);
});
