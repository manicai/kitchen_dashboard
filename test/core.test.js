'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

function sampleForecast() {
  return {
    current: { temperature_2m: 11.6, apparent_temperature: 8.4, weather_code: 61, is_day: 1 },
    hourly: {
      time: ['2026-11-01T14:00', '2026-11-01T15:00', '2026-11-01T16:00', '2026-11-01T17:00'],
      temperature_2m: [11.6, 10.5, 9.2, -0.4],
      weather_code: [61, 3, 0, 0],
      precipitation_probability: [80, 40, null, 0],
      is_day: [1, 1, 1, 0]
    },
    daily: {
      time: ['2026-11-01', '2026-11-02'],
      temperature_2m_max: [12.4, 15],
      temperature_2m_min: [4.6, 7],
      precipitation_probability_max: [80, 10],
      sunset: ['2026-11-01T16:31', '2026-11-02T16:29']
    }
  };
}

test('formatTime is 24-hour and zero padded', () => {
  assert.equal(core.formatTime(new Date(2026, 10, 1, 7, 5)), '07:05');
  assert.equal(core.formatTime(new Date(2026, 10, 1, 0, 0)), '00:00');
});

test('formatDate gives weekday, day and month', () => {
  assert.equal(core.formatDate(new Date(2026, 10, 1)), 'Sunday 1 November');
});

test('localIso matches the Open-Meteo time format', () => {
  assert.equal(core.localIso(new Date(2026, 0, 2, 3, 4)), '2026-01-02T03:04');
});

test('formatTemp rounds, and shows a dash for missing values', () => {
  assert.equal(core.formatTemp(11.6), '12°');
  assert.equal(core.formatTemp(0), '0°');
  assert.equal(core.formatTemp(-0.4), '0°');
  assert.equal(core.formatTemp(null), '–');
  assert.equal(core.formatTemp(undefined), '–');
});

test('formatPercent keeps zero, and shows a dash for missing values', () => {
  assert.equal(core.formatPercent(0), '0%');
  assert.equal(core.formatPercent(null), '–');
});

test('describeWeather picks day and night icons only where they differ', () => {
  assert.deepEqual(core.describeWeather(0, 1), { label: 'Clear', icon: 'clear-day' });
  assert.deepEqual(core.describeWeather(0, 0), { label: 'Clear', icon: 'clear-night' });
  assert.deepEqual(core.describeWeather(2, 0), { label: 'Partly cloudy', icon: 'partly-night' });
  assert.deepEqual(core.describeWeather(63, 0), { label: 'Rain', icon: 'rain' });
});

test('describeWeather survives a code it does not know', () => {
  assert.deepEqual(core.describeWeather(1234, 1), { label: 'Unknown', icon: 'cloud' });
});

test('laterHours counts from the start of the current hour', () => {
  const hours = core.laterHours(sampleForecast().hourly, '2026-11-01T14:49', [1, 3]);
  assert.deepEqual(hours.map((h) => h.label), ['15:00', '17:00']);
  assert.equal(hours[0].temp, '11°');
  assert.equal(hours[0].weather.icon, 'cloud');
  assert.equal(hours[1].weather.icon, 'clear-night');
});

test('laterHours leaves out hours past the end of the forecast', () => {
  assert.equal(core.laterHours(sampleForecast().hourly, '2026-11-01T16:30', [1, 4, 8]).length, 1);
  assert.equal(core.laterHours(sampleForecast().hourly, '2026-11-02T00:00', [1]).length, 0);
});

test('laterHours turns the chance of rain into a hint for the icon', () => {
  const hours = core.laterHours(sampleForecast().hourly, '2026-11-01T14:00', [0, 1, 2, 3]);
  assert.deepEqual(hours.map((h) => h.rain), ['', 'possible', '', '']);
});

test('rainHint is graded, and left off icons that already show rain', () => {
  assert.equal(core.rainHint(29, 'cloud'), '');
  assert.equal(core.rainHint(30, 'cloud'), 'possible');
  assert.equal(core.rainHint(60, 'partly-day'), 'likely');
  assert.equal(core.rainHint(90, 'rain'), '');
  assert.equal(core.rainHint(90, 'snow'), '');
  assert.equal(core.rainHint(null, 'cloud'), '');
});

