'use strict';

process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarStore, parseConfig } = require('../server/calendars.js');

const NOW = new Date(2026, 10, 4, 12, 0);
const TTL = 15 * 60 * 1000;

function ics(summary, start) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:' + summary, 'DTSTAMP:20260101T000000Z',
    'SUMMARY:' + summary, 'DTSTART:' + start, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function later(date, ms) {
  return new Date(date.getTime() + ms);
}

test('parseConfig accepts names and URLs, turning webcal into https', () => {
  assert.deepEqual(
    parseConfig('[{"name":"Family","url":"webcal://example.com/a.ics"},{"name":"Bins","url":"https://example.com/b.ics"}]'),
    [{ name: 'Family', url: 'https://example.com/a.ics' }, { name: 'Bins', url: 'https://example.com/b.ics' }]
  );
});

test('parseConfig rejects invalid JSON and a non-list', () => {
  assert.throws(() => parseConfig('{oops'), /calendars\.json/);
  assert.throws(() => parseConfig('{"name":"x"}'), /list/);
});

test('parseConfig rejects a missing name', () => {
  assert.throws(() => parseConfig('[{"url":"https://example.com/a.ics"}]'), /name/);
});

test('parseConfig rejects addresses that are not web addresses', () => {
  assert.throws(() => parseConfig('[{"name":"x","url":"file:///etc/passwd"}]'), /x/);
  assert.throws(() => parseConfig('[{"name":"y","url":"not a url"}]'), /y/);
});

test('parseConfig accepts strip as one pattern or a list', () => {
  assert.deepEqual(
    parseConfig('[{"name":"A","url":"https://a/","strip":"^Prefix"},{"name":"B","url":"https://b/","strip":["x","y"]}]')
      .map((c) => c.strip),
    [['^Prefix'], ['x', 'y']]
  );
  assert.equal(parseConfig('[{"name":"A","url":"https://a/"}]')[0].strip, undefined);
});

test('parseConfig rejects a strip that is not a valid regular expression', () => {
  assert.throws(() => parseConfig('[{"name":"A","url":"https://a/","strip":"("}]'), /"A".*strip/);
  assert.throws(() => parseConfig('[{"name":"A","url":"https://a/","strip":[3]}]'), /"A".*strip/);
  assert.throws(() => parseConfig('[{"name":"A","url":"https://a/","strip":""}]'), /"A".*strip/);
});

test('strip removes the pattern from titles in that calendar only', async () => {
  const feeds = {
    'https://a/': ics('The Perse School Rugby Union Boys U13A vs Kings', '20261104T120000Z'),
    'https://b/': ics('The Perse School Rugby Union Boys AGM', '20261104T130000Z')
  };
  const store = createCalendarStore({
    calendars: [
      { name: 'Robbie', url: 'https://a/', strip: ['^The Perse School Rugby Union Boys'] },
      { name: 'Other', url: 'https://b/' }
    ],
    fetchText: async (url) => feeds[url]
  });
  assert.deepEqual((await store.today(NOW)).events.map((e) => e.title),
    ['U13A vs Kings', 'The Perse School Rugby Union Boys AGM']);
});

test('strip keeps the original title rather than leaving it blank', async () => {
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/', strip: ['.*'] }],
    fetchText: async () => ics('Lunch', '20261104T120000Z')
  });
  assert.equal((await store.today(NOW)).events[0].title, 'Lunch');
});

test('today merges calendars, labels events and sorts all-day first then by time', async () => {
  const feeds = {
    'https://a/': ics('Lunch', '20261104T120000Z'),
    'https://b/': ics('Breakfast', '20261104T080000Z'),
    'https://c/': ics('Bins', '20261104').replace('DTSTART:', 'DTSTART;VALUE=DATE:')
  };
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/' }, { name: 'B', url: 'https://b/' }, { name: 'C', url: 'https://c/' }],
    fetchText: async (url) => feeds[url]
  });
  const today = await store.today(NOW);
  assert.equal(today.date, '2026-11-04');
  assert.equal(today.configured, 3);
  assert.deepEqual(today.failed, []);
  assert.deepEqual(today.events.map((e) => [e.title, e.calendar]), [['Bins', 'C'], ['Breakfast', 'B'], ['Lunch', 'A']]);
});

