'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadWidgets, DEFAULT_LOCATION } = require('../server/index.js');

function withConfig(config, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widgets-'));
  const file = path.join(dir, 'widgets.json');
  try {
    fs.writeFileSync(file, JSON.stringify(config));
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('weather location defaults to Cambridge with no file or no weather section', () => {
  assert.equal(DEFAULT_LOCATION.name, 'Cambridge');
  assert.deepEqual(loadWidgets(path.join(os.tmpdir(), 'no-such-dir', 'widgets.json')).location, DEFAULT_LOCATION);
  withConfig({}, (file) => assert.deepEqual(loadWidgets(file).location, DEFAULT_LOCATION));
});

test('weather location is read from widgets.json', () => {
  withConfig({ weather: { name: 'Ely', latitude: '52.4', longitude: 0.26 } }, (file) => {
    assert.deepEqual(loadWidgets(file).location, { name: 'Ely', latitude: 52.4, longitude: 0.26 });
  });
});

test('a weather section without usable coordinates is rejected', () => {
  for (const weather of [{ name: 'Ely' }, { latitude: 'north', longitude: 0 }, { latitude: 95, longitude: 0 }]) {
    withConfig({ weather }, (file) => assert.throws(() => loadWidgets(file), /latitude and longitude/));
  }
});

test('timetable and solar are read from widgets.json and checked', () => {
  withConfig({ timetable: { name: 'Robbie', file: 'robbie_timetable.json' }, solar: { apiKey: 'k', sn: 's' } }, (file) => {
    const widgets = loadWidgets(file);
    assert.deepEqual(widgets.timetable, { name: 'Robbie', file: 'robbie_timetable.json' });
    assert.deepEqual(widgets.solar, { apiKey: 'k', sn: 's' });
  });
  withConfig({}, (file) => {
    assert.equal(loadWidgets(file).timetable, undefined);
    assert.equal(loadWidgets(file).solar, undefined);
  });
  withConfig({ timetable: { name: 'Robbie' } }, (file) => assert.throws(() => loadWidgets(file), /timetable needs/));
  withConfig({ solar: { apiKey: 'k' } }, (file) => assert.throws(() => loadWidgets(file), /solar needs/));
});

test('hive is read from widgets.json and checked', () => {
  withConfig({ hive: { username: 'me@example.com', password: 'pw' } }, (file) => {
    assert.deepEqual(loadWidgets(file).hive, { username: 'me@example.com', password: 'pw', boostTemperature: 21 });
  });
  withConfig({ hive: { username: 'me@example.com', password: 'pw', boostTemperature: '22.5' } }, (file) => {
    assert.equal(loadWidgets(file).hive.boostTemperature, 22.5);
  });
  withConfig({}, (file) => assert.equal(loadWidgets(file).hive, undefined));
  withConfig({ hive: { username: 'me@example.com' } }, (file) => assert.throws(() => loadWidgets(file), /hive needs/));
  withConfig({ hive: { username: 'u', password: 'p', boostTemperature: 'hot' } }, (file) => {
    assert.throws(() => loadWidgets(file), /boostTemperature/);
  });
});
