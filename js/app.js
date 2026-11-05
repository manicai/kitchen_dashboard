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
  var FORECAST_KEY = 'kitchen.forecast';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  var location = null; // From /api/location, set in widgets.json on the server.
  var forecast = null; // { fetchedAt: ms since epoch, latitude, longitude, data: raw Open-Meteo response }
  var lastRefreshFailed = false;
  var forecastRequestId = 0;
  var refreshTimer = null;
  var locationTimer = null;
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
  var musicRequestId = 0;
  var musicBusy = false;
  var recognition = null; // The voice search in progress, if any.
  // Web Speech needs a secure page: over plain http it's there but always refused.
  var SpeechRecognition = window.isSecureContext === false ? null :
    window.SpeechRecognition || window.webkitSpeechRecognition || null;
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

  function renderWeatherStatus(view) {
    var status = el('weather-status');
    var fetchedAt = view ? core.formatTime(new Date(forecast.fetchedAt)) : '';
    status.className = 'weather-status';
    if (!view) {
      status.textContent = '';
    } else if (lastRefreshFailed) {
      status.className += ' weather-status--warning';
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
    var canChoose = !!(sonos && sonos.configured && sonos.available);
    show('sonos', !!view, 'widget sonos');
    show('footer-music', canChoose && !view, 'footer-music');
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
    el('sonos-music').disabled = sonosBusy;
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

  // Music picker: what was last started from it, Sonos favourites and playlists,
  // and a search of those plus the music library on the speakers.

  function setMusicMessage(text) {
    el('music-message').textContent = text;
  }

  function createMusicItem(item) {
    var li = document.createElement('li');
    var button = document.createElement('button');
    var art = createDiv('music-art');
    var text = createDiv('music-text');
    var img;

    button.type = 'button';
    button.className = 'music-item';
    if (item.art) {
      img = document.createElement('img');
      img.alt = '';
      img.onerror = function () {
        art.removeChild(img);
        art.className = 'music-art';
        art.appendChild(createIcon('music'));
      };
      img.src = item.art;
      art.className += ' music-art--image';
      art.appendChild(img);
    } else {
      art.appendChild(createIcon('music'));
    }
    text.appendChild(createDiv('music-name', item.title || 'Untitled'));
    text.appendChild(createDiv('music-sub', core.musicSubtitle(item)));
    button.appendChild(art);
    button.appendChild(text);
    button.addEventListener('click', function () {
      playMusic(item, button);
    });
    li.appendChild(button);
    return li;
  }

  function renderMusicSections(sections) {
    var container = el('music-lists');
    clear(container);
    sections.forEach(function (section) {
      var heading;
      var list;
      if (!section.items || !section.items.length) {
        return;
      }
      if (section.title) {
        heading = document.createElement('h2');
        heading.className = 'music-section-title';
        heading.textContent = section.title;
        container.appendChild(heading);
      }
      list = document.createElement('ul');
      list.className = 'music-list';
      section.items.forEach(function (item) {
        list.appendChild(createMusicItem(item));
      });
      container.appendChild(list);
    });
  }

  function showMusicLibrary() {
    var id = ++musicRequestId;
    clear(el('music-lists'));
    setMusicMessage('Getting your music…');
    getJson('api/sonos/library', function (body) {
      var sections;
      if (id !== musicRequestId) {
        return;
      }
      sections = [
        { title: 'Played recently', items: (body.recent || []).slice(0, 6) },
        { title: 'Favourites', items: body.favourites },
        { title: 'Playlists', items: body.playlists }
      ];
      setMusicMessage(sections.some(function (section) { return section.items && section.items.length; }) ? '' :
        'No Sonos favourites or playlists yet. Search the music library above, or add favourites in the Sonos app.');
      renderMusicSections(sections);
    }, function () {
      if (id === musicRequestId) {
        setMusicMessage("Can't reach the Sonos speakers right now.");
      }
    });
  }

  function searchMusic(query) {
    var id = ++musicRequestId;
    clear(el('music-lists'));
    if (!query) {
      showMusicLibrary();
      return;
    }
    if (query.length < 2) {
      setMusicMessage('Type at least two letters.');
      return;
    }
    setMusicMessage('Searching…');
    getJson('api/sonos/search?q=' + encodeURIComponent(query), function (body) {
      if (id !== musicRequestId) {
        return;
      }
      setMusicMessage(body.items.length ? '' :
        'Nothing called that in your favourites, playlists or music library. Streaming services can only be reached through favourites.');
      renderMusicSections([{ title: '', items: body.items }]);
    }, function () {
      if (id === musicRequestId) {
        setMusicMessage("Can't search right now. Try again?");
      }
    });
  }

  function playMusic(item, button) {
    if (musicBusy) {
      return;
    }
    musicBusy = true;
    button.disabled = true;
    setMusicMessage('Starting ' + (item.title || 'that') + '…');
    getJson('api/sonos/play?id=' + encodeURIComponent(item.id), function (body) {
      musicBusy = false;
      sonos = body;
      closeMusic();
      render();
      scheduleSonos();
    }, function () {
      musicBusy = false;
      button.disabled = false;
      setMusicMessage("Couldn't start " + (item.title || 'that') + '. Try again?');
    }, 'POST');
  }

  function stopListening() {
    if (recognition) {
      recognition.onend = null;
      try {
        recognition.abort();
      } catch (e) {
        // Already stopped.
      }
      recognition = null;
    }
    el('music-mic').className = SpeechRecognition ? 'music-mic' : 'music-mic is-hidden';
  }

  function listen() {
    var heard = false;
    if (recognition) {
      stopListening();
      return;
    }
    try {
      recognition = new SpeechRecognition();
    } catch (e) {
      setMusicMessage("Voice search isn't available on this tablet.");
      return;
    }
    recognition.lang = 'en-GB';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = function (event) {
      var text = event.results[0][0].transcript;
      heard = true;
      stopListening();
      el('music-input').value = text;
      searchMusic(text.trim());
    };
    recognition.onerror = function (event) {
      heard = true;
      stopListening();
      setMusicMessage(event.error === 'not-allowed' || event.error === 'service-not-allowed' ?
        "This browser isn't allowed to use the microphone." :
        event.error === 'network' ? "Voice search can't reach its speech service." :
        "Didn't catch that. Try again, or type it.");
    };
    recognition.onend = function () {
      stopListening();
      if (!heard) {
        setMusicMessage("Didn't catch that. Try again, or type it.");
      }
    };
    el('music-mic').className = 'music-mic music-mic--listening';
    setMusicMessage('Listening…');
    try {
      recognition.start();
    } catch (e) {
      stopListening();
      setMusicMessage("Voice search isn't available on this tablet.");
    }
  }

  function openMusic() {
    el('music-input').value = '';
    stopListening();
    el('music').className = 'setup music';
    showMusicLibrary();
  }

  function closeMusic() {
    musicRequestId++;
    stopListening();
    el('music').className = 'setup music is-hidden';
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
      forecast = { fetchedAt: Date.now(), latitude: location.latitude, longitude: location.longitude, data: data };
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

  function sameLocation(a, b) {
    return a.latitude === b.latitude && a.longitude === b.longitude;
  }

  function loadLocation() {
    window.clearTimeout(locationTimer);
    getJson('api/location', function (body) {
      // A forecast cached for somewhere else would be wrong, not just old.
      if (forecast && !sameLocation(forecast, body)) {
        forecast = null;
        save(FORECAST_KEY, null);
      }
      location = body;
      render();
      refreshWeather();
    }, function () {
      lastRefreshFailed = true;
      render();
      locationTimer = window.setTimeout(loadLocation, RETRY_MS);
    });
  }

  // Timers can stall while the tablet sleeps, so catch up when it wakes.
  function catchUp() {
    if (document.hidden) {
      return;
    }
    render();
    if (!location) {
      loadLocation();
    } else if (!forecast || lastRefreshFailed || Date.now() - forecast.fetchedAt >= REFRESH_MS) {
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

  function start() {
    forecast = load(FORECAST_KEY);

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
    el('sonos-music').addEventListener('click', openMusic);
    el('footer-music').addEventListener('click', openMusic);
    el('music-close').addEventListener('click', closeMusic);
    el('music-mic').addEventListener('click', listen);
    el('music-form').addEventListener('submit', function (event) {
      event.preventDefault();
      el('music-input').blur(); // Puts the keyboard away so the results can be seen.
      searchMusic(el('music-input').value.trim());
    });
    stopListening(); // Shows the microphone if voice search might work.

    tick();
    refreshEvents();
    refreshBins();
    refreshSonos();
    loadLocation();
  }

  start();
})();
