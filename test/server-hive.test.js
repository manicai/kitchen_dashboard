'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHive, parseProducts } = require('../server/hive.js');
const { createHiveAuth, createFileStorage, CLIENT_ID } = require('../server/hive-auth.js');

// Trimmed from a real /products response.
function products({ heatingMode = 'SCHEDULE', boost = null, waterMode = 'SCHEDULE' } = {}) {
  return [
    {
      id: 'heat-1',
      type: 'heating',
      props: { online: true, temperature: 19.46, working: true, previous: { mode: 'MANUAL', target: 19 } },
      state: { name: 'Receiver 1', mode: heatingMode, target: heatingMode === 'BOOST' ? 21 : 18, boost }
    },
    {
      id: 'water-1',
      type: 'hotwater',
      props: { online: true, working: false, previous: { mode: 'SCHEDULE' } },
      state: { name: 'Hot Water', mode: waterMode, status: 'OFF', boost: waterMode === 'BOOST' ? 25 : null }
    },
    { id: 'light-1', type: 'warmwhitelight', props: {}, state: {} }
  ];
}

function fakeRequest(responses) {
  const calls = [];
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { request, calls };
}

test('reads heating zones and hot water from the products list', () => {
  const parsed = parseProducts(products({ heatingMode: 'BOOST', boost: 42 }));
  assert.deepEqual(parsed.heating, [{
    id: 'heat-1', name: 'Receiver 1', online: true, mode: 'BOOST', previousMode: 'MANUAL', boost: 42, active: true,
    temperature: 19.46, target: 21, previousTarget: 19
  }]);
  assert.deepEqual(parsed.hotWater, [{
    id: 'water-1', name: 'Hot Water', online: true, mode: 'SCHEDULE', previousMode: 'SCHEDULE', boost: null, active: false
  }]);
  assert.throws(() => parseProducts({}), /Unexpected/);
});

test('caches readings for 30 seconds and keeps the last ones when Hive fails', async () => {
  let now = 1000;
  const { request, calls } = fakeRequest([products(), new Error('HTTP 503'), products()]);
  const hive = createHive({ getToken: null, request, nowMs: () => now });
  const first = await hive.status();
  assert.equal(first.available, true);
  assert.equal(first.heating[0].temperature, 19.46);
  assert.equal(first.boostTemperature, 21);
  now += 10 * 1000;
  await hive.status();
  assert.equal(calls.length, 1);
  now += 30 * 1000;
  const failed = await hive.status();
  assert.equal(failed.failed, true);
  assert.equal(failed.heating[0].temperature, 19.46);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { method: 'GET', url: '/products', body: undefined });
});

test('says when Hive needs signing in again', async () => {
  const err = new Error('Hive needs signing in');
  err.needsSignIn = true;
  const { request } = fakeRequest([err]);
  const status = await createHive({ getToken: null, request }).status();
  assert.deepEqual([status.available, status.failed, status.needsSignIn], [false, true, true]);
});

test('boosts heating to the boost temperature and hot water for the minutes asked', async () => {
  const { request, calls } = fakeRequest([products(), {}, products({ heatingMode: 'BOOST', boost: 60 }), {}, products()]);
  const hive = createHive({ getToken: null, request, boostTemperature: 22 });
  await hive.status();
  const after = await hive.boost('heat-1', '60');
  assert.deepEqual(calls[1], { method: 'POST', url: '/nodes/heating/heat-1', body: { mode: 'BOOST', boost: 60, target: 22 } });
  assert.equal(calls[2].method, 'GET'); // Reads back what Hive now says.
  assert.equal(after.heating[0].mode, 'BOOST');
  await hive.boost('water-1', 30);
  assert.deepEqual(calls[3].body, { mode: 'BOOST', boost: 30 });
  assert.equal(calls[3].url, '/nodes/hotwater/water-1');
});

test('refuses odd boost lengths and unknown ids', async () => {
  const { request, calls } = fakeRequest([products()]);
  const hive = createHive({ getToken: null, request });
  await assert.rejects(hive.boost('heat-1', 'forever'), /between/);
  await assert.rejects(hive.boost('heat-1', 5), /between/);
  await assert.rejects(hive.boost('heat-1', 600), /between/);
  await assert.rejects(hive.boost('nope', 30), /No Hive/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('stopping a boost goes back to the mode before it', async () => {
  const boosting = products({ heatingMode: 'BOOST', boost: 20, waterMode: 'BOOST' });
  const { request, calls } = fakeRequest([boosting, {}, boosting, {}, products()]);
  const hive = createHive({ getToken: null, request });
  await hive.status();
  await hive.stopBoost('heat-1');
  // It was on manual at 19° before, so it goes back to that.
  assert.deepEqual(calls[1].body, { mode: 'MANUAL', target: 19 });
  await hive.stopBoost('water-1');
  assert.deepEqual(calls[3].body, { mode: 'SCHEDULE' });
});

function withAuthFile(items, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-'));
  const file = path.join(dir, 'hive-auth.json');
  if (items) {
    fs.writeFileSync(file, JSON.stringify(items));
  }
  return Promise.resolve(run(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('the auth file works as Cognito storage and is private', () => withAuthFile(null, (file) => {
  const storage = createFileStorage(file);
  assert.equal(storage.getItem('a'), null);
  storage.setItem('a', 1);
  assert.equal(createFileStorage(file).getItem('a'), '1');
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  storage.removeItem('a');
  assert.equal(storage.getItem('a'), null);
}));

test('without hive-login, asks for it rather than signing in and texting a code', () => withAuthFile(null, async (file) => {
  const auth = createHiveAuth({ password: 'pw', storage: createFileStorage(file) });
  await assert.rejects(auth.getToken(), (err) => err.needsSignIn === true);
}));

test('with expired tokens and no remembered device, asks for hive-login', () => {
  const prefix = 'CognitoIdentityServiceProvider.' + CLIENT_ID;
  // A signed-in user with no tokens left and no device key: signing in would need a code.
  return withAuthFile({ [prefix + '.LastAuthUser']: 'uuid-1' }, async (file) => {
    const auth = createHiveAuth({ password: 'pw', storage: createFileStorage(file) });
    await assert.rejects(auth.getToken(), (err) => err.needsSignIn === true);
  });
});
