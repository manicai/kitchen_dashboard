'use strict';

// Answers "what's on at school next": today's lessons until the last one ends,
// then the next day in the file. The file is what scripts/timetable.py writes:
// [{ date, start, end, period, subject, teacher, room, group }], times as local
// "HH:MM". It's read on every request, so a fresh scrape shows without a restart.

const { localIso } = require('./events.js');

// "S16 - SB 1st floor" is room S16 on the first floor of SB; the code is enough.
function shortRoom(room) {
  return String(room || '').split(' - ')[0].trim();
}

// The portal splits lessons into 20-minute periods, so join back-to-back
// periods of the same class into one lesson.
function mergeLessons(entries) {
  const lessons = [];
  entries.forEach((entry) => {
    const last = lessons[lessons.length - 1];
    if (last && last.end === entry.start && last.subject === entry.subject &&
        last.teacher === entry.teacher && last.room === entry.room) {
      last.end = entry.end;
    } else {
      lessons.push({ start: entry.start, end: entry.end, subject: entry.subject, teacher: entry.teacher, room: entry.room });
    }
  });
  return lessons.map((lesson) => ({ ...lesson, room: shortRoom(lesson.room) }));
}

function isLesson(entry) {
  return entry && /^\d{4}-\d\d-\d\d$/.test(entry.date) && /^\d\d:\d\d$/.test(entry.start) &&
    /^\d\d:\d\d$/.test(entry.end) && entry.subject;
}

// { date, lessons } for the day to show, or date null when the file has nothing left.
function dayToShow(entries, now) {
  const nowIso = localIso(now);
  const today = nowIso.slice(0, 10);
  const time = nowIso.slice(11, 16);
  const byDate = {};
  entries.filter(isLesson).forEach((entry) => {
    (byDate[entry.date] = byDate[entry.date] || []).push({
      start: entry.start,
      end: entry.end,
      subject: String(entry.subject),
      teacher: String(entry.teacher || ''),
      room: String(entry.room || '')
    });
  });
  const dates = Object.keys(byDate).sort();
  for (const date of dates) {
    const day = byDate[date].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const finished = date < today || (date === today && day[day.length - 1].end <= time);
    if (!finished) {
      return { date, lessons: mergeLessons(day) };
    }
  }
  return { date: null, lessons: [], lastDate: dates.length ? dates[dates.length - 1] : null };
}

function createTimetable({ name, load }) {
  return {
    name,
    day: async (now) => {
      const entries = load();
      if (!Array.isArray(entries)) {
        throw new Error('timetable file is not a list of lessons');
      }
      return { configured: true, name, ...dayToShow(entries, now) };
    }
  };
}

module.exports = { createTimetable, dayToShow, mergeLessons, shortRoom };
