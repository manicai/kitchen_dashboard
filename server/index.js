'use strict';

// Serves the dashboard and fetches calendars on its behalf. A server is needed
// because calendar providers don't send the CORS headers that would let the
// browser read their feeds directly.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createCalendarStore, parseConfig } = require('./calendars.js');
const { createBinStore } = require('./bins.js');
const { createSonos } = require('./sonos.js');
const { createTimetable } = require('./timetable.js');
const { createSolar } = require('./solar.js');
const { createHive } = require('./hive.js');
const { createHiveAuth, createFileStorage } = require('./hive-auth.js');

const FETCH_TIMEOUT_MS = 20 * 1000;
const DEFAULT_LOCATION = { name: 'Cambridge', latitude: 52.2053, longitude: 0.1218 };
const MAX_FEED_BYTES = 20 * 1024 * 1024;

// An explicit list, so calendars.json, widgets.json and the rest of the project are never served.
const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/css/dashboard.css': ['css/dashboard.css', 'text/css; charset=utf-8'],
  '/js/core.js': ['js/core.js', 'text/javascript; charset=utf-8'],
  '/js/app.js': ['js/app.js', 'text/javascript; charset=utf-8']
};

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': status === 200 ? 'no-store' : 'no-cache' });
  res.end(body);
}

const SONOS_COMMANDS = ['toggle', 'next', 'volume-up', 'volume-down'];

const DISABLED_BINS = { upcoming: async () => ({ configured: false, collections: [], failed: false }) };
const NOT_CONFIGURED = async () => { throw new Error('Sonos is not configured'); };
const DISABLED_SONOS = {
  status: async () => ({ configured: false, available: false }),
  command: NOT_CONFIGURED,
  browseLibrary: NOT_CONFIGURED,
  search: NOT_CONFIGURED,
  play: NOT_CONFIGURED
};
const DISABLED_TIMETABLE = { name: '', day: async () => ({ configured: false }) };
const DISABLED_SOLAR = { status: async () => ({ configured: false, available: false }) };
const HIVE_NOT_CONFIGURED = async () => { throw new Error('Hive is not configured'); };
const DISABLED_HIVE = {
  status: async () => ({ configured: false, available: false }),
  boost: HIVE_NOT_CONFIGURED,
  stopBoost: HIVE_NOT_CONFIGURED
};

function sendJson(res, promise, what) {
  promise.then(
    (body) => send(res, 200, 'application/json', JSON.stringify(body)),
    (err) => {
      console.error('Could not ' + what + ': ' + err.message);
      send(res, 500, 'text/plain', 'Server error');
    }
  );
}

function createServer({
  store, bins = DISABLED_BINS, sonos = DISABLED_SONOS, timetable = DISABLED_TIMETABLE, solar = DISABLED_SOLAR,
  hive = DISABLED_HIVE, location = DEFAULT_LOCATION, root
}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://dashboard');
    const route = url.pathname;
    const sonosCommand = route.startsWith('/api/sonos/') ? route.slice('/api/sonos/'.length) : '';

    if (req.method === 'POST' && SONOS_COMMANDS.includes(sonosCommand)) {
      req.resume();
      sendJson(res, sonos.command(sonosCommand), 'control Sonos');
    } else if (req.method === 'POST' && route === '/api/sonos/play') {
      req.resume();
      sendJson(res, sonos.play(url.searchParams.get('id') || ''), 'play on Sonos');
    } else if (req.method === 'POST' && route === '/api/hive/boost') {
      req.resume();
      sendJson(res, hive.boost(url.searchParams.get('id') || '', url.searchParams.get('minutes')), 'boost Hive');
    } else if (req.method === 'POST' && route === '/api/hive/stop') {
      req.resume();
      sendJson(res, hive.stopBoost(url.searchParams.get('id') || ''), 'stop the Hive boost');
    } else if (req.method !== 'GET') {
      send(res, 405, 'text/plain', 'Method not allowed');
    } else if (route === '/api/location') {
      send(res, 200, 'application/json', JSON.stringify(location));
    } else if (route === '/api/buttons') {
      // Which popup buttons to show along the bottom.
      send(res, 200, 'application/json', JSON.stringify({
        timetable: timetable === DISABLED_TIMETABLE ? '' : timetable.name,
        solar: solar !== DISABLED_SOLAR,
        hive: hive !== DISABLED_HIVE
      }));
    } else if (route === '/api/timetable') {
      sendJson(res, timetable.day(new Date()), 'read the timetable');
    } else if (route === '/api/solar') {
      sendJson(res, solar.status(), 'read solar');
    } else if (route === '/api/hive') {
      sendJson(res, hive.status(), 'read Hive');
    } else if (route === '/api/today') {
      sendJson(res, store.today(new Date()), 'build today');
    } else if (route === '/api/bins') {
      sendJson(res, bins.upcoming(new Date()), 'read bins');
    } else if (route === '/api/sonos') {
      sendJson(res, sonos.status(), 'read Sonos');
    } else if (route === '/api/sonos/library') {
      sendJson(res, sonos.browseLibrary(), 'browse Sonos');
    } else if (route === '/api/sonos/search') {
      sendJson(res, sonos.search(url.searchParams.get('q') || ''), 'search Sonos');
    } else if (Object.prototype.hasOwnProperty.call(PUBLIC_FILES, route)) {
      const [file, type] = PUBLIC_FILES[route];
      fs.readFile(path.join(root, file), (err, body) => {
        if (err) {
          send(res, 500, 'text/plain', 'Server error');
        } else {
          send(res, 200, type, body);
        }
      });
    } else {
      send(res, 404, 'text/plain', 'Not found');
    }
  });
}