test('buildWeatherView produces display strings for today', () => {
  const view = core.buildWeatherView(sampleForecast(), '2026-11-01T14:49', [1, 2]);
  assert.equal(view.temp, '12°');
  assert.equal(view.feelsLike, '8°');
  assert.equal(view.label, 'Light rain');
  assert.equal(view.icon, 'rain');
  assert.equal(view.high, '12°');
  assert.equal(view.low, '5°');
  assert.equal(view.rainChance, '80%');
  assert.equal(view.sunset, '16:31');
  assert.equal(view.hours.length, 2);
});

test('buildWeatherView uses the new day after midnight on a cached forecast', () => {
  const view = core.buildWeatherView(sampleForecast(), '2026-11-02T00:10', [1]);
  assert.equal(view.high, '15°');
  assert.equal(view.low, '7°');
  assert.equal(view.rainChance, '10%');
  assert.equal(view.sunset, '16:29');
});

test('buildWeatherView shows dashes when today is not in the forecast', () => {
  const view = core.buildWeatherView(sampleForecast(), '2026-11-03T00:10', [1]);
  assert.equal(view.high, '–');
  assert.equal(view.rainChance, '–');
  assert.equal(view.sunset, '–');
});

test('buildWeatherView copes with a cached forecast fetched before sunset was requested', () => {
  const raw = sampleForecast();
  delete raw.daily.sunset;
  assert.equal(core.buildWeatherView(raw, '2026-11-01T14:49', [1]).sunset, '–');
});

test('isForecastUsable rejects forecasts six hours old or more', () => {
  const hour = 60 * 60 * 1000;
  assert.equal(core.isForecastUsable(0, 5 * hour), true);
  assert.equal(core.isForecastUsable(0, 6 * hour), false);
});

test('forecastUrl includes the coordinates and the fields the view reads', () => {
  const url = core.forecastUrl({ latitude: 51.45, longitude: -2.59 });
  assert.match(url, /latitude=51\.45/);
  assert.match(url, /longitude=-2\.59/);
  assert.match(url, /timezone=auto/);
  ['apparent_temperature', 'precipitation_probability_max', 'is_day'].forEach((field) => {
    assert.ok(url.includes(field), field);
  });
});

function day(events, configured) {
  return { date: '2026-11-04', configured: configured || 1, events: events, failed: [] };
}

function timed(title, start, end) {
  return { title: title, calendar: 'Family', allDay: false, start: start, end: end };
}

test('buildEventsView shows an upcoming event at its start time', () => {
  const view = core.buildEventsView(day([timed('Dentist', '2026-11-04T09:30', '2026-11-04T10:30')]), '2026-11-04T08:00');
  assert.deepEqual(view.events, [{ time: '09:30', title: 'Dentist' }]);
  assert.equal(view.message, '');
});

test('buildEventsView shows an event in progress as until its end', () => {
  const view = core.buildEventsView(day([timed('Dentist', '2026-11-04T09:30', '2026-11-04T10:30')]), '2026-11-04T10:00');
  assert.equal(view.events[0].time, '\u2192 10:30');
});

test('buildEventsView drops an event once it has finished', () => {
  const view = core.buildEventsView(day([timed('Dentist', '2026-11-04T09:30', '2026-11-04T10:30')]), '2026-11-04T10:30');
  assert.deepEqual(view.events, []);
  assert.equal(view.message, 'Nothing else today');
});

test('buildEventsView keeps an event with no end until its start time passes', () => {
  const event = timed('Reminder', '2026-11-04T15:00', '2026-11-04T15:00');
  assert.equal(core.buildEventsView(day([event]), '2026-11-04T14:59').events[0].time, '15:00');
  assert.equal(core.buildEventsView(day([event]), '2026-11-04T15:00').events[0].time, '15:00');
  assert.deepEqual(core.buildEventsView(day([event]), '2026-11-04T15:01').events, []);
});

test('buildEventsView labels all-day events and keeps them all day', () => {
  const event = { title: 'Bins', calendar: 'Family', allDay: true, start: '2026-11-04T00:00', end: '2026-11-05T00:00' };
  assert.equal(core.buildEventsView(day([event]), '2026-11-04T23:59').events[0].time, 'All day');
});

test('buildEventsView shows an overnight event from yesterday as until its end', () => {
  const view = core.buildEventsView(day([timed('Night shift', '2026-11-03T22:00', '2026-11-04T06:00')]), '2026-11-04T05:00');
  assert.equal(view.events[0].time, '\u2192 06:00');
});

test('buildEventsView shows an event in progress past midnight as all day', () => {
  const view = core.buildEventsView(day([timed('Festival', '2026-11-03T22:00', '2026-11-05T06:00')]), '2026-11-04T05:00');
  assert.equal(view.events[0].time, 'All day');
});

