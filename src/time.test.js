import test from 'node:test';
import assert from 'node:assert/strict';

import { periodStartMs, zonedTimeToUtcMs } from './time.js';

const iso = (ms) => new Date(ms).toISOString();

test('today starts at local midnight during daylight time', () => {
  const now = Date.parse('2026-09-10T18:30:00Z');
  assert.equal(iso(periodStartMs('today', now)), '2026-09-10T05:00:00.000Z');
});

test('today starts at local midnight during standard time', () => {
  const now = Date.parse('2026-01-15T03:00:00Z');
  assert.equal(iso(periodStartMs('today', now)), '2026-01-14T06:00:00.000Z');
});

test('weeks start Monday in local time', () => {
  const thursday = Date.parse('2026-09-10T18:30:00Z');
  assert.equal(iso(periodStartMs('week', thursday)), '2026-09-07T05:00:00.000Z');
  const sundayEvening = Date.parse('2026-09-13T23:30:00Z');
  assert.equal(iso(periodStartMs('week', sundayEvening)), '2026-09-07T05:00:00.000Z');
  const mondayMorning = Date.parse('2026-09-14T12:00:00Z');
  assert.equal(iso(periodStartMs('week', mondayMorning)), '2026-09-14T05:00:00.000Z');
});

test('months start on the first in local time', () => {
  const now = Date.parse('2026-01-15T03:00:00Z');
  assert.equal(iso(periodStartMs('month', now)), '2026-01-01T06:00:00.000Z');
});

test('month rollover follows the local calendar instead of UTC', () => {
  const now = Date.parse('2027-01-01T02:00:00Z');
  assert.equal(iso(periodStartMs('today', now)), '2026-12-31T06:00:00.000Z');
  assert.equal(iso(periodStartMs('week', now)), '2026-12-28T06:00:00.000Z');
  assert.equal(iso(periodStartMs('month', now)), '2026-12-01T06:00:00.000Z');
});

test('daylight-saving transitions keep local midnight', () => {
  const springForward = Date.parse('2026-03-08T12:00:00Z');
  assert.equal(iso(periodStartMs('today', springForward)), '2026-03-08T06:00:00.000Z');
  assert.equal(iso(periodStartMs('week', springForward)), '2026-03-02T06:00:00.000Z');
  assert.equal(iso(periodStartMs('month', springForward)), '2026-03-01T06:00:00.000Z');

  const fallBack = Date.parse('2026-11-01T20:00:00Z');
  assert.equal(iso(periodStartMs('today', fallBack)), '2026-11-01T05:00:00.000Z');
  assert.equal(iso(periodStartMs('week', fallBack)), '2026-10-26T05:00:00.000Z');
  assert.equal(iso(periodStartMs('month', fallBack)), '2026-11-01T05:00:00.000Z');
});

test('zonedTimeToUtcMs resolves a named wall clock', () => {
  assert.equal(
    iso(zonedTimeToUtcMs({ year: 2026, month: 9, day: 10, hour: 7 })),
    '2026-09-10T12:00:00.000Z',
  );
});

test('unsupported periods are rejected', () => {
  assert.throws(() => periodStartMs('year', Date.now()), RangeError);
});
