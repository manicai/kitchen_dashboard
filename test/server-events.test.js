'use strict';

// Pin the zone so these results don't depend on the machine running the tests.
// Nov 2026 is GMT (UTC+0) and July 2026 is BST (UTC+1).
process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eventsForDay } = require('../server/events.js');

const NOV_4 = new Date(2026, 10, 4, 12, 0);

function ics(...lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function vevent(uid, ...lines) {
  return ['BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'].join('\r\n');
}

function titles(events) {
  return events.map((e) => e.title);
}

test('a timed event today gives local start and end', () => {
  const text = ics(vevent('a', 'SUMMARY:Dentist', 'DTSTART:20261104T093000Z', 'DTEND:20261104T103000Z'));
  assert.deepEqual(eventsForDay(text, NOV_4), [
    { title: 'Dentist', allDay: false, start: '2026-11-04T09:30', end: '2026-11-04T10:30' }
  ]);
});

test('events on other days are left out', () => {
  const text = ics(
    vevent('a', 'SUMMARY:Yesterday', 'DTSTART:20261103T093000Z', 'DTEND:20261103T103000Z'),
    vevent('b', 'SUMMARY:Tomorrow', 'DTSTART:20261105T093000Z', 'DTEND:20261105T103000Z')
  );
  assert.deepEqual(eventsForDay(text, NOV_4), []);
});

test('a time in another zone is converted to local time', () => {
  const text = ics(vevent('a', 'SUMMARY:Call',
    'DTSTART;TZID=America/New_York:20261104T090000',
    'DTEND;TZID=America/New_York:20261104T100000'));
  assert.equal(eventsForDay(text, NOV_4)[0].start, '2026-11-04T14:00');
});

test('an event in another zone can land on a different local day', () => {
  // 23:00 in New York on the 3rd is 04:00 on the 4th in London.
  const text = ics(vevent('a', 'SUMMARY:Late call',
    'DTSTART;TZID=America/New_York:20261103T230000',
    'DTEND;TZID=America/New_York:20261103T233000'));
  assert.deepEqual(titles(eventsForDay(text, NOV_4)), ['Late call']);
});

test('an all-day event shows only on its own day', () => {
  const text = ics(vevent('a', 'SUMMARY:Bank holiday', 'DTSTART;VALUE=DATE:20261104', 'DTEND;VALUE=DATE:20261105'));
  assert.deepEqual(eventsForDay(text, NOV_4), [
    { title: 'Bank holiday', allDay: true, start: '2026-11-04T00:00', end: '2026-11-05T00:00' }
  ]);
  assert.deepEqual(eventsForDay(text, new Date(2026, 10, 3, 12)), []);
  assert.deepEqual(eventsForDay(text, new Date(2026, 10, 5, 12)), []);
});

test('an all-day event stays on its day during British Summer Time', () => {
  const text = ics(vevent('a', 'SUMMARY:Sports day', 'DTSTART;VALUE=DATE:20260715', 'DTEND;VALUE=DATE:20260716'));
  assert.deepEqual(titles(eventsForDay(text, new Date(2026, 6, 15, 12))), ['Sports day']);
  assert.deepEqual(eventsForDay(text, new Date(2026, 6, 14, 12)), []);
  assert.deepEqual(eventsForDay(text, new Date(2026, 6, 16, 12)), []);
});

test('an all-day event with no end lasts one day', () => {
  const text = ics(vevent('a', 'SUMMARY:Bins', 'DTSTART;VALUE=DATE:20261104'));
  assert.deepEqual(titles(eventsForDay(text, NOV_4)), ['Bins']);
  assert.deepEqual(eventsForDay(text, new Date(2026, 10, 5, 12)), []);
});

test('a multi-day all-day event shows on its middle day', () => {
  const text = ics(vevent('a', 'SUMMARY:Half term', 'DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261107'));
  assert.deepEqual(titles(eventsForDay(text, NOV_4)), ['Half term']);
});

test('an event running overnight from yesterday still shows today', () => {
  const text = ics(vevent('a', 'SUMMARY:Night shift', 'DTSTART:20261103T220000Z', 'DTEND:20261104T060000Z'));
  assert.deepEqual(eventsForDay(text, NOV_4), [
    { title: 'Night shift', allDay: false, start: '2026-11-03T22:00', end: '2026-11-04T06:00' }
  ]);
});

test('an event ending exactly at midnight does not spill into the next day', () => {
  const text = ics(vevent('a', 'SUMMARY:Party', 'DTSTART:20261103T200000Z', 'DTEND:20261104T000000Z'));
  assert.deepEqual(eventsForDay(text, NOV_4), []);
});

test('an event with no end time is kept', () => {
  const text = ics(vevent('a', 'SUMMARY:Reminder', 'DTSTART:20261104T150000Z'));
  assert.deepEqual(titles(eventsForDay(text, NOV_4)), ['Reminder']);
});

test('a weekly event keeps its wall-clock time across the clocks changing', () => {
  // Started in summer on BST. Must stay at 09:00 after the change to GMT.
  const text = ics(vevent('a', 'SUMMARY:Swimming',
    'DTSTART;TZID=Europe/London:20260701T090000',
    'DTEND;TZID=Europe/London:20260701T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=WE'));
  assert.equal(eventsForDay(text, NOV_4)[0].start, '2026-11-04T09:00');
  assert.deepEqual(eventsForDay(text, new Date(2026, 10, 5, 12)), []);
});

test('a recurring all-day event shows on matching days only', () => {
  const text = ics(vevent('a', 'SUMMARY:Bin day', 'DTSTART;VALUE=DATE:20260107', 'RRULE:FREQ=WEEKLY'));
  assert.deepEqual(titles(eventsForDay(text, NOV_4)), ['Bin day']);
  assert.deepEqual(eventsForDay(text, new Date(2026, 10, 5, 12)), []);
});

test('a recurring event respects EXDATE', () => {
  const text = ics(vevent('a', 'SUMMARY:Swimming',
    'DTSTART;TZID=Europe/London:20260701T090000',
    'DTEND;TZID=Europe/London:20260701T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=WE',
    'EXDATE;TZID=Europe/London:20261104T090000'));
  assert.deepEqual(eventsForDay(text, NOV_4), []);
  assert.deepEqual(titles(eventsForDay(text, new Date(2026, 10, 11, 12))), ['Swimming']);
});

const WEEKLY_WITH_OVERRIDE = (override) => ics(
  vevent('w', 'SUMMARY:Swimming',
    'DTSTART;TZID=Europe/London:20260701T090000',
    'DTEND;TZID=Europe/London:20260701T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=WE'),
  vevent('w', 'RECURRENCE-ID;TZID=Europe/London:20261104T090000', ...override)
);

test('an edited occurrence uses its new time and title', () => {
  const text = WEEKLY_WITH_OVERRIDE(['SUMMARY:Swimming gala',
    'DTSTART;TZID=Europe/London:20261104T130000',
    'DTEND;TZID=Europe/London:20261104T140000']);
  assert.deepEqual(eventsForDay(text, NOV_4), [
    { title: 'Swimming gala', allDay: false, start: '2026-11-04T13:00', end: '2026-11-04T14:00' }
  ]);
});

test('an occurrence moved to another day leaves its old day and appears on the new one', () => {
  const text = WEEKLY_WITH_OVERRIDE(['SUMMARY:Swimming',
    'DTSTART;TZID=Europe/London:20261105T090000',
    'DTEND;TZID=Europe/London:20261105T100000']);
  assert.deepEqual(eventsForDay(text, NOV_4), []);
  assert.deepEqual(titles(eventsForDay(text, new Date(2026, 10, 5, 12))), ['Swimming']);
});

test('cancelled events are left out', () => {
  const text = ics(vevent('a', 'SUMMARY:Off', 'STATUS:CANCELLED', 'DTSTART:20261104T093000Z', 'DTEND:20261104T103000Z'));
  assert.deepEqual(eventsForDay(text, NOV_4), []);
});

test('a cancelled occurrence of a recurring event is left out', () => {
  const text = WEEKLY_WITH_OVERRIDE(['SUMMARY:Swimming', 'STATUS:CANCELLED',
    'DTSTART;TZID=Europe/London:20261104T090000',
    'DTEND;TZID=Europe/London:20261104T100000']);
  assert.deepEqual(eventsForDay(text, NOV_4), []);
});

test('a title with a language parameter still comes out as text', () => {
  const text = ics(vevent('a', 'SUMMARY;LANGUAGE=en-gb:School trip', 'DTSTART:20261104T093000Z', 'DTEND:20261104T103000Z'));
  assert.equal(eventsForDay(text, NOV_4)[0].title, 'School trip');
});

test('an event with no title gets a placeholder', () => {
  const text = ics(vevent('a', 'DTSTART:20261104T093000Z', 'DTEND:20261104T103000Z'));
  assert.equal(eventsForDay(text, NOV_4)[0].title, 'Untitled event');
});

test('an event with escaped punctuation in its title is unescaped', () => {
  const text = ics(vevent('a', 'SUMMARY:Tea\\, cake', 'DTSTART:20261104T093000Z', 'DTEND:20261104T103000Z'));
  assert.equal(eventsForDay(text, NOV_4)[0].title, 'Tea, cake');
});