test('buildEventsView shows an event that started today and runs past midnight as now', () => {
  const view = core.buildEventsView(day([timed('Party', '2026-11-04T22:00', '2026-11-05T01:00')]), '2026-11-04T23:00');
  assert.equal(view.events[0].time, 'Now');
});

test('buildEventsView says when nothing was on at all', () => {
  assert.equal(core.buildEventsView(day([]), '2026-11-04T08:00').message, 'Nothing on today');
});

test('buildEventsView does not name the calendar an event is from', () => {
  const events = [timed('Dentist', '2026-11-04T09:30', '2026-11-04T10:30')];
  assert.deepEqual(Object.keys(core.buildEventsView(day(events, 2), '2026-11-04T08:00').events[0]), ['time', 'title']);
});

test('buildEventsView does not claim an empty day when a calendar failed', () => {
  const payload = day([]);
  payload.failed = ['Family', 'Bins'];
  const view = core.buildEventsView(payload, '2026-11-04T08:00');
  assert.equal(view.message, '');
  assert.equal(view.warning, "Can't update Family, Bins");
});

test('buildEventsView returns null for a different day', () => {
  assert.equal(core.buildEventsView(day([]), '2026-11-05T00:01'), null);
});

const BINS = {
  configured: true,
  failed: false,
  collections: [{ date: '2026-11-06', bins: ['blue', 'green'] }, { date: '2026-11-13', bins: ['black'] }]
};

test('binsLabel joins colours in plain English', () => {
  assert.equal(core.binsLabel(['black']), 'Black');
  assert.equal(core.binsLabel(['blue', 'green']), 'Blue and green');
  assert.equal(core.binsLabel(['blue', 'green', 'black']), 'Blue, green and black');
});

test('buildBinsView shows tomorrow\'s bins from noon to midnight the day before', () => {
  assert.equal(core.buildBinsView(BINS, new Date(2026, 10, 5, 11, 59)), null);
  assert.equal(core.buildBinsView(BINS, new Date(2026, 10, 6, 0, 0)), null);
  assert.equal(core.buildBinsView(BINS, new Date(2026, 10, 4, 18, 0)), null);
  assert.deepEqual(core.buildBinsView(BINS, new Date(2026, 10, 5, 12, 0)),
    { title: 'Blue and green', bins: ['blue', 'green'], note: '' });
  assert.equal(core.buildBinsView(BINS, new Date(2026, 10, 12, 23, 59)).title, 'Black');
});

test('buildBinsView follows a collection moved by a bank holiday', () => {
  const moved = { configured: true, failed: false, collections: [{ date: '2026-12-26', bins: ['black'] }] };
  assert.equal(core.buildBinsView(moved, new Date(2026, 11, 24, 15, 0)), null);
  assert.deepEqual(core.buildBinsView(moved, new Date(2026, 11, 25, 15, 0)),
    { title: 'Black', bins: ['black'], note: '' });
});

test('buildBinsView flags a stale feed alongside tomorrow\'s bins', () => {
  const stale = { configured: true, failed: true, collections: BINS.collections };
  assert.equal(core.buildBinsView(stale, new Date(2026, 10, 5, 15, 0)).note, "Can't update the bin calendar");
});

test('buildBinsView does not claim a clear week when the feed failed', () => {
  const view = core.buildBinsView({ configured: true, failed: true, collections: [] }, new Date(2026, 10, 5, 15, 0));
  assert.equal(view.title, "Can't get the bin calendar");
  assert.equal(core.buildBinsView({ configured: false, collections: [] }, new Date(2026, 10, 5, 15, 0)), null);
});

test('buildSonosView shows while playing or recently paused', () => {
  const playing = { configured: true, available: true, state: 'playing', title: 'Song 2', artist: 'Blur', canNext: true, recent: true };
  assert.deepEqual(core.buildSonosView(playing), { title: 'Song 2', artist: 'Blur', playing: true, canNext: true });
  assert.equal(core.buildSonosView({ configured: true, available: true, state: 'paused', recent: true }).playing, false);
  assert.equal(core.buildSonosView({ configured: true, available: true, state: 'stopped', recent: false }), null);
  assert.equal(core.buildSonosView({ configured: true, available: false }), null);
  assert.equal(core.buildSonosView(null), null);
});

