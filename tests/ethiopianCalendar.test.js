import test from 'node:test';
import assert from 'node:assert/strict';
import { getAttendanceCalendarDay, getOrthodoxEasterDate } from '../src/ethiopianCalendar.js';

test('marks Ethiopian New Year, Meskel, Christmas, and Timket', () => {
  assert.ok(getAttendanceCalendarDay('2026-09-11').events.includes('Ethiopian New Year'));
  assert.ok(getAttendanceCalendarDay('2026-09-27').events.includes('Meskel (Finding of the True Cross)'));
  assert.ok(getAttendanceCalendarDay('2027-01-07').events.includes('Ethiopian Christmas (Genna)'));
  assert.ok(getAttendanceCalendarDay('2027-01-19').events.includes('Epiphany (Timket)'));
});

test('marks Ethiopian national observances on their Ethiopian calendar dates', () => {
  assert.ok(getAttendanceCalendarDay('2026-03-02').events.includes('Adwa Victory Day'));
  assert.ok(getAttendanceCalendarDay('2026-05-01').events.includes('International Labour Day'));
  assert.ok(getAttendanceCalendarDay('2026-05-05').events.includes('Patriots Victory Day'));
  assert.ok(getAttendanceCalendarDay('2026-05-28').events.includes('Downfall of the Derg'));
});

test('calculates Orthodox Easter and marks Good Friday and Fasika', () => {
  assert.equal(getOrthodoxEasterDate(2026), '2026-04-12');
  assert.ok(getAttendanceCalendarDay('2026-04-10').events.includes('Orthodox Good Friday'));
  assert.ok(getAttendanceCalendarDay('2026-04-12').events.includes('Orthodox Easter (Fasika)'));
});

test('marks Sundays as weekly rest days and rejects invalid date keys', () => {
  assert.equal(getAttendanceCalendarDay('2026-10-18').isSunday, true);
  assert.equal(getAttendanceCalendarDay('not-a-date'), null);
});