test('the response never includes a calendar address', async () => {
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://secret.example/token.ics' }],
    fetchText: async () => ics('Lunch', '20261104T120000Z')
  });
  assert.ok(!JSON.stringify(await store.today(NOW)).includes('secret'));
});

test('a feed is not fetched again until the cache expires', async () => {
  let fetches = 0;
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/' }],
    fetchText: async () => { fetches++; return ics('Lunch', '20261104T120000Z'); }
  });
  await store.today(NOW);
  await store.today(later(NOW, TTL - 1));
  assert.equal(fetches, 1);
  await store.today(later(NOW, TTL));
  assert.equal(fetches, 2);
});

test('requests arriving together share one fetch', async () => {
  let fetches = 0;
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/' }],
    fetchText: async () => { fetches++; return ics('Lunch', '20261104T120000Z'); }
  });
  await Promise.all([store.today(NOW), store.today(NOW)]);
  assert.equal(fetches, 1);
});

test('a new day is worked out from the cached feed without refetching', async () => {
  let fetches = 0;
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/' }],
    fetchText: async () => { fetches++; return ics('Lunch', '20261105T120000Z'); }
  });
  assert.deepEqual((await store.today(new Date(2026, 10, 4, 23, 59))).events, []);
  const next = await store.today(new Date(2026, 10, 5, 0, 1));
  assert.equal(next.date, '2026-11-05');
  assert.equal(next.events[0].title, 'Lunch');
  assert.equal(fetches, 1);
});

test('one failing calendar is reported and the others still show', async () => {
  const store = createCalendarStore({
    calendars: [{ name: 'Good', url: 'https://good/' }, { name: 'Bad', url: 'https://bad/' }],
    fetchText: async (url) => {
      if (url === 'https://bad/') throw new Error('nope');
      return ics('Lunch', '20261104T120000Z');
    }
  });
  const today = await store.today(NOW);
  assert.deepEqual(today.failed, ['Bad']);
  assert.deepEqual(today.events.map((e) => e.title), ['Lunch']);
});

test('a failed refresh keeps showing the last good copy and reports the failure', async () => {
  let up = true;
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/' }],
    fetchText: async () => {
      if (!up) throw new Error('down');
      return ics('Lunch', '20261104T120000Z');
    }
  });
  await store.today(NOW);
  up = false;
  const today = await store.today(later(NOW, TTL));
  assert.deepEqual(today.failed, ['A']);
  assert.deepEqual(today.events.map((e) => e.title), ['Lunch']);
});

test('a calendar recovers once its feed comes back', async () => {
  let up = false;
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/' }],
    fetchText: async () => {
      if (!up) throw new Error('down');
      return ics('Lunch', '20261104T120000Z');
    }
  });
  assert.deepEqual((await store.today(NOW)).failed, ['A']);
  up = true;
  assert.deepEqual((await store.today(later(NOW, 1000))).failed, []);
});

test('a feed that is not valid iCal counts as failed instead of an empty day', async () => {
  const store = createCalendarStore({
    calendars: [{ name: 'A', url: 'https://a/' }],
    fetchText: async () => '<html>Sign in</html>'
  });
  const today = await store.today(NOW);
  assert.deepEqual(today.failed, ['A']);
});

test('no calendars configured gives an empty result', async () => {
  const store = createCalendarStore({ calendars: [], fetchText: async () => '' });
  assert.deepEqual(await store.today(NOW), { date: '2026-11-04', configured: 0, events: [], failed: [] });
});