test('musicSubtitle names the kind unless the subtitle already does', () => {
  assert.equal(core.musicSubtitle({ kind: 'album', subtitle: 'Blur' }), 'Album · Blur');
  assert.equal(core.musicSubtitle({ kind: 'playlist', subtitle: 'Spotify Playlist' }), 'Spotify Playlist');
  assert.equal(core.musicSubtitle({ kind: 'station', subtitle: 'TuneIn Station' }), 'TuneIn Station');
  assert.equal(core.musicSubtitle({ kind: 'playlist', subtitle: '' }), 'Playlist');
  assert.equal(core.musicSubtitle({ kind: '', subtitle: '' }), '');
});

test('the timetable marks past and current lessons and names the gaps', () => {
  const payload = {
    configured: true,
    name: 'Robbie',
    date: '2026-11-06',
    lessons: [
      { start: '09:10', end: '09:50', subject: 'Maths', teacher: 'Ms X Lin', room: 'N11' },
      { start: '09:50', end: '10:30', subject: 'MFL - Spanish', teacher: 'Mr O J Peat', room: 'S17' },
      { start: '10:50', end: '12:10', subject: 'Games', teacher: 'Mrs P Girdwood', room: '' },
      { start: '14:00', end: '15:00', subject: 'PER - Religious Studies', teacher: 'Mr H N Craig', room: 'Room 3' }
    ]
  };
  const view = core.buildTimetableView(payload, new Date(2026, 10, 6, 10, 0));
  assert.equal(view.title, 'Robbie');
  assert.equal(view.day, 'Today');
  assert.deepEqual(view.rows.map((r) => r.kind === 'break' ? r.label + ' ' + r.time : r.state + ' ' + r.subject), [
    'past Maths', 'now Spanish', 'Break 10:30', ' Games', 'Lunch 12:10', ' Religious Studies'
  ]);
  assert.equal(view.rows[0].time, '09:10–09:50');
  assert.equal(view.rows[2].state, '');
  assert.equal(core.buildTimetableView(payload, new Date(2026, 10, 6, 10, 40)).rows[2].state, 'now');
  assert.equal(view.rows[0].detail, 'N11 · Ms X Lin');
  assert.equal(view.rows[3].detail, 'Mrs P Girdwood');

  const evening = core.buildTimetableView(payload, new Date(2026, 10, 5, 18, 0));
  assert.equal(evening.day, 'Tomorrow');
  assert.ok(evening.rows.every((r) => !r.state));
  assert.equal(core.buildTimetableView(payload, new Date(2026, 10, 4, 18, 0)).day, 'Friday 6 November');
});

test('the timetable says when it has run out, and hides when not set up', () => {
  assert.equal(core.buildTimetableView({ configured: false }, new Date()), null);
  assert.equal(core.buildTimetableView(null, new Date()), null);
  const view = core.buildTimetableView({ configured: true, name: 'Robbie', date: null, lessons: [], lastDate: '2026-11-13' },
    new Date(2026, 10, 14));
  assert.equal(view.message, 'No timetable saved after Friday 13 November.');
});

test('power and energy are formatted for a glance', () => {
  assert.equal(core.formatPower(2.414), '2.4 kW');
  assert.equal(core.formatPower(0.354), '350 W');
  assert.equal(core.formatPower(0), '0 W');
  assert.equal(core.formatPower(null), '–');
  assert.equal(core.formatEnergy(8.34), '8.3 kWh');
  assert.equal(core.formatEnergy(null), '–');
});

test('the solar view reads battery and grid direction', () => {
  const payload = {
    configured: true,
    available: true,
    failed: false,
    updatedAt: new Date(2026, 10, 6, 12, 5).getTime(),
    now: { solar: 2.41, house: 0.62, batteryLevel: 76.4, batteryCharge: 1.2, batteryDischarge: 0, gridImport: 0.01, gridExport: 0.55 },
    today: { generated: 8.3, used: 10.1, exported: 2.1, imported: null }
  };
  const view = core.buildSolarView(payload);
  assert.deepEqual(view.now.map((t) => [t.label, t.value, t.note]), [
    ['Solar', '2.4 kW', ''], ['House', '620 W', ''], ['Battery', '76%', 'Charging 1.2 kW'], ['Exporting', '550 W', '']
  ]);
  assert.deepEqual(view.today.map((t) => t.value), ['8.3 kWh', '10.1 kWh', '2.1 kWh', '–']);
  assert.equal(view.status, 'Updated 12:05');

  payload.failed = true;
  payload.now = { solar: 0, house: 0.4, batteryLevel: null, batteryCharge: null, batteryDischarge: null, gridImport: 0.4, gridExport: 0 };
  const stale = core.buildSolarView(payload);
  assert.deepEqual(stale.now.map((t) => t.label), ['Solar', 'House', 'Importing']);
  assert.equal(stale.status, "Can't update. Figures from 12:05");
  assert.equal(stale.warning, true);

  assert.equal(core.buildSolarView({ configured: true, available: false, failed: true }).message,
    "Can't reach FoxESS right now. Still trying.");
  assert.equal(core.buildSolarView({ configured: false }), null);
});

