'use strict';

// Reads a council bin-collection iCal feed and answers "which bins go out next".
// Only blue, green and black bins are reported; food waste goes every week.

const { parseFeed, eventsOnDay, localIso } = require('./events.js');

const CACHE_MS = 60 * 60 * 1000;
const LOOKAHEAD_DAYS = 14;
const COLOURS = ['blue', 'green', 'black'];

function binsIn(events) {
  const found = {};
  events.forEach((event) => {
    const match = /\b(blue|green|black)\b/i.exec(event.title);
    if (match) {
      found[match[1].toLowerCase()] = true;
    }
  });
  return COLOURS.filter((colour) => found[colour]);
}

// Collection days in the next fortnight, starting today: [{ date, bins }].
function collectionsFrom(parsed, now) {
  const collections = [];
  for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const bins = binsIn(eventsOnDay(parsed, day));
    if (bins.length) {
      collections.push({ date: localIso(day).slice(0, 10), bins });
    }
  }
  return collections;
}

function createBinStore({ url, fetchText }) {
  let parsed = null;
  let fetchedAt = 0;
  let failed = false;
  let pending = null;

  async function fetchFeed(nowMs) {
    try {
      parsed = parseFeed(await fetchText(url));
      fetchedAt = nowMs;
      failed = false;
    } catch (err) {
      failed = true;
      console.error('Bin calendar failed to update: ' + err.message);
    }
  }

  function refresh(nowMs) {
    if (parsed && !failed && nowMs - fetchedAt < CACHE_MS) {
      return Promise.resolve();
    }
    if (!pending) {
      pending = fetchFeed(nowMs).finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  async function upcoming(now) {
    if (!url) {
      return { configured: false, collections: [], failed: false };
    }
    await refresh(now.getTime());
    let collections = [];
    if (parsed) {
      try {
        collections = collectionsFrom(parsed, now);
      } catch (err) {
        failed = true;
        console.error('Bin calendar could not be read: ' + err.message);
      }
    }
    return { configured: true, collections, failed };
  }

  return { upcoming };
}

module.exports = { createBinStore, binsIn };
