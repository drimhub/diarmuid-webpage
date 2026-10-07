import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapToArea, searchAreas, looksLikePostcode, lookupPostcode, inLondon } from '../public/snap.js';

const areas = JSON.parse(readFileSync(new URL('../public/areas.json', import.meta.url), 'utf8'));
const byName = (n) => areas.find((a) => a.name === n);

test('areas.json is well formed', () => {
  assert.ok(areas.length >= 200 && areas.length <= 300, `unexpected count ${areas.length}`);
  const ids = new Set();
  for (const a of areas) {
    assert.match(a.id, /^[a-z0-9-]+$/, `bad id ${a.id}`);
    assert.ok(!ids.has(a.id), `duplicate id ${a.id}`);
    ids.add(a.id);
    assert.ok(a.name && inLondon(a.lat, a.lng), `${a.name} not in London bounds`);
  }
});

test('well-known places are present', () => {
  for (const n of ['Brixton', 'Hoxton', 'Peckham', 'Hampstead', 'Soho', 'Shoreditch', 'Canary Wharf', 'King\'s Cross']) {
    assert.ok(byName(n), `${n} missing`);
  }
});

test('snaps real London points to the right neighbourhood', () => {
  assert.equal(snapToArea(51.4613, -0.1156, areas).area.name, 'Brixton'); // Brixton station
  assert.equal(snapToArea(51.5320, -0.0780, areas).area.name, 'Hoxton'); // Hoxton station
  assert.equal(snapToArea(51.4699, -0.0694, areas).area.name, 'Peckham'); // Peckham Rye
  assert.equal(snapToArea(51.5054, -0.0235, areas).area.name, 'Canary Wharf');
});

test('rejects points outside London or invalid input', () => {
  assert.equal(snapToArea(51.2362, -0.5704, areas), null); // Guildford
  assert.equal(snapToArea(52.4862, -1.8904, areas), null); // Birmingham
  assert.equal(snapToArea(NaN, 0, areas), null);
  assert.equal(snapToArea('51.5', '-0.1', areas), null);
});

test('type-ahead search', () => {
  assert.equal(searchAreas('brix', areas)[0].name, 'Brixton');
  assert.equal(searchAreas('  HOX ', areas)[0].name, 'Hoxton');
  assert.ok(searchAreas('green', areas).length > 1);
  assert.deepEqual(searchAreas('', areas), []);
  assert.deepEqual(searchAreas('zzzzzz', areas), []);
});

test('postcode detection and lookup', async () => {
  assert.ok(looksLikePostcode('E8 3PN'));
  assert.ok(looksLikePostcode('sw9'));
  assert.ok(!looksLikePostcode('Brixton'));
  let url;
  const fake = async (u) => { url = u; return { ok: true, json: async () => ({ result: { latitude: 51.5, longitude: -0.1 } }) }; };
  assert.deepEqual(await lookupPostcode('E8 3PN', fake), { lat: 51.5, lng: -0.1 });
  assert.equal(url, 'https://api.postcodes.io/postcodes/E83PN');
  await lookupPostcode('sw9', fake);
  assert.equal(url, 'https://api.postcodes.io/outcodes/SW9');
  assert.equal(await lookupPostcode('E8 3PN', async () => ({ ok: false })), null);
});
