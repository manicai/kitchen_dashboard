'use strict';

// Works out which events from an iCal feed fall on a given day, in the server's
// time zone. node-ical does the recurrence, exception and time zone work.

const ical = require('node-ical');

function pad(n) {
  return String(n).padStart(2, '0');
}

// The same "YYYY-MM-DDTHH:MM" local format the dashboard uses.
function localIso(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function parseFeed(text) {
  // Dead or private links often return an HTML page with a 200 status. Treating
  // that as an empty calendar would wrongly show a clear day.
  if (!String(text).includes('BEGIN:VCALENDAR')) {
    throw new Error('Not an iCal feed');
  }
  return ical.sync.parseICS(text);
}

function titleOf(summary) {
  const text = summary && typeof summary === 'object' ? summary.val : summary;
  return text ? String(text).trim() || 'Untitled event' : 'Untitled event';
}

function overlaps(start, end, dayStart, dayEnd) {
  if (start >= dayEnd) {
    return false;
  }
  // An event with no duration has no later moment to overlap with.
  return end > start ? end > dayStart : start >= dayStart;
}

function eventsOnDay(parsed, day) {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const results = [];

  Object.values(parsed).forEach((event) => {
    if (event.type !== 'VEVENT' || !event.start) {
      return;
    }
    const instances = ical.expandRecurringEvent(event, {
      from: dayStart,
      to: new Date(dayEnd.getTime() - 1),
      expandOngoing: true
    });
    instances.forEach((instance) => {
      const source = instance.event || event;
      const start = instance.start;
      const end = instance.end || start;
      if (source.status === 'CANCELLED' || !overlaps(start, end, dayStart, dayEnd)) {
        return;
      }
      results.push({
        title: titleOf(instance.summary),
        allDay: Boolean(instance.isFullDay),
        start: localIso(start),
        end: localIso(end)
      });
    });
  });

  return results;
}

function eventsForDay(text, day) {
  return eventsOnDay(parseFeed(text), day);
}

module.exports = { parseFeed, eventsOnDay, eventsForDay, localIso };
