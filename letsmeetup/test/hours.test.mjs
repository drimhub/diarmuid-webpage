import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenAt, minutesOpenFrom, londonWeekMinute } from '../src/hours.js';

const p = (od, oh, cd, ch, om = 0, cm = 0) => ({ open: { day: od, minute: oh * 60 + om }, close: { day: cd, minute: ch * 60 + cm } });

// The real shape from the spike: 11:00-23:00 Sun-Wed, until midnight Thu-Sat.
const pub = { periods: [p(0, 11, 0, 23), p(1, 11, 1, 23), p(2, 11, 2, 23), p(3, 11, 3, 23), p(4, 11, 5, 0), p(5, 11, 6, 0), p(6, 11, 0, 0)] };

test('London week minute handles BST and GMT', () => {
  assert.equal(londonWeekMinute('2026-10-08T18:30:00Z'), 4 * 1440 + 19 * 60 + 30); // Thu 19:30 BST
  assert.equal(londonWeekMinute('2026-12-03T19:30:00Z'), 4 * 1440 + 19 * 60 + 30); // Thu 19:30 GMT
  assert.throws(() => londonWeekMinute('nope'), RangeError);
});

test('open and closed during the week', () => {
  assert.equal(isOpenAt(pub, '2026-10-08T18:30:00Z'), true); // Thu 19:30
  assert.equal(isOpenAt(pub, '2026-10-08T09:00:00Z'), false); // Thu 10:00 BST, before opening
  assert.equal(isOpenAt(pub, '2026-10-07T22:30:00Z'), false); // Wed 23:30 BST: closed at 23:00
});

test('minutes until close, including closing after midnight', () => {
  assert.equal(minutesOpenFrom(pub, '2026-10-08T18:30:00Z'), 270); // Thu 19:30 -> midnight = 4.5h
  assert.equal(minutesOpenFrom(pub, '2026-10-08T09:00:00Z'), 0);
});

test('a period that wraps from Saturday night into Sunday', () => {
  assert.equal(isOpenAt(pub, '2026-10-10T22:30:00Z'), true); // Sat 23:30 BST, open until Sun 00:00
  assert.equal(minutesOpenFrom(pub, '2026-10-10T22:30:00Z'), 30);
  const late = { periods: [p(6, 20, 0, 2)] }; // Sat 20:00 -> Sun 02:00
  assert.equal(isOpenAt(late, '2026-10-11T00:30:00Z'), true); // Sun 01:30 BST
  assert.equal(isOpenAt(late, '2026-10-11T02:30:00Z'), false); // Sun 03:30 BST
});

test('24 hour venues and unknown hours', () => {
  const always = { periods: [{ open: { day: 0, minute: 0 }, close: null }] };
  assert.equal(isOpenAt(always, '2026-10-08T03:00:00Z'), true);
  assert.equal(minutesOpenFrom(always, '2026-10-08T03:00:00Z'), Infinity);
  assert.equal(isOpenAt(null, '2026-10-08T18:30:00Z'), null);
  assert.equal(isOpenAt({ periods: [] }, '2026-10-08T18:30:00Z'), null);
});
