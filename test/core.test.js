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
      precipitation_probability_max: [80, 10]
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

test('nextHours starts after the current time and stops at the count', () => {
  const hours = core.nextHours(sampleForecast().hourly, '2026-11-01T14:49', 2);
  assert.deepEqual(hours.map((h) => h.label), ['15:00', '16:00']);
  assert.equal(hours[0].temp, '11°');
  assert.equal(hours[0].rain, '40%');
  assert.equal(hours[1].rain, '–');
});

test('nextHours excludes an hour that is exactly now', () => {
  const hours = core.nextHours(sampleForecast().hourly, '2026-11-01T15:00', 1);
  assert.equal(hours[0].label, '16:00');
});

test('nextHours returns what it has when the forecast runs out', () => {
  assert.equal(core.nextHours(sampleForecast().hourly, '2026-11-01T16:30', 6).length, 1);
  assert.equal(core.nextHours(sampleForecast().hourly, '2026-11-02T00:00', 6).length, 0);
});

test('buildWeatherView produces display strings for today', () => {
  const view = core.buildWeatherView(sampleForecast(), '2026-11-01T14:49', 2);
  assert.equal(view.temp, '12°');
  assert.equal(view.feelsLike, '8°');
  assert.equal(view.label, 'Light rain');
  assert.equal(view.icon, 'rain');
  assert.equal(view.high, '12°');
  assert.equal(view.low, '5°');
  assert.equal(view.rainChance, '80%');
  assert.equal(view.hours.length, 2);
});

test('buildWeatherView uses the new day after midnight on a cached forecast', () => {
  const view = core.buildWeatherView(sampleForecast(), '2026-11-02T00:10', 2);
  assert.equal(view.high, '15°');
  assert.equal(view.low, '7°');
  assert.equal(view.rainChance, '10%');
});

test('buildWeatherView shows dashes when today is not in the forecast', () => {
  const view = core.buildWeatherView(sampleForecast(), '2026-11-03T00:10', 2);
  assert.equal(view.high, '–');
  assert.equal(view.rainChance, '–');
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

test('geocodeUrl encodes the search text', () => {
  assert.match(core.geocodeUrl('St Albans&x=1'), /name=St%20Albans%26x%3D1$/);
});

function day(events, configured) {
  return { date: '2026-11-04', configured: configured || 1, events: events, failed: [] };
}

function timed(title, start, end) {
  return { title: title, calendar: 'Family', allDay: false, start: start, end: end };
}

test('buildEventsView shows an upcoming event at its start time', () => {
  const view = core.buildEventsView(day([timed('Dentist', '2026-11-04T09:30', '2026-11-04T10:30')]), '2026-11-04T08:00');
  assert.deepEqual(view.events, [{ time: '09:30', title: 'Dentist', calendar: '' }]);
  assert.equal(view.message, '');
});

test('buildEventsView shows an event in progress as until its end', () => {
  const view = core.buildEventsView(day([timed('Dentist', '2026-11-04T09:30', '2026-11-04T10:30')]), '2026-11-04T10:00');
  assert.equal(view.events[0].time, 'Until 10:30');
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
  assert.equal(view.events[0].time, 'Until 06:00');
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

test('buildEventsView names the calendar only when there are several', () => {
  const events = [timed('Dentist', '2026-11-04T09:30', '2026-11-04T10:30')];
  assert.equal(core.buildEventsView(day(events, 1), '2026-11-04T08:00').events[0].calendar, '');
  assert.equal(core.buildEventsView(day(events, 2), '2026-11-04T08:00').events[0].calendar, 'Family');
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

test('placeLabel distinguishes places and skips repeated or missing parts', () => {
  assert.equal(
    core.placeLabel({ name: 'Bristol', admin1: 'England', country: 'United Kingdom' }),
    'Bristol, England, United Kingdom'
  );
  assert.equal(core.placeLabel({ name: 'Paris', admin1: 'Paris', country: 'France' }), 'Paris, France');
  assert.equal(core.placeLabel({ name: 'Nowhere' }), 'Nowhere');
});
