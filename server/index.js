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

const FETCH_TIMEOUT_MS = 20 * 1000;
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
const DISABLED_SONOS = {
  status: async () => ({ configured: false, available: false }),
  command: async () => { throw new Error('Sonos is not configured'); }
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

function createServer({ store, bins = DISABLED_BINS, sonos = DISABLED_SONOS, root }) {
  return http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    const sonosCommand = route.startsWith('/api/sonos/') ? route.slice('/api/sonos/'.length) : '';

    if (req.method === 'POST' && SONOS_COMMANDS.includes(sonosCommand)) {
      req.resume();
      sendJson(res, sonos.command(sonosCommand), 'control Sonos');
    } else if (req.method !== 'GET') {
      send(res, 405, 'text/plain', 'Method not allowed');
    } else if (route === '/api/today') {
      sendJson(res, store.today(new Date()), 'build today');
    } else if (route === '/api/bins') {
      sendJson(res, bins.upcoming(new Date()), 'read bins');
    } else if (route === '/api/sonos') {
      sendJson(res, sonos.status(), 'read Sonos');
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

// Optional settings for the right-hand widgets. See widgets.example.json.
function loadWidgets(file) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('No widgets.json found, so no bin or Sonos widgets will show. See README.md.');
      return {};
    }
    throw new Error('widgets.json is not valid: ' + err.message);
  }
  const bins = config.bins && config.bins.url ? String(config.bins.url).replace(/^webcal:/i, 'https:') : '';
  const sonos = config.sonos && config.sonos.room ? config.sonos : null;
  if (bins && !/^https?:\/\//i.test(bins)) {
    throw new Error('widgets.json: bins.url must be an http, https or webcal url');
  }
  return {
    binsUrl: bins,
    sonos: sonos && { room: String(sonos.room), host: sonos.host ? String(sonos.host) : '' }
  };
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
  const sonos = widgets.sonos ? createSonos(widgets.sonos) : undefined;
  createServer({ store, bins, sonos, root }).listen(port, () => {
    console.log('Kitchen dashboard on port ' + port + ' with ' + calendars.length + ' calendar(s)' +
      (bins ? ', bins' : '') + (sonos ? ', Sonos room "' + widgets.sonos.room + '"' : ''));
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, loadWidgets };
