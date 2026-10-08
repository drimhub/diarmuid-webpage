import { test } from 'node:test';
import assert from 'node:assert/strict';
import { londonLocalToUtcIso, formatLondon, defaultStartLocal } from '../public/time.js';

test('London wall-clock time converts to UTC across BST and GMT', () => {
  assert.equal(londonLocalToUtcIso('2026-07-01T19:00'), '2026-07-01T18:00:00.000Z'); // BST
  assert.equal(londonLocalToUtcIso('2026-12-01T19:00'), '2026-12-01T19:00:00.000Z'); // GMT
  assert.equal(londonLocalToUtcIso('2026-03-29T12:00'), '2026-03-29T11:00:00.000Z'); // after spring forward
  assert.equal(londonLocalToUtcIso('2026-03-28T12:00'), '2026-03-28T12:00:00.000Z'); // day before
  assert.equal(londonLocalToUtcIso('2026-10-25T12:00'), '2026-10-25T12:00:00.000Z'); // after fall back
  assert.equal(londonLocalToUtcIso('2026-10-24T12:00'), '2026-10-24T11:00:00.000Z'); // day before
});

test('rejects malformed input', () => {
  for (const bad of ['', null, undefined, 'tomorrow', '2026-07-01', '2026-07-01 19:00', '2026-13-01T19:00x']) {
    assert.equal(londonLocalToUtcIso(bad), null, String(bad));
  }
});

test('formats in London time', () => {
  assert.match(formatLondon('2026-07-01T18:00:00.000Z'), /19:00$/);
  assert.match(formatLondon('2026-12-01T19:00:00.000Z'), /19:00$/);
  assert.match(formatLondon('2026-07-01T18:00:00.000Z'), /Wed 1 Jul/);
  assert.equal(formatLondon('garbage'), '');
});

test('default start is 19:00 today before 18:00 London, tomorrow after', () => {
  assert.equal(defaultStartLocal(Date.parse('2026-07-01T10:00:00Z')), '2026-07-01T19:00'); // 11:00 BST
  assert.equal(defaultStartLocal(Date.parse('2026-07-01T17:30:00Z')), '2026-07-02T19:00'); // 18:30 BST
  assert.equal(defaultStartLocal(Date.parse('2026-12-31T20:00:00Z')), '2027-01-01T19:00');
});
