'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimetable, dayToShow, mergeLessons, shortRoom } = require('../server/timetable.js');

function lesson(date, start, end, subject, room = 'N11 - NB 1st floor', teacher = 'Ms X Lin') {
  return { date, start, end, period: 'Period 1', subject, teacher, room, group: '9R' };
}

const WEEK = [
  lesson('2026-11-06', '09:10', '09:30', 'Maths'),
  lesson('2026-11-06', '09:30', '09:50', 'Maths'),
  lesson('2026-11-06', '09:50', '10:10', 'Geography', 'N20 - NB 2nd floor', 'Miss M M Campbell'),
  lesson('2026-11-06', '10:30', '10:50', 'Geography', 'N20 - NB 2nd floor', 'Miss M M Campbell'),
  lesson('2026-11-06', '15:40', '16:00', 'Chemistry', 'C4 - Chemistry', 'Dr E R Brown'),
  // Out of order on purpose: the file isn't promised to be sorted.
  lesson('2026-11-09', '09:30', '09:50', 'Computer Science'),
  lesson('2026-11-09', '09:10', '09:30', 'Computer Science')
];

test('rooms are shortened to their code', () => {
  assert.equal(shortRoom('S16 - SB 1st floor'), 'S16');
  assert.equal(shortRoom('Rouse 5'), 'Rouse 5');
  assert.equal(shortRoom(''), '');
});

test('back-to-back periods of the same class join up, but not across a break', () => {
  const merged = mergeLessons(WEEK.slice(0, 4));
  assert.deepEqual(merged.map((l) => [l.start, l.end, l.subject, l.room]), [
    ['09:10', '09:50', 'Maths', 'N11'],
    ['09:50', '10:10', 'Geography', 'N20'],
    ['10:30', '10:50', 'Geography', 'N20']
  ]);
});

test('shows today until the last lesson ends, then the next school day', () => {
  assert.equal(dayToShow(WEEK, new Date(2026, 10, 6, 7, 0)).date, '2026-11-06');
  assert.equal(dayToShow(WEEK, new Date(2026, 10, 6, 15, 59)).date, '2026-11-06');
  const monday = dayToShow(WEEK, new Date(2026, 10, 6, 16, 0));
  assert.equal(monday.date, '2026-11-09');
  assert.deepEqual(monday.lessons.map((l) => [l.start, l.end]), [['09:10', '09:50']]);
  // At the weekend, Monday.
  assert.equal(dayToShow(WEEK, new Date(2026, 10, 8, 12, 0)).date, '2026-11-09');
});

test('says when the file has run out, and skips malformed entries', () => {
  const day = dayToShow(WEEK.concat([{ date: 'soon' }, null]), new Date(2026, 10, 10, 8, 0));
  assert.deepEqual(day, { date: null, lessons: [], lastDate: '2026-11-09' });
  assert.deepEqual(dayToShow([], new Date(2026, 10, 10)), { date: null, lessons: [], lastDate: null });
});

test('the store reads the file each time and rejects one that is not a list', async () => {
  let entries = WEEK;
  const timetable = createTimetable({ name: 'Robbie', load: () => entries });
  const day = await timetable.day(new Date(2026, 10, 6, 8, 0));
  assert.equal(day.configured, true);
  assert.equal(day.name, 'Robbie');
  assert.equal(day.date, '2026-11-06');
  entries = { lessons: [] };
  await assert.rejects(timetable.day(new Date()), /not a list/);
});