async function fetchFeed(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) {
    throw new Error('Feed is too large');
  }
  return text;
}

function loadCalendars(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('No calendars.json found, so no calendars will show. See README.md.');
      return [];
    }
    throw err;
  }
  return parseConfig(text);
}

function parseLocation(weather) {
  if (!weather) {
    return DEFAULT_LOCATION;
  }
  const latitude = Number(weather.latitude);
  const longitude = Number(weather.longitude);
  if (weather.latitude === undefined || weather.longitude === undefined ||
      !(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180)) {
    throw new Error('widgets.json: weather needs a numeric latitude and longitude');
  }
  return { name: weather.name ? String(weather.name) : '', latitude, longitude };
}

// Optional settings for the weather and the right-hand widgets. See widgets.example.json.
function loadWidgets(file) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('No widgets.json found, so weather is for ' + DEFAULT_LOCATION.name +
        ' and no bin or Sonos widgets will show. See README.md.');
      return { location: DEFAULT_LOCATION };
    }
    throw new Error('widgets.json is not valid: ' + err.message);
  }
  const bins = config.bins && config.bins.url ? String(config.bins.url).replace(/^webcal:/i, 'https:') : '';
  const sonos = config.sonos && config.sonos.room ? config.sonos : null;
  if (bins && !/^https?:\/\//i.test(bins)) {
    throw new Error('widgets.json: bins.url must be an http, https or webcal url');
  }
  const timetable = config.timetable;
  if (timetable && !(timetable.name && timetable.file)) {
    throw new Error('widgets.json: timetable needs a name and a file');
  }
  const solar = config.solar;
  if (solar && !(solar.apiKey && solar.sn)) {
    throw new Error('widgets.json: solar needs the FoxESS apiKey and the inverter sn');
  }
  const hive = config.hive;
  if (hive && !(hive.username && hive.password)) {
    throw new Error('widgets.json: hive needs the username and password for the Hive app');
  }
  const boostTemperature = hive && hive.boostTemperature !== undefined ? Number(hive.boostTemperature) : 21;
  if (!(boostTemperature >= 5 && boostTemperature <= 32)) {
    throw new Error('widgets.json: hive.boostTemperature must be a number of degrees from 5 to 32');
  }
  return {
    location: parseLocation(config.weather),
    binsUrl: bins,
    sonos: sonos && { room: String(sonos.room), host: sonos.host ? String(sonos.host) : '' },
    timetable: timetable && { name: String(timetable.name), file: String(timetable.file) },
    solar: solar && { apiKey: String(solar.apiKey), sn: String(solar.sn) },
    hive: hive && { username: String(hive.username), password: String(hive.password), boostTemperature }
  };
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

function main() {
  const root = path.join(__dirname, '..');
  const port = Number(process.env.PORT) || 8000;
  let calendars;
  let widgets;
  try {
    calendars = loadCalendars(process.env.CALENDARS_FILE || path.join(root, 'calendars.json'));
    widgets = loadWidgets(process.env.WIDGETS_FILE || path.join(root, 'widgets.json'));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const store = createCalendarStore({ calendars, fetchText: fetchFeed });
  const bins = widgets.binsUrl ? createBinStore({ url: widgets.binsUrl, fetchText: fetchFeed }) : undefined;
  const recentFile = process.env.SONOS_RECENT_FILE || path.join(root, 'sonos-recent.json');
  const sonos = widgets.sonos ? createSonos({
    ...widgets.sonos,
    loadRecent: () => readJsonIfPresent(recentFile),
    saveRecent: (items) => fs.writeFileSync(recentFile, JSON.stringify(items))
  }) : undefined;
  // Relative to the project, like the other config files.
  const timetableFile = widgets.timetable && path.resolve(root, widgets.timetable.file);
  const timetable = widgets.timetable ? createTimetable({
    name: widgets.timetable.name,
    load: () => JSON.parse(fs.readFileSync(timetableFile, 'utf8'))
  }) : undefined;
  const solar = widgets.solar ? createSolar(widgets.solar) : undefined;
  const hive = widgets.hive ? createHive({
    getToken: createHiveAuth({
      password: widgets.hive.password,
      storage: createFileStorage(process.env.HIVE_AUTH_FILE || path.join(root, 'hive-auth.json'))
    }).getToken,
    boostTemperature: widgets.hive.boostTemperature
  }) : undefined;
  const location = widgets.location;
  createServer({ store, bins, sonos, timetable, solar, hive, location, root }).listen(port, () => {
    console.log('Kitchen dashboard on port ' + port + ' for ' + (location.name || 'the configured location') +
      ' with ' + calendars.length + ' calendar(s)' +
      (bins ? ', bins' : '') + (sonos ? ', Sonos room "' + widgets.sonos.room + '"' : '') +
      (timetable ? ', ' + timetable.name + "'s timetable" : '') + (solar ? ', FoxESS solar' : '') + (hive ? ', Hive' : ''));
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, loadWidgets, DEFAULT_LOCATION };
