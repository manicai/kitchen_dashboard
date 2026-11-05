'use strict';

process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBinStore, binsIn } = require('../server/bins.js');

// A real feed from the council, saved on 5 November 2026.
const FEED = fs.readFileSync(path.join(__dirname, 'fixtures', 'bins.ics'), 'utf8');

test('binsIn picks out bin colours and ignores food waste', () => {
  assert.deepEqual(binsIn([{ title: 'Green Bin Collection' }, { title: 'Food Waste Collection' },
    { title: 'Blue Bin Collection' }]), ['blue', 'green']);
});

test('upcoming lists the next fortnight of collections from the real feed', async () => {
  const store = createBinStore({ url: 'https://bins/', fetchText: async () => FEED });
  const result = await store.upcoming(new Date(2026, 10, 5, 15, 0));
  assert.equal(result.configured, true);
  assert.equal(result.failed, false);
  assert.deepEqual(result.collections, [
    { date: '2026-11-06', bins: ['blue', 'green'] },
    { date: '2026-11-13', bins: ['black'] }
  ]);
});

test('keeps the last good feed when an update fails', async () => {
  let fail = false;
  const store = createBinStore({
    url: 'https://bins/',
    fetchText: async () => {
      if (fail) {
        throw new Error('down');
      }
      return FEED;
    }
  });
  await store.upcoming(new Date(2026, 10, 5, 12, 0));
  fail = true;
  const result = await store.upcoming(new Date(2026, 10, 5, 14, 0));
  assert.equal(result.failed, true);
  assert.equal(result.collections[0].date, '2026-11-06');
});

test('reports unconfigured without fetching', async () => {
  const store = createBinStore({ url: '', fetchText: async () => assert.fail('fetched') });
  assert.equal((await store.upcoming(new Date())).configured, false);
});
