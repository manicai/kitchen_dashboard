'use strict';

// Holds the configured calendars: fetches each feed, caches it, and answers
// "what's on today" across all of them.

const { parseFeed, eventsOnDay, localIso } = require('./events.js');

const CACHE_MS = 15 * 60 * 1000;

function parseConfig(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch (err) {
    throw new Error('calendars.json is not valid JSON: ' + err.message);
  }
  if (!Array.isArray(list)) {
    throw new Error('calendars.json must be a list of calendars');
  }
  return list.map((entry, index) => {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error('Calendar ' + (index + 1) + ' in calendars.json needs a name');
    }
    return { name: entry.name.trim(), url: parseFeedUrl(entry) };
  });
}

function parseFeedUrl(entry) {
  let url;
  try {
    url = new URL(String(entry.url).replace(/^webcal:/i, 'https:'));
  } catch (err) {
    throw new Error('Calendar "' + entry.name + '" does not have a valid url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Calendar "' + entry.name + '" must use an http, https or webcal url');
  }
  return url.href;
}

function createCalendarStore({ calendars, fetchText }) {
  const entries = calendars.map((calendar) => ({
    name: calendar.name,
    url: calendar.url,
    parsed: null,
    fetchedAt: 0,
    failed: false,
    pending: null
  }));

  async function fetchEntry(entry, nowMs) {
    try {
      entry.parsed = parseFeed(await fetchText(entry.url));
      entry.fetchedAt = nowMs;
      entry.failed = false;
    } catch (err) {
      entry.failed = true;
      // Just the name: feed addresses often contain a private token.
      console.error('Calendar "' + entry.name + '" failed to update: ' + err.message);
    }
  }

  function refresh(entry, nowMs) {
    const fresh = entry.parsed && !entry.failed && nowMs - entry.fetchedAt < CACHE_MS;
    if (fresh) {
      return Promise.resolve();
    }
    if (!entry.pending) {
      entry.pending = fetchEntry(entry, nowMs).finally(() => {
        entry.pending = null;
      });
    }
    return entry.pending;
  }

  function eventsFrom(entry, now) {
    if (!entry.parsed) {
      return [];
    }
    try {
      return eventsOnDay(entry.parsed, now).map((event) => ({ ...event, calendar: entry.name }));
    } catch (err) {
      entry.failed = true;
      console.error('Calendar "' + entry.name + '" could not be read: ' + err.message);
      return [];
    }
  }

  async function today(now) {
    await Promise.all(entries.map((entry) => refresh(entry, now.getTime())));
    const events = entries.flatMap((entry) => eventsFrom(entry, now));
    events.sort((a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      a.start.localeCompare(b.start) ||
      a.title.localeCompare(b.title));
    return {
      date: localIso(now).slice(0, 10),
      configured: entries.length,
      events,
      failed: entries.filter((entry) => entry.failed).map((entry) => entry.name)
    };
  }

  return { today };
}

module.exports = { createCalendarStore, parseConfig };
