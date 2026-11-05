// Connects js/core.js to the page: timers, network, storage and DOM updates.
// ES5 and XMLHttpRequest only: this runs on an old Fire tablet browser.
(function () {
  'use strict';

  var core = window.DashboardCore;

  var REFRESH_MS = 15 * 60 * 1000;
  var RETRY_MS = 2 * 60 * 1000;
  var EVENTS_REFRESH_MS = 5 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 20 * 1000;
  // Hours ahead shown beside the current temperature.
  var LATER_OFFSETS = [4, 8, 12];
  var LOCATION_KEY = 'kitchen.location';
  var FORECAST_KEY = 'kitchen.forecast';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  var location = null;
  var forecast = null; // { fetchedAt: ms since epoch, data: raw Open-Meteo response }
  var lastRefreshFailed = false;
  var forecastRequestId = 0;
  var searchRequestId = 0;
  var refreshTimer = null;
  var today = null; // Latest /api/today response.
  var todayFetchedAt = 0;
  var lastEventsRefreshFailed = false;
  var eventsTimer = null;
  var renderedDate = null;
  var bins = null; // Latest /api/bins response.
  var binsFetchedAt = 0;
  var binsTimer = null;
  var sonos = null; // Latest /api/sonos response.
  var sonosTimer = null;
  var sonosBusy = false;
  var BINS_REFRESH_MS = 60 * 60 * 1000;
  var SONOS_ACTIVE_MS = 5 * 1000;
  var SONOS_IDLE_MS = 15 * 1000;

  function el(id) {
    return document.getElementById(id);
  }

  // Storage can throw or come back empty, and the dashboard must still run if so.
  function load(key) {
    try {
      return JSON.parse(window.localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  function save(key, value) {
    try {
      if (value === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (e) {
      // Keeps working from memory; the setting just won't survive a reload.
    }
  }

  function getJson(url, onSuccess, onError, method) {
    var xhr = new XMLHttpRequest();
    xhr.open(method || 'GET', url);
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.onload = function () {
      var body;
      if (xhr.status < 200 || xhr.status >= 300) {
        onError();
        return;
      }
      try {
        body = JSON.parse(xhr.responseText);
      } catch (e) {
        onError();
        return;
      }
      onSuccess(body);
    };
    xhr.onerror = onError;
    xhr.ontimeout = onError;
    xhr.send();
  }

  function createIcon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    var use = document.createElementNS(SVG_NS, 'use');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    // The xlink form, because old browsers don't understand a plain href here.
    use.setAttributeNS(XLINK_NS, 'xlink:href', '#icon-' + name);
    svg.appendChild(use);
    return svg;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function createDiv(className, text) {
    var div = document.createElement('div');
    div.className = className;
    if (text) {
      div.textContent = text;
    }
    return div;
  }

  function renderClock(now) {
    el('time').textContent = core.formatTime(now);
    var date = core.formatDate(now);
    var space = date.indexOf(' ');
    el('date-day').textContent = date.slice(0, space);
    el('date-month').textContent = date.slice(space + 1);
  }

  function renderLater(hours) {
    var list = el('later');
    clear(list);
    hours.forEach(function (hour) {
      var item = document.createElement('li');
      var icon = createDiv('later-icon');
      var hint;
      var drops = hour.rain === 'likely' ? 2 : hour.rain === 'possible' ? 1 : 0;

      item.className = 'later-hour';
      icon.appendChild(createIcon(hour.weather.icon));
      // Drops tucked under the icon say rain may come without a percentage.
      if (drops) {
        hint = createDiv('later-rain later-rain--' + hour.rain);
        while (drops--) {
          hint.appendChild(createIcon('drop'));
        }
        icon.appendChild(hint);
      }

      item.appendChild(createDiv('later-label', hour.label));
      item.appendChild(icon);
      item.appendChild(createDiv('later-temp', hour.temp));
      list.appendChild(item);
    });
  }

  // Null when there's nothing trustworthy to show: no forecast yet, one too old
  // to pass off as current, or a response that isn't the shape we expected.
  function currentWeatherView(now) {
    if (!forecast || !core.isForecastUsable(forecast.fetchedAt, now.getTime())) {
      return null;
    }
    try {
      return core.buildWeatherView(forecast.data, core.localIso(now), LATER_OFFSETS);
    } catch (e) {
      return null;
    }
  }

  // Also the button for changing location, so it says something whenever the
  // weather can't be shown and a wrong place might be why.
  function renderWeatherStatus(view) {
    var status = el('location-button');
    var fetchedAt = view ? core.formatTime(new Date(forecast.fetchedAt)) : '';
    status.className = 'location-button';
    if (!view) {
      status.textContent = lastRefreshFailed ? 'Change location' : '';
    } else if (lastRefreshFailed) {
      status.className += ' location-button--warning';
      status.textContent = "Can't update. Weather from " + fetchedAt;
    } else {
      status.textContent = 'Updated ' + fetchedAt;
    }
  }

  function renderWeather(now) {
    var view = currentWeatherView(now);
    var icon = el('current-icon');

    el('current-weather').className = view ? '' : 'is-hidden';
    renderWeatherStatus(view);

    if (!view) {
      el('weather-message').textContent = lastRefreshFailed ?
        "Can't get the weather. Still trying." : 'Getting the weather…';
      renderLater([]);
      return;
    }

    el('weather-message').textContent = '';
    clear(icon);
    icon.appendChild(createIcon(view.icon));
    el('current-temp').textContent = view.temp;
    el('current-label').textContent = view.label;
    el('stat-feels').textContent = view.feelsLike;
    el('stat-high').textContent = view.high;
    el('stat-low').textContent = view.low;
    el('stat-rain').textContent = view.rainChance;
    renderLater(view.hours);
  }

  function createEventItem(event) {
    var item = document.createElement('li');
    item.className = 'event';
    item.appendChild(createDiv('event-time', event.time));
    item.appendChild(createDiv('event-title', event.title));
    if (event.calendar) {
      item.appendChild(createDiv('event-calendar', event.calendar));
    }
    return item;
  }

  // Row height depends on the screen, so measure: drop rows from the end until
  // the list fits, and say how many didn't.
  function fitEvents(list, events) {
    var shown = events.length;
    var more;
    while (shown > 1 && list.scrollHeight > list.clientHeight) {
      shown--;
      clear(list);
      events.slice(0, shown).forEach(function (event) {
        list.appendChild(createEventItem(event));
      });
      more = document.createElement('li');
      more.className = 'events-more';
      more.textContent = '+' + (events.length - shown) + ' more';
      list.appendChild(more);
    }
  }

  function hasCalendars() {
    return today ? today.configured > 0 : lastEventsRefreshFailed;
  }

  function renderEvents(now) {
    var list = el('events-list');
    var view = today ? core.buildEventsView(today, core.localIso(now)) : null;
    var warning = '';
    var message = '';
    var events = [];

    if (view) {
      events = view.events;
      message = view.message;
      warning = view.warning || (lastEventsRefreshFailed ? "Can't update the calendar" : '');
    } else if (lastEventsRefreshFailed) {
      message = "Can't get today's calendar. Still trying.";
    } else {
      message = 'Checking the calendar…';
    }

    show('events', hasCalendars(), 'events');
    el('events-message').textContent = message;
    el('events-warning').textContent = warning;
    clear(list);
    events.forEach(function (event) {
      list.appendChild(createEventItem(event));
    });
    fitEvents(list, events);
  }

  function show(id, visible, className) {
    el(id).className = className + (visible ? '' : ' is-hidden');
  }

  function renderBins(now) {
    var view = core.buildBinsView(bins, now);
    var icons = el('bins-icons');
    show('bins', !!view, 'widget bins');
    if (!view) {
      return false;
    }
    clear(icons);
    view.bins.forEach(function (colour) {
      var icon = createDiv('bin bin-' + colour);
      icon.appendChild(createIcon('bin'));
      icons.appendChild(icon);
    });
    el('bins-title').textContent = view.title;
    el('bins-note').textContent = view.note;
    return true;
  }

  function renderSonos() {
    var view = core.buildSonosView(sonos);
    show('sonos', !!view, 'widget sonos');
    if (!view) {
      return false;
    }
    el('sonos-title').textContent = view.title;
    el('sonos-artist').textContent = view.artist;
    el('sonos-toggle').setAttribute('aria-label', view.playing ? 'Pause' : 'Play');
    el('sonos-toggle-icon').setAttributeNS(XLINK_NS, 'xlink:href', view.playing ? '#icon-pause' : '#icon-play');
    el('sonos-toggle').disabled = sonosBusy;
    el('sonos-next').disabled = sonosBusy || !view.canNext;
    el('sonos-volume-down').disabled = sonosBusy;
    el('sonos-volume-up').disabled = sonosBusy;
    return true;
  }

  function render() {
    var now = new Date();
    var hasBins = renderBins(now);
    var hasSonos = renderSonos();
    el('dashboard').className = hasBins || hasSonos || hasCalendars() ? 'dashboard' : 'dashboard no-side';
    renderClock(now);
    renderWeather(now);
    renderEvents(now); // Last, as fitting the list measures the laid-out column.
  }

  function refreshBins() {
    window.clearTimeout(binsTimer);
    getJson('api/bins', function (body) {
      bins = body;
      binsFetchedAt = Date.now();
      render();
      binsTimer = window.setTimeout(refreshBins, BINS_REFRESH_MS);
    }, function () {
      binsTimer = window.setTimeout(refreshBins, RETRY_MS);
    });
  }

  // Polls quickly while the controls are up so the track name keeps up.
  function scheduleSonos() {
    window.clearTimeout(sonosTimer);
    if (sonos && sonos.configured === false) {
      return; // Not set up on the server; nothing will change until it restarts.
    }
    sonosTimer = window.setTimeout(refreshSonos, core.buildSonosView(sonos) ? SONOS_ACTIVE_MS : SONOS_IDLE_MS);
  }

  function refreshSonos() {
    getJson('api/sonos', function (body) {
      sonos = body;
      render();
      scheduleSonos();
    }, function () {
      sonos = null;
      render();
      scheduleSonos();
    });
  }

  function sonosCommand(name) {
    if (sonosBusy) {
      return;
    }
    sonosBusy = true;
    render();
    getJson('api/sonos/' + name, function (body) {
      sonosBusy = false;
      sonos = body;
      render();
      scheduleSonos();
    }, function () {
      sonosBusy = false;
      refreshSonos();
    }, 'POST');
  }

  function refreshEvents() {
    window.clearTimeout(eventsTimer);
    getJson('api/today', function (body) {
      today = body;
      todayFetchedAt = Date.now();
      lastEventsRefreshFailed = false;
      render();
      eventsTimer = window.setTimeout(refreshEvents, EVENTS_REFRESH_MS);
    }, function () {
      lastEventsRefreshFailed = true;
      render();
      eventsTimer = window.setTimeout(refreshEvents, RETRY_MS);
    });
  }

  // Re-arms against the wall clock each time, so the minute never drifts.
  function tick() {
    var now = new Date();
    var date = core.formatDate(now);
    render();
    if (renderedDate && renderedDate !== date) {
      refreshEvents();
      refreshBins();
    }
    renderedDate = date;
    window.setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
  }

  function refreshWeather() {
    var id;
    if (!location) {
      return;
    }
    id = ++forecastRequestId;
    window.clearTimeout(refreshTimer);

    getJson(core.forecastUrl(location), function (data) {
      if (id !== forecastRequestId) {
        return; // Superseded, for example by a change of location.
      }
      forecast = { fetchedAt: Date.now(), data: data };
      lastRefreshFailed = false;
      save(FORECAST_KEY, forecast);
      render();
      refreshTimer = window.setTimeout(refreshWeather, REFRESH_MS);
    }, function () {
      if (id !== forecastRequestId) {
        return;
      }
      lastRefreshFailed = true;
      render();
      refreshTimer = window.setTimeout(refreshWeather, RETRY_MS);
    });
  }

  // Timers can stall while the tablet sleeps, so catch up when it wakes.
  function catchUp() {
    if (document.hidden) {
      return;
    }
    render();
    if (!forecast || lastRefreshFailed || Date.now() - forecast.fetchedAt >= REFRESH_MS) {
      refreshWeather();
    }
    if (lastEventsRefreshFailed || Date.now() - todayFetchedAt >= EVENTS_REFRESH_MS) {
      refreshEvents();
    }
    if (Date.now() - binsFetchedAt >= BINS_REFRESH_MS) {
      refreshBins();
    }
    if (!sonos || sonos.configured !== false) {
      refreshSonos();
    }
  }

  function setSetupMessage(text) {
    el('setup-message').textContent = text;
  }

  function closeSetup() {
    searchRequestId++;
    el('setup').className = 'setup is-hidden';
    el('location-button').focus();
  }

  function openSetup() {
    el('setup-input').value = '';
    setSetupMessage('');
    clear(el('setup-results'));
    el('setup-cancel').className = location ? 'setup-cancel' : 'setup-cancel is-hidden';
    el('setup').className = 'setup';
    el('setup-input').focus();
  }

  function choosePlace(place) {
    location = { name: place.name, latitude: place.latitude, longitude: place.longitude };
    forecast = null;
    lastRefreshFailed = false;
    save(LOCATION_KEY, location);
    save(FORECAST_KEY, null);
    closeSetup();
    render();
    refreshWeather();
  }

  function renderSearchResults(places) {
    var list = el('setup-results');
    clear(list);
    places.forEach(function (place) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'setup-result';
      button.textContent = core.placeLabel(place);
      button.addEventListener('click', function () {
        choosePlace(place);
      });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  function search(event) {
    var query = el('setup-input').value.trim();
    var id = ++searchRequestId;
    event.preventDefault();
    clear(el('setup-results'));

    if (query.length < 2) {
      setSetupMessage('Type at least two letters.');
      return;
    }

    setSetupMessage('Searching…');
    getJson(core.geocodeUrl(query), function (body) {
      var places = body.results || [];
      if (id !== searchRequestId) {
        return;
      }
      setSetupMessage(places.length ? '' : 'No places found. Check the spelling?');
      renderSearchResults(places);
    }, function () {
      if (id === searchRequestId) {
        setSetupMessage("Can't search right now. Check the Wi-Fi and try again.");
      }
    });
  }

  function start() {
    location = load(LOCATION_KEY);
    forecast = load(FORECAST_KEY);

    el('location-button').addEventListener('click', openSetup);
    el('setup-cancel').addEventListener('click', closeSetup);
    el('setup-form').addEventListener('submit', search);
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('online', catchUp);
    window.addEventListener('resize', render);
    el('sonos-toggle').addEventListener('click', function () {
      sonosCommand('toggle');
    });
    el('sonos-next').addEventListener('click', function () {
      sonosCommand('next');
    });
    el('sonos-volume-down').addEventListener('click', function () {
      sonosCommand('volume-down');
    });
    el('sonos-volume-up').addEventListener('click', function () {
      sonosCommand('volume-up');
    });

    tick();
    refreshEvents();
    refreshBins();
    refreshSonos();
    if (location) {
      refreshWeather();
    } else {
      openSetup();
    }
  }

  start();
})();
