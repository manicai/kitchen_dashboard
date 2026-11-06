// Pure logic with no DOM access, so it can be unit tested under Node.
// ES5 only: this runs on an old Fire tablet browser (see `npm run lint:es5`).
(function (root) {
  'use strict';

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  // A forecast older than this is hidden rather than shown as if it were current.
  var MAX_FORECAST_AGE_MS = 6 * 60 * 60 * 1000;

  // WMO weather codes, as documented by Open-Meteo.
  var WEATHER = {
    0: ['Clear', 'clear'],
    1: ['Mostly clear', 'clear'],
    2: ['Partly cloudy', 'partly'],
    3: ['Overcast', 'cloud'],
    45: ['Fog', 'fog'],
    48: ['Freezing fog', 'fog'],
    51: ['Light drizzle', 'drizzle'],
    53: ['Drizzle', 'drizzle'],
    55: ['Heavy drizzle', 'drizzle'],
    56: ['Freezing drizzle', 'drizzle'],
    57: ['Freezing drizzle', 'drizzle'],
    61: ['Light rain', 'rain'],
    63: ['Rain', 'rain'],
    65: ['Heavy rain', 'rain'],
    66: ['Freezing rain', 'rain'],
    67: ['Freezing rain', 'rain'],
    71: ['Light snow', 'snow'],
    73: ['Snow', 'snow'],
    75: ['Heavy snow', 'snow'],
    77: ['Snow grains', 'snow'],
    80: ['Light showers', 'rain'],
    81: ['Showers', 'rain'],
    82: ['Heavy showers', 'rain'],
    85: ['Snow showers', 'snow'],
    86: ['Heavy snow showers', 'snow'],
    95: ['Thunderstorm', 'thunder'],
    96: ['Thunderstorm with hail', 'thunder'],
    99: ['Thunderstorm with hail', 'thunder']
  };

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function formatTime(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  // Built by hand because toLocaleDateString options are unreliable on old browsers.
  function formatDate(date) {
    return WEEKDAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()];
  }

  // Local time in the same "YYYY-MM-DDTHH:MM" shape Open-Meteo uses, so the two
  // compare as plain strings. Never pass these to Date(): old browsers read them as UTC.
  function localIso(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + formatTime(date);
  }

  function formatTemp(value) {
    return typeof value === 'number' ? Math.round(value) + '°' : '–';
  }

  function formatPercent(value) {
    return typeof value === 'number' ? Math.round(value) + '%' : '–';
  }

  function describeWeather(code, isDay) {
    var match = WEATHER[code] || ['Unknown', 'cloud'];
    var icon = match[1];
    if (icon === 'clear' || icon === 'partly') {
      icon += isDay ? '-day' : '-night';
    }
    return { label: match[0], icon: icon };
  }

  // How likely rain is, as a word the icons can draw: '' (unlikely), 'possible'
  // or 'likely'. Icons that already show rain or snow need no extra hint.
  function rainHint(probability, icon) {
    if (typeof probability !== 'number' || /^(drizzle|rain|snow|thunder)$/.test(icon)) {
      return '';
    }
    if (probability >= 60) {
      return 'likely';
    }
    return probability >= 30 ? 'possible' : '';
  }

  // The forecast `offsets` hours on from the start of the current hour, so at
  // 21:09 offsets [4, 8, 12] give 01:00, 05:00 and 09:00. Hours past the end of
  // the forecast are left out.
  function laterHours(hourly, nowIso, offsets) {
    var start = hourly.time.indexOf(nowIso.slice(0, 14) + '00');
    var hours = [];
    if (start === -1) {
      return hours;
    }
    offsets.forEach(function (offset) {
      var i = start + offset;
      var weather;
      if (i < hourly.time.length) {
        weather = describeWeather(hourly.weather_code[i], hourly.is_day[i]);
        hours.push({
          label: hourly.time[i].slice(11, 16),
          temp: formatTemp(hourly.temperature_2m[i]),
          weather: weather,
          rain: rainHint(hourly.precipitation_probability[i], weather.icon)
        });
      }
    });
    return hours;
  }

  // Turns a raw Open-Meteo response into display strings for the time `nowIso`.
  // Taking the time as an argument lets a cached forecast roll forward while offline.
  function buildWeatherView(raw, nowIso, offsets) {
    var today = raw.daily.time.indexOf(nowIso.slice(0, 10));
    var weather = describeWeather(raw.current.weather_code, raw.current.is_day);
    return {
      temp: formatTemp(raw.current.temperature_2m),
      feelsLike: formatTemp(raw.current.apparent_temperature),
      label: weather.label,
      icon: weather.icon,
      high: formatTemp(raw.daily.temperature_2m_max[today]),
      low: formatTemp(raw.daily.temperature_2m_min[today]),
      rainChance: formatPercent(raw.daily.precipitation_probability_max[today]),
      hours: laterHours(raw.hourly, nowIso, offsets)
    };
  }

  function isForecastUsable(fetchedAtMs, nowMs) {
    return nowMs - fetchedAtMs < MAX_FORECAST_AGE_MS;
  }

  function forecastUrl(location) {
    return 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + encodeURIComponent(location.latitude) +
      '&longitude=' + encodeURIComponent(location.longitude) +
      '&current=temperature_2m,apparent_temperature,weather_code,is_day' +
      '&hourly=temperature_2m,weather_code,precipitation_probability,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=auto&forecast_days=2';
  }

  function geocodeUrl(query) {
    return 'https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json' +
      '&name=' + encodeURIComponent(query);
  }

  // "Bristol, England, United Kingdom", which tells apart places with the same name.
  function placeLabel(place) {
    var parts = [place.name];
    if (place.admin1 && place.admin1 !== place.name) {
      parts.push(place.admin1);
    }
    if (place.country) {
      parts.push(place.country);
    }
    return parts.join(', ');
  }

  function eventIsFinished(event, nowIso) {
    if (event.allDay) {
      return false;
    }
    // An event with no duration stays up until its start minute has passed.
    return event.end === event.start ? event.start < nowIso : event.end <= nowIso;
  }

  function eventTimeLabel(event, nowIso) {
    var today = nowIso.slice(0, 10);
    var startsToday = event.start.slice(0, 10) === today;
    var endsToday = event.end.slice(0, 10) === today;

    if (event.allDay) {
      return 'All day';
    }
    if (startsToday && (event.start > nowIso || event.start === event.end)) {
      return event.start.slice(11, 16);
    }
    if (endsToday) {
      return 'Until ' + event.end.slice(11, 16);
    }
    return startsToday ? 'Now' : 'All day';
  }

  // Display strings for what's still to come today, or null if `payload` is for
  // another day. Finished events drop off as the day goes on.
  function buildEventsView(payload, nowIso) {
    var events = [];
    var i;
    var event;
    var message = '';

    if (payload.date !== nowIso.slice(0, 10)) {
      return null;
    }

    for (i = 0; i < payload.events.length; i++) {
      event = payload.events[i];
      if (!eventIsFinished(event, nowIso)) {
        events.push({
          time: eventTimeLabel(event, nowIso),
          title: event.title,
          calendar: payload.configured > 1 ? event.calendar : ''
        });
      }
    }

    // After a failure the empty list can't be trusted, so don't call the day clear.
    if (!events.length && !payload.failed.length) {
      message = payload.events.length ? 'Nothing else today' : 'Nothing on today';
    }

    return {
      events: events,
      message: message,
      warning: payload.failed.length ? "Can't update " + payload.failed.join(', ') : ''
    };
  }

  var BIN_NAMES = { blue: 'Blue', green: 'Green', black: 'Black' };

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  // "Blue", "Blue and green", "Blue, green and black".
  function binsLabel(bins) {
    var names = [];
    var i;
    for (i = 0; i < bins.length; i++) {
      names.push(i === 0 ? BIN_NAMES[bins[i]] : BIN_NAMES[bins[i]].toLowerCase());
    }
    if (names.length < 2) {
      return names.join('');
    }
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // Bins go out the evening before a collection. Collections shift around bank
  // holidays, so rather than assume a weekday, show from noon until midnight on
  // any day with a collection tomorrow. Null the rest of the time.
  function buildBinsView(payload, now) {
    var tomorrow = localIso(addDays(now, 1)).slice(0, 10);
    var i;

    if (!payload || !payload.configured || now.getHours() < 12) {
      return null;
    }
    for (i = 0; i < payload.collections.length; i++) {
      if (payload.collections[i].date === tomorrow) {
        return {
          title: binsLabel(payload.collections[i].bins),
          bins: payload.collections[i].bins,
          note: payload.failed ? "Can't update the bin calendar" : ''
        };
      }
    }
    // With no feed at all there's no telling whether tomorrow is a collection.
    if (payload.failed && !payload.collections.length) {
      return { title: "Can't get the bin calendar", bins: [], note: '' };
    }
    return null;
  }

  // Null unless the room is playing, or was recently and can be resumed.
  function buildSonosView(status) {
    if (!status || !status.configured || !status.available) {
      return null;
    }
    if (status.state !== 'playing' && !status.recent) {
      return null;
    }
    return {
      title: status.title || (status.state === 'playing' ? 'Playing' : 'Paused'),
      artist: status.artist || '',
      playing: status.state === 'playing',
      canNext: Boolean(status.canNext)
    };
  }

  var api = {
    buildEventsView: buildEventsView,
    buildBinsView: buildBinsView,
    buildSonosView: buildSonosView,
    binsLabel: binsLabel,
    formatTime: formatTime,
    formatDate: formatDate,
    localIso: localIso,
    formatTemp: formatTemp,
    formatPercent: formatPercent,
    describeWeather: describeWeather,
    rainHint: rainHint,
    laterHours: laterHours,
    buildWeatherView: buildWeatherView,
    isForecastUsable: isForecastUsable,
    forecastUrl: forecastUrl,
    geocodeUrl: geocodeUrl,
    placeLabel: placeLabel
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DashboardCore = api;
  }
})(this);
