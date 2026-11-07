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
      return '\u2192 ' + event.end.slice(11, 16);
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
          title: event.title
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

  var MUSIC_KINDS = { station: 'Radio', album: 'Album', playlist: 'Playlist', track: 'Track', artist: 'Artist' };

  // The second line of an item in the music picker, such as "Album · Blur".
  // The kind is left out when the subtitle already says it ("Spotify Playlist").
  function musicSubtitle(item) {
    var kind = MUSIC_KINDS[item.kind] || '';
    var subtitle = item.subtitle || '';
    if (kind && subtitle.toLowerCase().indexOf(kind.toLowerCase()) !== -1) {
      kind = '';
    }
    if (item.kind === 'station' && /station/i.test(subtitle)) {
      kind = '';
    }
    return kind && subtitle ? kind + ' · ' + subtitle : kind || subtitle;
  }

  // "YYYY-MM-DD" as a local date. Not Date("YYYY-MM-DD"), which old browsers read as UTC.
  function parseDay(text) {
    var parts = text.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function minutesOf(hhmm) {
    return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  }

  // "MFL - Spanish" and "PER - Religious Studies" read better without the department.
  function subjectName(subject) {
    return subject.replace(/^[A-Z]{2,5} - /, '');
  }

  // The school day from /api/timetable, as rows: lessons, with a break or lunch
  // row wherever there's a gap. On the day itself, lessons that are over are
  // marked past and the one under way is marked now.
  function buildTimetableView(payload, now) {
    var nowIso = localIso(now);
    var today = nowIso.slice(0, 10);
    var time = nowIso.slice(11, 16);
    var rows = [];
    var lessons;
    var i;

    if (!payload || !payload.configured) {
      return null;
    }
    if (!payload.date) {
      return {
        title: payload.name,
        day: '',
        rows: [],
        message: payload.lastDate ? 'No timetable saved after ' + formatDate(parseDay(payload.lastDate)) + '.' :
          'No timetable saved yet.'
      };
    }
    lessons = payload.lessons || [];
    for (i = 0; i < lessons.length; i++) {
      if (i > 0 && lessons[i - 1].end < lessons[i].start) {
        rows.push({
          kind: 'break',
          label: minutesOf(lessons[i].start) - minutesOf(lessons[i - 1].end) >= 40 ? 'Lunch' : 'Break',
          time: lessons[i - 1].end,
          state: payload.date === today && lessons[i - 1].end <= time && time < lessons[i].start ? 'now' : ''
        });
      }
      rows.push({
        kind: 'lesson',
        time: lessons[i].start + '–' + lessons[i].end,
        subject: subjectName(lessons[i].subject),
        detail: [lessons[i].room, lessons[i].teacher].filter(Boolean).join(' · '),
        state: payload.date !== today ? '' : lessons[i].end <= time ? 'past' : lessons[i].start <= time ? 'now' : ''
      });
    }
    return {
      title: payload.name,
      day: payload.date === today ? 'Today' :
        payload.date === localIso(addDays(now, 1)).slice(0, 10) ? 'Tomorrow' : formatDate(parseDay(payload.date)),
      rows: rows,
      message: ''
    };
  }

  // FoxESS reports power in kW. Below 1 kW, watts to the nearest 10 read better.
  function formatPower(kw) {
    if (kw === null || kw === undefined) {
      return '–';
    }
    return Math.abs(kw) < 1 ? Math.round(kw * 100) * 10 + ' W' : kw.toFixed(1) + ' kW';
  }

  function formatEnergy(kwh) {
    return kwh === null || kwh === undefined ? '–' : kwh.toFixed(1) + ' kWh';
  }

  // Ignores the few watts meters show when nothing is really flowing.
  var IDLE_KW = 0.05;

  function flowing(kw) {
    return typeof kw === 'number' && kw >= IDLE_KW;
  }

  // The solar popup from /api/solar: tiles for now and for today so far.
  function buildSolarView(payload) {
    var current;
    var battery;
    var grid;
    var nowTiles;
    var todayTiles;
    var updated;

    if (!payload || !payload.configured) {
      return null;
    }
    if (!payload.available) {
      return {
        now: [],
        today: [],
        status: '',
        warning: false,
        message: payload.failed ? "Can't reach FoxESS right now. Still trying." : 'Getting the solar figures…'
      };
    }
    current = payload.now;
    nowTiles = [
      { label: 'Solar', value: formatPower(current.solar), note: '' },
      { label: 'House', value: formatPower(current.house), note: '' }
    ];
    if (current.batteryLevel !== null && current.batteryLevel !== undefined) {
      battery = { label: 'Battery', value: Math.round(current.batteryLevel) + '%', note: 'Idle' };
      if (flowing(current.batteryCharge)) {
        battery.note = 'Charging ' + formatPower(current.batteryCharge);
      } else if (flowing(current.batteryDischarge)) {
        battery.note = 'Discharging ' + formatPower(current.batteryDischarge);
      }
      nowTiles.push(battery);
    }
    grid = { label: 'Grid', value: '0 W', note: '' };
    if (flowing(current.gridExport)) {
      grid = { label: 'Exporting', value: formatPower(current.gridExport), note: '' };
    } else if (flowing(current.gridImport)) {
      grid = { label: 'Importing', value: formatPower(current.gridImport), note: '' };
    }
    nowTiles.push(grid);

    todayTiles = [
      { label: 'Generated', value: formatEnergy(payload.today.generated), note: '' },
      { label: 'Used', value: formatEnergy(payload.today.used), note: '' },
      { label: 'Exported', value: formatEnergy(payload.today.exported), note: '' },
      { label: 'Imported', value: formatEnergy(payload.today.imported), note: '' }
    ];
    updated = formatTime(new Date(payload.updatedAt));
    return {
      now: nowTiles,
      today: todayTiles,
      chart: buildSolarChart(payload.history),
      status: payload.failed ? "Can't update. Figures from " + updated : 'Updated ' + updated,
      warning: Boolean(payload.failed),
      message: ''
    };
  }

  function formatMinutes(minutes) {
    var hours = Math.floor(minutes / 60);
    var mins = Math.round(minutes % 60);
    if (!hours) {
      return mins + ' min';
    }
    return hours + ' hr' + (mins ? ' ' + mins + ' min' : '');
  }

  function formatTenths(value) {
    return typeof value === 'number' ? value.toFixed(1) + '°' : '–';
  }

  var HEATING_BOOSTS = [30, 60, 120];
  var HOT_WATER_BOOSTS = [30, 60];

  function boostActions(product, choices) {
    if (product.mode === 'BOOST') {
      return [{ label: 'Stop boost', stop: true }];
    }
    return choices.map(function (minutes) {
      return { label: formatMinutes(minutes), minutes: minutes };
    });
  }

  function heatingCard(zone, label, boostTemperature) {
    var note;
    var activity = zone.active === true ? 'Heating now' : zone.active === false ? 'Not heating' : '';
    if (zone.mode === 'BOOST') {
      note = 'Boosting to ' + formatTemp(zone.target) +
        (typeof zone.boost === 'number' ? ', ' + formatMinutes(zone.boost) + ' left' : '');
    } else if (zone.mode === 'OFF') {
      note = 'Off';
    } else {
      note = (zone.mode === 'MANUAL' ? 'Manual' : 'Schedule') + ', set to ' + formatTemp(zone.target);
    }
    return {
      id: zone.id,
      label: label,
      value: formatTenths(zone.temperature),
      note: zone.online ? note : 'Offline',
      activity: zone.online ? activity : '',
      boosting: zone.mode === 'BOOST',
      online: zone.online,
      actionsLabel: zone.mode === 'BOOST' ? '' : 'Boost to ' + formatTemp(boostTemperature),
      actions: boostActions(zone, HEATING_BOOSTS)
    };
  }

  var HOT_WATER_MODES = { SCHEDULE: 'Schedule', ON: 'Always on', OFF: 'Always off' };

  function hotWaterCard(water, label) {
    var note = HOT_WATER_MODES[water.mode] || '';
    if (water.mode === 'BOOST') {
      note = 'Boosting' + (typeof water.boost === 'number' ? ', ' + formatMinutes(water.boost) + ' left' : '');
    }
    return {
      id: water.id,
      label: label,
      value: water.active === true ? 'On' : water.active === false ? 'Off' : '–',
      note: water.online ? note : 'Offline',
      activity: '',
      boosting: water.mode === 'BOOST',
      online: water.online,
      actionsLabel: water.mode === 'BOOST' ? '' : 'Boost',
      actions: boostActions(water, HOT_WATER_BOOSTS)
    };
  }

  // The Hive popup from /api/hive: a card per heating zone and for hot water,
  // each with its boost buttons. Null until there's a response.
  function buildHiveView(payload) {
    var cards = [];
    var updated;
    var heating;
    var water;

    if (!payload || !payload.configured) {
      return null;
    }
    if (!payload.available) {
      return {
        cards: [],
        status: '',
        warning: false,
        message: payload.needsSignIn ? 'Hive needs signing in again. Run npm run hive-login on the server.' :
          payload.failed ? "Can't reach Hive right now. Still trying." : 'Getting the heating…'
      };
    }
    heating = payload.heating || [];
    water = payload.hotWater || [];
    heating.forEach(function (zone) {
      cards.push(heatingCard(zone, heating.length > 1 && zone.name ? zone.name : 'Heating', payload.boostTemperature));
    });
    water.forEach(function (product) {
      cards.push(hotWaterCard(product, 'Hot water'));
    });
    updated = formatTime(new Date(payload.updatedAt));
    return {
      cards: cards,
      status: payload.needsSignIn ? 'Hive needs signing in again (npm run hive-login). Readings from ' + updated :
        payload.failed ? "Can't update. Readings from " + updated : 'Updated ' + updated,
      warning: Boolean(payload.failed),
      message: cards.length ? '' : 'No heating or hot water found on this Hive account.'
    };
  }

  // The graph's lines, drawn in this order so the dashed import line sits on top.
  var SOLAR_SERIES = [
    { key: 'solar', label: 'Solar' },
    { key: 'house', label: 'House' },
    { key: 'export', label: 'Export' },
    { key: 'import', label: 'Import' }
  ];

  // A round top for the kW axis, and a step that gives three to five lines.
  function solarScale(max) {
    var top = Math.max(1, Math.ceil(max));
    var step = top <= 4 ? 1 : top <= 8 ? 2 : 5;
    var ticks = [];
    var kw;
    top = Math.ceil(top / step) * step;
    for (kw = 0; kw <= top; kw += step) {
      ticks.push(kw);
    }
    return { top: top, ticks: ticks };
  }

  // Today's graph from the history in /api/solar: for each series, runs of
  // points (x from 0 at midnight to 1 at the next, kW) broken wherever FoxESS
  // has a gap. Null until there's something to draw.
  function buildSolarChart(history) {
    var start;
    var dayMs;
    var max = 0;
    var series;
    var scale;

    if (!history || !history.step || !history.start) {
      return null;
    }
    start = new Date(history.start);
    // Not always 24 hours, when the clocks change.
    dayMs = addDays(start, 1).getTime() - history.start;
    series = SOLAR_SERIES.map(function (def) {
      var values = history[def.key] || [];
      var runs = [];
      var run = null;
      var i;
      for (i = 0; i < values.length; i++) {
        if (typeof values[i] !== 'number') {
          run = null;
        } else {
          if (!run) {
            run = [];
            runs.push(run);
          }
          run.push({ x: Math.min(1, (i + 0.5) * history.step / dayMs), kw: Math.max(0, values[i]) });
          max = Math.max(max, values[i]);
        }
      }
      return { key: def.key, label: def.label, runs: runs };
    });
    if (series.every(function (s) { return !s.runs.length; })) {
      return null;
    }
    scale = solarScale(max);
    return {
      series: series,
      top: scale.top,
      yTicks: scale.ticks,
      xTicks: [0, 6, 12, 18, 24].map(function (h) {
        var hour = h === 24 ? addDays(start, 1) : new Date(start.getFullYear(), start.getMonth(), start.getDate(), h);
        return { x: (hour.getTime() - history.start) / dayMs, label: pad(h) + ':00' };
      })
    };
  }


  // Kitchen timers. Times are kept as end timestamps, so a timer stays right
  // however late the page's own timers fire (the tablet can stall them).
  var TIMER_PRESETS = [5, 10, 15, 25, 30, 45, 60, 90, 120];
  var TIMER_MAX = 3;
  var TIMER_SLIDER_MIN = 1;
  var TIMER_SLIDER_MAX = 240;
  var TIMER_SLIDER_STEPS = 1000;
  // The last stretch is highlighted so it's clear which pan needs attention next.
  var TIMER_SOON_MS = 60 * 1000;

  // Coarser steps further up the slider, so it lands on times people set.
  function roundTimerMinutes(minutes) {
    var step = minutes < 20 ? 1 : minutes < 120 ? 5 : 10;
    var rounded = Math.round(minutes / step) * step;
    return Math.max(TIMER_SLIDER_MIN, Math.min(TIMER_SLIDER_MAX, rounded));
  }

  // The slider is logarithmic: as much travel for 1 to 15 minutes as for 15 to 240.
  function sliderToMinutes(position) {
    var fraction = Math.max(0, Math.min(1, position / TIMER_SLIDER_STEPS));
    var span = Math.log(TIMER_SLIDER_MAX / TIMER_SLIDER_MIN);
    return roundTimerMinutes(TIMER_SLIDER_MIN * Math.exp(fraction * span));
  }

  function minutesToSlider(minutes) {
    var clamped = Math.max(TIMER_SLIDER_MIN, Math.min(TIMER_SLIDER_MAX, minutes));
    var span = Math.log(TIMER_SLIDER_MAX / TIMER_SLIDER_MIN);
    return Math.round(Math.log(clamped / TIMER_SLIDER_MIN) / span * TIMER_SLIDER_STEPS);
  }

  // Rounds up, so a timer never shows 0:00 while it still has time to run.
  function formatCountdown(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor(total % 3600 / 60);
    var seconds = total % 60;
    return (hours ? hours + ':' + pad(minutes) : String(minutes)) + ':' + pad(seconds);
  }

  // The lowest colour slot no running timer has, so each keeps its colour.
  function freeTimerSlot(timers) {
    var slot = 0;
    var used = (timers || []).map(function (timer) { return timer.slot; });
    while (used.indexOf(slot) !== -1) {
      slot++;
    }
    return slot;
  }

  function createTimer(timers, minutes, nowMs) {
    return {
      id: String(nowMs) + '-' + freeTimerSlot(timers),
      minutes: minutes,
      slot: freeTimerSlot(timers),
      endsAt: nowMs + minutes * 60 * 1000
    };
  }

  // Drops anything malformed, such as a stored list from an older version.
  function validTimers(timers) {
    if (!(timers instanceof Array)) {
      return [];
    }
    return timers.filter(function (timer) {
      return timer && typeof timer.id === 'string' && typeof timer.endsAt === 'number' &&
        typeof timer.minutes === 'number' && timer.minutes > 0 && typeof timer.slot === 'number';
    }).slice(0, TIMER_MAX);
  }

  // Soonest first, so the next thing to come out of the oven is on top.
  function buildTimersView(timers, nowMs) {
    return validTimers(timers).slice().sort(function (a, b) {
      return a.endsAt - b.endsAt;
    }).map(function (timer) {
      var duration = timer.minutes * 60 * 1000;
      var left = timer.endsAt - nowMs;
      var state = left <= 0 ? 'done' : left <= TIMER_SOON_MS ? 'soon' : 'running';
      return {
        id: timer.id,
        slot: timer.slot,
        label: formatMinutes(timer.minutes),
        remaining: state === 'done' ? 'Done' : formatCountdown(left),
        // Share of the time still to go, for the bar under the countdown.
        fraction: Math.max(0, Math.min(1, left / duration)),
        state: state
      };
    });
  }

  var api = {
    TIMER_PRESETS: TIMER_PRESETS,
    TIMER_MAX: TIMER_MAX,
    TIMER_SLIDER_STEPS: TIMER_SLIDER_STEPS,
    sliderToMinutes: sliderToMinutes,
    minutesToSlider: minutesToSlider,
    formatCountdown: formatCountdown,
    createTimer: createTimer,
    validTimers: validTimers,
    buildTimersView: buildTimersView,
    buildTimetableView: buildTimetableView,
    buildSolarView: buildSolarView,
    buildSolarChart: buildSolarChart,
    buildHiveView: buildHiveView,
    formatMinutes: formatMinutes,
    formatPower: formatPower,
    formatEnergy: formatEnergy,
    musicSubtitle: musicSubtitle,
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
    forecastUrl: forecastUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DashboardCore = api;
  }
})(this);
