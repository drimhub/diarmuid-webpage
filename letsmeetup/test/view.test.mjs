import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let view;
before(async () => {
  globalThis.document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  view = await import('../public/view.js');
});

const person = (id, name, minutes, mode = 'transit') => ({ participantId: id, name, mode, minutes });
const travel = (people, furthestIdx = 0) => ({
  perPerson: people,
  meanMinutes: 20, maxMinutes: Math.max(...people.map((p) => p.minutes)), spreadMinutes: 10,
  furthest: { participantId: people[furthestIdx].participantId, name: people[furthestIdx].name, minutes: people[furthestIdx].minutes, aboveMeanMinutes: 6 },
});
const suggestion = (over = {}) => ({
  rank: 1, name: 'The Crown', address: '1 High St, London', rating: 4.6, ratingCount: 1200, priceLevel: 2, primaryType: 'cocktail_bar',
  mapsUrl: 'https://maps.google.com/?cid=1', openUntil: 'Open until 23:00', outdoorSeating: true, area: { id: 'bank', name: 'Bank' },
  labels: ['Fairest'], reasons: [], travel: travel([person('a', 'Alice', 25), person('b', 'Bob', 12, 'bike')]), ...over,
});
const results = (over = {}) => ({ status: 'ok', reason: null, notes: [], suggestions: [suggestion()], closestMisses: [], planned: 2, skipped: 0, stale: false, ...over });

function mount(r, opts = { isOwner: true }) {
  const box = document.createElement('div');
  box.append(...view.renderResults(r, opts));
  return box;
}

test('every name app.js imports from view.js is actually exported', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const m = app.match(/import \{([^}]+)\} from '\/view\.js'/);
  assert.ok(m, 'app.js should import from /view.js');
  for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) assert.ok(name in view, `${name} is not exported by view.js`);
});

test('a result is shown with everything a person needs to decide', () => {
  const text = mount(results()).textContent;
  for (const bit of ['1. ', 'The Crown', 'Bank', 'Fairest', 'Cocktail bar', '4.6 ★ (1200 reviews)', '££', 'Open until 23:00', 'Outdoor seating', '1 High St, London', 'Alice', '25 min', 'Bob', '12 min', 'Cycling', 'Average 20 min', 'longest 25 min (Alice, 6 min above average)', 'Google Maps']) {
    assert.ok(text.includes(bit), `missing "${bit}"`);
  }
});

test('the furthest person is flagged, and only when there is more than one person', () => {
  const chips = [...mount(results()).querySelectorAll('ul.journeys .chip')].map((c) => c.textContent);
  assert.deepEqual(chips, ['furthest']);
  const solo = mount(results({ suggestions: [suggestion({ travel: travel([person('a', 'Alice', 25)]) })] }));
  assert.equal(solo.querySelectorAll('ul.journeys .chip').length, 0);
});

test('hostile text from outside is shown as text, never as markup', () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const box = mount(results({
    notes: [evil],
    suggestions: [suggestion({ name: evil, address: evil, area: { id: 'x', name: evil }, labels: [evil], openUntil: evil, primaryType: evil, travel: travel([person('a', evil, 25), person('b', 'Bob', 12)]) })],
  }));
  assert.equal(box.querySelectorAll('img, script').length, 0);
  assert.ok(box.textContent.includes('<img src=x'));
  assert.ok([...box.querySelectorAll('*')].every((el) => ![...el.attributes].some((a) => /^on/i.test(a.name))));
});

test('links: only plain Google Maps URLs become hrefs, and they open safely', () => {
  const a = mount(results()).querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://maps.google.com/?cid=1');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.match(a.getAttribute('rel'), /noopener/);
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'https://evil.example/maps', 'http://maps.google.com/', null, '']) {
    const box = mount(results({ suggestions: [suggestion({ mapsUrl: bad })] }));
    assert.equal(box.querySelector('a'), null, String(bad));
    assert.ok(box.textContent.includes('The Crown')); // still named, just not linked
  }
});

test('out-of-date results: the organiser is told what to do, others are told who can', () => {
  assert.match(mount(results({ stale: true }), { isOwner: true }).querySelector('.stale').textContent, /Find again/);
  assert.match(mount(results({ stale: true }), { isOwner: false }).querySelector('.stale').textContent, /organiser can update/);
  assert.equal(mount(results()).querySelector('.stale'), null);
});

test('people who were left out are mentioned', () => {
  assert.match(mount(results({ skipped: 1 })).textContent, /1 person hadn't said where/);
  assert.match(mount(results({ skipped: 3 })).textContent, /3 people hadn't said where/);
});

test('no results: a reason in plain words, and the closest options say who they fail', () => {
  const miss = suggestion({ exceeds: [{ name: 'Bob' }, { name: 'Alice' }] });
  const box = mount(results({ status: 'no_results', reason: 'no_venue_within_limits', suggestions: [], closestMisses: [miss] }));
  assert.match(box.textContent, /within everyone's limits/);
  assert.match(box.textContent, /Too far for: Bob, Alice/);
  assert.doesNotMatch(box.textContent, /limit \d/); // never shows anyone's limit
  for (const reason of ['no_venues_found', 'no_venues_matched', 'journeys_unavailable', 'something_new']) {
    const t = mount(results({ status: 'no_results', reason, suggestions: [], closestMisses: [] })).textContent;
    assert.ok(t.length > 30, reason); // always a human sentence
  }
});

test('notes are listed', () => {
  const box = mount(results({ notes: ['Few places matched every requirement.', 'Another note.'] }));
  assert.deepEqual([...box.querySelectorAll('ul.notes li')].map((l) => l.textContent), ['Few places matched every requirement.', 'Another note.']);
});

test('missing optional details do not break a card', () => {
  const box = mount(results({ suggestions: [suggestion({ rating: null, ratingCount: null, priceLevel: null, primaryType: null, openUntil: null, outdoorSeating: null, address: null, labels: [] })] }));
  assert.ok(box.textContent.includes('The Crown'));
  assert.doesNotMatch(box.textContent, /null|undefined|NaN/);
});

test('type and price helpers', () => {
  assert.equal(view.humanType('cocktail_bar'), 'Cocktail bar');
  assert.equal(view.humanType(null), '');
  assert.equal(view.priceText(0), 'Free');
  assert.equal(view.priceText(3), '£££');
  assert.equal(view.priceText(null), '');
});
