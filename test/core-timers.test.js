'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

test('the slider runs logarithmically from 1 minute to 4 hours', () => {
  assert.equal(core.sliderToMinutes(0), 1);
  assert.equal(core.sliderToMinutes(core.TIMER_SLIDER_STEPS), 240);
  // Halfway along is about 15 minutes, not two hours.
  assert.equal(core.sliderToMinutes(core.TIMER_SLIDER_STEPS / 2), 15);
  assert.equal(core.sliderToMinutes(-50), 1);
  assert.equal(core.sliderToMinutes(5000), 240);
});

test('the slider snaps to coarser steps for longer times', () => {
  for (let p = 0; p <= core.TIMER_SLIDER_STEPS; p += 7) {
    const m = core.sliderToMinutes(p);
    if (m >= 120) {
      assert.equal(m % 10, 0, String(m));
    } else if (m >= 20) {
      assert.equal(m % 5, 0, String(m));
    }
  }
});

test('the slider round-trips the presets', () => {
  core.TIMER_PRESETS.forEach((m) => {
    assert.equal(core.sliderToMinutes(core.minutesToSlider(m)), m);
  });
});

test('countdowns round up and gain hours only when needed', () => {
  assert.equal(core.formatCountdown(25 * 60 * 1000), '25:00');
  assert.equal(core.formatCountdown(59.2 * 1000), '1:00');
  assert.equal(core.formatCountdown(1), '0:01');
  assert.equal(core.formatCountdown(0), '0:00');
  assert.equal(core.formatCountdown(-5000), '0:00');
  assert.equal(core.formatCountdown((90 * 60 + 5) * 1000), '1:30:05');
});

test('new timers take the lowest free colour', () => {
  const a = core.createTimer([], 25, 1000);
  const b = core.createTimer([a], 10, 2000);
  assert.equal(a.slot, 0);
  assert.equal(b.slot, 1);
  assert.equal(b.endsAt, 2000 + 10 * 60 * 1000);
  // Once the first is gone, the next timer reuses its colour.
  assert.equal(core.createTimer([b], 5, 3000).slot, 0);
  assert.notEqual(a.id, b.id);
});

test('the view lists timers soonest first with their state', () => {
  const now = 1000000;
  const view = core.buildTimersView([
    { id: 'a', minutes: 25, slot: 0, endsAt: now + 20 * 60 * 1000 },
    { id: 'b', minutes: 10, slot: 1, endsAt: now + 30 * 1000 },
    { id: 'c', minutes: 90, slot: 2, endsAt: now - 1000 }
  ], now);
  assert.deepEqual(view.map((t) => t.id), ['c', 'b', 'a']);
  assert.deepEqual(view.map((t) => t.state), ['done', 'soon', 'running']);
  assert.equal(view[0].remaining, 'Done');
  assert.equal(view[0].label, '1 hr 30 min');
  assert.equal(view[1].remaining, '0:30');
  assert.equal(view[2].fraction, 0.8);
  assert.equal(view[0].fraction, 0);
});

test('stored timers that are malformed are dropped', () => {
  assert.deepEqual(core.validTimers(null), []);
  assert.deepEqual(core.validTimers({}), []);
  assert.equal(core.validTimers([
    { id: 'a', minutes: 5, slot: 0, endsAt: 1 },
    { id: 'b', minutes: 0, slot: 1, endsAt: 1 },
    { id: 3, minutes: 5, slot: 1, endsAt: 1 },
    null
  ]).length, 1);
});