test('the solar chart breaks lines at gaps and picks a round kW scale', () => {
  const start = new Date(2026, 10, 6).getTime();
  const step = 5 * 60 * 1000;
  const history = {
    start,
    step,
    solar: [0, 0.4, null, 3.2],
    house: [0.5, null, null, 0.6],
    export: [null, null, null, null],
    import: [0.5, -0.01, null, null]
  };
  const chart = core.buildSolarChart(history);
  assert.deepEqual(chart.series.map((s) => s.label), ['Solar', 'House', 'Export', 'Import']);
  assert.deepEqual(chart.series[0].runs.map((r) => r.map((p) => p.kw)), [[0, 0.4], [3.2]]);
  assert.equal(chart.series[0].runs[0][0].x, 0.5 * step / 86400000);
  assert.deepEqual(chart.series[2].runs, []);
  assert.equal(chart.series[3].runs[0][1].kw, 0, 'never below the axis');
  assert.equal(chart.top, 4);
  assert.deepEqual(chart.yTicks, [0, 1, 2, 3, 4]);
  assert.deepEqual(chart.xTicks.map((t) => t.label), ['00:00', '06:00', '12:00', '18:00', '24:00']);
  assert.deepEqual(chart.xTicks.map((t) => t.x), [0, 0.25, 0.5, 0.75, 1]);

  history.solar[3] = 5.1;
  assert.deepEqual(core.buildSolarChart(history).yTicks, [0, 2, 4, 6]);
  assert.equal(core.buildSolarChart({ start, step, solar: [null], house: [], export: [], import: [] }), null);
  assert.equal(core.buildSolarChart(undefined), null);
});

test('Hive popup shows each heating zone and hot water with boost buttons', () => {
  const payload = {
    configured: true, available: true, failed: false, boostTemperature: 21, updatedAt: new Date(2026, 10, 6, 18, 5).getTime(),
    heating: [{ id: 'h', name: 'Receiver 1', online: true, mode: 'SCHEDULE', boost: null, active: true, temperature: 19.46, target: 18 }],
    hotWater: [{ id: 'w', name: 'Hot Water', online: true, mode: 'BOOST', boost: 75, active: true }]
  };
  const view = core.buildHiveView(payload);
  const [heating, water] = view.cards;
  assert.equal(heating.label, 'Heating');
  assert.equal(heating.value, '19.5°');
  assert.equal(heating.note, 'Schedule, set to 18°');
  assert.equal(heating.activity, 'Heating now');
  assert.equal(heating.actionsLabel, 'Boost to 21°');
  assert.deepEqual(heating.actions.map((a) => a.label), ['30 min', '1 hr', '2 hr']);
  assert.equal(water.value, 'On');
  assert.equal(water.note, 'Boosting, 1 hr 15 min left');
  assert.deepEqual(water.actions, [{ label: 'Stop boost', stop: true }]);
  assert.equal(view.status, 'Updated 18:05');
});

test('Hive popup names zones when there are several, and explains when it can\'t read Hive', () => {
  const zone = { online: true, mode: 'OFF', active: false, temperature: 17, target: 7 };
  const view = core.buildHiveView({
    configured: true, available: true, updatedAt: 0, boostTemperature: 21, hotWater: [],
    heating: [{ ...zone, id: 'a', name: 'Upstairs' }, { ...zone, id: 'b', name: 'Downstairs', online: false }]
  });
  assert.deepEqual(view.cards.map((c) => c.label), ['Upstairs', 'Downstairs']);
  assert.equal(view.cards[0].note, 'Off');
  assert.equal(view.cards[1].note, 'Offline');
  assert.equal(core.buildHiveView({ configured: false }), null);
  assert.match(core.buildHiveView({ configured: true, available: false, needsSignIn: true }).message, /hive-login/);
  assert.match(core.buildHiveView({ configured: true, available: false, failed: true }).message, /Can't reach Hive/);
});
