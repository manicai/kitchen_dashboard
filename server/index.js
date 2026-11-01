'use strict';

// Serves the dashboard and fetches calendars on its behalf. A server is needed
// because calendar providers don't send the CORS headers that would let the
// browser read their feeds directly.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createCalendarStore, parseConfig } = require('./calendars.js');

const FETCH_TIMEOUT_MS = 20 * 1000;
const MAX_FEED_BYTES = 20 * 1024 * 1024;

// An explicit list, so calendars.json and the rest of the project are never served.
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

function createServer({ store, root }) {
  return http.createServer((req, res) => {
    const route = req.url.split('?')[0];

    if (req.method !== 'GET') {
      send(res, 405, 'text/plain', 'Method not allowed');
    } else if (route === '/api/today') {
      store.today(new Date()).then(
        (today) => send(res, 200, 'application/json', JSON.stringify(today)),
        (err) => {
          console.error('Could not build today: ' + err.message);
          send(res, 500, 'text/plain', 'Server error');
        }
      );
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

function main() {
  const root = path.join(__dirname, '..');
  const port = Number(process.env.PORT) || 8000;
  let calendars;
  try {
    calendars = loadCalendars(process.env.CALENDARS_FILE || path.join(root, 'calendars.json'));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const store = createCalendarStore({ calendars, fetchText: fetchFeed });
  createServer({ store, root }).listen(port, () => {
    console.log('Kitchen dashboard on port ' + port + ' with ' + calendars.length + ' calendar(s)');
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer };
