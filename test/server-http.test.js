'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createServer } = require('../server/index.js');

const ROOT = path.join(__dirname, '..');

async function withServer(store, run, extra) {
  const server = createServer({ store, root: ROOT, ...extra });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// fetch() normalises "..", so traversal attempts need a raw request.
function rawGet(base, requestPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ hostname, port, path: requestPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

const idleStore = { today: async () => ({ date: '2026-11-04', configured: 0, events: [], failed: [] }) };

test('serves the dashboard page and its assets with the right types', async () => {
  await withServer(idleStore, async (base) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Kitchen Dashboard/);
    assert.match((await fetch(base + '/css/dashboard.css')).headers.get('content-type'), /text\/css/);
    assert.match((await fetch(base + '/js/core.js')).headers.get('content-type'), /javascript/);
  });
});

test('never serves private or project files', async () => {
  await withServer(idleStore, async (base) => {
    for (const p of ['/calendars.json', '/package.json', '/server/index.js', '/.git/config',
      '/js/../calendars.json', '/js/%2e%2e/calendars.json', '/../../etc/passwd', '/js/', '/css']) {
      assert.equal(await rawGet(base, p), 404, p);
    }
  });
});

test('the API returns today as uncached JSON', async () => {
  await withServer(idleStore, async (base) => {
    const res = await fetch(base + '/api/today');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).date, '2026-11-04');
  });
});

test('the API answers 500 without details if something unexpected breaks', async () => {
  const broken = { today: async () => { throw new Error('secret detail'); } };
  await withServer(broken, async (base) => {
    const res = await fetch(base + '/api/today');
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes('secret'));
  });
});

test('only GET is allowed', async () => {
  await withServer(idleStore, async (base) => {
    assert.equal((await fetch(base + '/api/today', { method: 'POST' })).status, 405);
  });
});

test('widget APIs report unconfigured when not set up', async () => {
  await withServer(idleStore, async (base) => {
    assert.equal((await (await fetch(base + '/api/bins')).json()).configured, false);
    assert.equal((await (await fetch(base + '/api/sonos')).json()).configured, false);
    assert.equal((await fetch(base + '/api/sonos/toggle', { method: 'POST' })).status, 500);
  });
});

test('Sonos controls are POST only and pass the command through', async () => {
  const seen = [];
  const sonos = {
    status: async () => ({ configured: true, available: true, state: 'playing' }),
    command: async (name) => { seen.push(name); return { configured: true, available: true, state: 'paused' }; }
  };
  await withServer(idleStore, async (base) => {
    assert.equal((await fetch(base + '/api/sonos/next')).status, 404);
    assert.equal((await fetch(base + '/api/sonos/next', { method: 'POST' })).status, 200);
    assert.equal((await (await fetch(base + '/api/sonos/toggle', { method: 'POST' })).json()).state, 'paused');
    assert.equal((await fetch(base + '/api/sonos/volume-up', { method: 'POST' })).status, 200);
    assert.equal((await fetch(base + '/api/sonos/volume', { method: 'POST' })).status, 405);
  }, { sonos });
  assert.deepEqual(seen, ['next', 'toggle', 'volume-up']);
});

test('the music picker browses, searches and plays by ID only', async () => {
  const seen = [];
  const sonos = {
    status: async () => ({ configured: true, available: true, state: 'stopped' }),
    command: async () => ({}),
    browseLibrary: async () => ({ recent: [], favourites: [{ id: 'FV:2/1', title: 'Radio' }], playlists: [] }),
    search: async (q) => { seen.push('search ' + q); return { items: [] }; },
    play: async (id) => { seen.push('play ' + id); return { configured: true, available: true, state: 'playing' }; }
  };
  await withServer(idleStore, async (base) => {
    assert.equal((await (await fetch(base + '/api/sonos/library')).json()).favourites[0].id, 'FV:2/1');
    assert.equal((await fetch(base + '/api/sonos/search?q=blur%20park')).status, 200);
    assert.equal((await fetch(base + '/api/sonos/play?id=FV:2/1')).status, 404);
    assert.equal((await (await fetch(base + '/api/sonos/play?id=FV%3A2%2F1', { method: 'POST' })).json()).state, 'playing');
  }, { sonos });
  assert.deepEqual(seen, ['search blur park', 'play FV:2/1']);
});

test('the location defaults to Cambridge and can be set', async () => {
  await withServer(idleStore, async (base) => {
    assert.equal((await (await fetch(base + '/api/location')).json()).name, 'Cambridge');
  });
  const location = { name: 'Ely', latitude: 52.4, longitude: 0.26 };
  await withServer(idleStore, async (base) => {
    assert.deepEqual(await (await fetch(base + '/api/location')).json(), location);
  }, { location });
});

test('popup buttons show only for what is set up', async () => {
  await withServer(idleStore, async (base) => {
    assert.deepEqual(await (await fetch(base + '/api/buttons')).json(), { timetable: '', solar: false, hive: false });
    assert.equal((await (await fetch(base + '/api/hive')).json()).configured, false);
    assert.equal((await fetch(base + '/api/hive/boost?id=x&minutes=30', { method: 'POST' })).status, 500);
    assert.equal((await (await fetch(base + '/api/timetable')).json()).configured, false);
    assert.equal((await (await fetch(base + '/api/solar')).json()).configured, false);
  });
  const timetable = { name: 'Robbie', day: async () => ({ configured: true, name: 'Robbie', date: '2026-11-06', lessons: [] }) };
  const solar = { status: async () => ({ configured: true, available: false, failed: false }) };
  await withServer(idleStore, async (base) => {
    assert.deepEqual(await (await fetch(base + '/api/buttons')).json(), { timetable: 'Robbie', solar: true, hive: false });
    assert.equal((await (await fetch(base + '/api/timetable')).json()).date, '2026-11-06');
    assert.equal((await (await fetch(base + '/api/solar')).json()).configured, true);
  }, { timetable, solar });
});

test('Hive readings, boosts and stopping a boost go to the Hive widget', async () => {
  const calls = [];
  const hive = {
    status: async () => ({ configured: true, available: false }),
    boost: async (id, minutes) => {
      calls.push(['boost', id, minutes]);
      return { configured: true, boosted: id };
    },
    stopBoost: async (id) => {
      calls.push(['stop', id]);
      return { configured: true, stopped: id };
    }
  };
  await withServer(idleStore, async (base) => {
    assert.equal((await (await fetch(base + '/api/buttons')).json()).hive, true);
    assert.equal((await (await fetch(base + '/api/hive')).json()).configured, true);
    assert.equal((await (await fetch(base + '/api/hive/boost?id=h1&minutes=60', { method: 'POST' })).json()).boosted, 'h1');
    assert.equal((await (await fetch(base + '/api/hive/stop?id=w1', { method: 'POST' })).json()).stopped, 'w1');
    // Changes need a POST, so a stray link or prefetch can't boost the heating.
    assert.equal((await fetch(base + '/api/hive/boost?id=h1&minutes=60')).status, 404);
  }, { hive });
  assert.deepEqual(calls, [['boost', 'h1', '60'], ['stop', 'w1']]);
});
