import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const areas = JSON.parse(readFileSync(new URL('../public/areas.json', import.meta.url), 'utf8'));
const byId = new Map(areas.map((a) => [a.id, a]));
let map, view;
before(async () => {
  globalThis.document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  view = await import('../public/view.js');
  map = await import('../public/map.js');
});

const person = (name, areaId, minutes = 20, mode = 'transit') => ({ participantId: name, name, areaId, mode, minutes });
const option = (rank, areaId, people) => ({
  rank, name: `Venue ${rank}`, address: 'x', rating: 4, ratingCount: 1, priceLevel: 1, primaryType: 'pub', mapsUrl: null, openUntil: null, outdoorSeating: false,
  area: { id: areaId, name: byId.get(areaId).name }, labels: [], reasons: [],
  travel: { perPerson: people, meanMinutes: 20, maxMinutes: 20, spreadMinutes: 0, furthest: { participantId: people[0].participantId, name: people[0].name, minutes: 20, aboveMeanMinutes: 0 } },
});
const people = [person('Alice', 'angel'), person('Bob', 'acton', 30, 'bike'), person('Carol', 'angel', 10, 'walk')];

test('origins are grouped by neighbourhood and every option gets a line per person', () => {
  const m = map.buildMapModel([option(1, 'aldgate', people), option(2, 'archway', people)], byId);
  assert.deepEqual(m.origins.map((o) => [o.areaName, o.names]), [['Angel', ['Alice', 'Carol']], ['Acton', ['Bob']]]);
  assert.equal(m.origins[0].lat, byId.get('angel').lat);
  assert.deepEqual(m.venues.map((v) => v.rank), [1, 2]);
  assert.equal(m.lines[1].length, 3);
  assert.deepEqual(m.lines[2][1].from, [byId.get('acton').lat, byId.get('acton').lng]);
  assert.deepEqual(m.lines[2][1].to, [m.venues[1].lat, m.venues[1].lng]);
});

test('suggestions in the same neighbourhood are fanned out, a lone one sits on the centre', () => {
  const lone = map.buildMapModel([option(1, 'aldgate', people)], byId).venues[0];
  assert.equal(lone.lat, byId.get('aldgate').lat);
  const two = map.buildMapModel([option(1, 'aldgate', people), option(2, 'aldgate', people)], byId).venues;
  assert.notDeepEqual([two[0].lat, two[0].lng], [two[1].lat, two[1].lng]);
  for (const v of two) assert.ok(Math.abs(v.lat - byId.get('aldgate').lat) < 0.004 && Math.abs(v.lng - byId.get('aldgate').lng) < 0.006); // still within the neighbourhood
});

test('anything in an unknown area is left off rather than breaking the map', () => {
  const o = option(1, 'aldgate', [person('Alice', 'nowhere'), person('Bob', null), person('Carol', 'angel')]);
  const m = map.buildMapModel([o, { ...option(2, 'aldgate', people), area: { id: 'nowhere', name: 'Nowhere' } }], byId);
  assert.deepEqual(m.origins.map((x) => x.names), [['Carol']]);
  assert.deepEqual(m.venues.map((v) => v.rank), [1]);
  assert.equal(m.lines[1].length, 1);
  assert.equal(m.lines[2], undefined);
});

test('the model carries no venue name, and hostile text only ever becomes text', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const m = map.buildMapModel([option(1, 'aldgate', [person(evil, 'angel')])], byId);
  assert.ok(!('name' in m.venues[0]));
  const { el } = map.resultsMap([option(1, 'aldgate', [person(evil, 'angel')])], areas, { load: () => new Promise(() => {}) });
  assert.equal(el.querySelector('img'), null);
});

test('if the map library cannot load the box says so and the page carries on', async () => {
  const { el } = map.resultsMap([option(1, 'aldgate', people)], areas, { load: () => Promise.reject(new Error('blocked')) });
  await new Promise((r) => setTimeout(r));
  assert.match(el.textContent, /couldn't be loaded/);
  assert.equal(el.querySelector('.map').hidden, true);
});

test('with a map available, results get one map, and each card can show its journeys on it', () => {
  const picked = [];
  const fake = (opts) => ({ el: document.createElement('div'), select: (r) => picked.push(r), n: opts.length });
  const r = { status: 'ok', reason: null, notes: [], suggestions: [option(1, 'aldgate', people), option(2, 'archway', people)], closestMisses: [], planned: 3, skipped: 0, stale: false };
  const box = document.createElement('div');
  box.append(...view.renderResults(r, { isOwner: true, areas, map: fake }));
  const buttons = [...box.querySelectorAll('button.show-on-map')];
  assert.equal(buttons.length, 2);
  buttons[1].click();
  assert.deepEqual(picked, [2]);

  const without = document.createElement('div');
  without.append(...view.renderResults(r, { isOwner: true }));
  assert.equal(without.querySelectorAll('button.show-on-map').length, 0);
});
