'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSolar, signature, parseReal, parseReport, REAL_PATH, REPORT_PATH } = require('../server/solar.js');

const REAL = [{
  deviceSN: 'SN1',
  time: '2026-11-06 12:00:00 GMT+0000',
  datas: [
    { variable: 'pvPower', value: 2.41, unit: 'kW' },
    { variable: 'loadsPower', value: 0.62, unit: 'kW' },
    { variable: 'SoC', value: 76, unit: '%' },
    { variable: 'batChargePower', value: 1.2, unit: 'kW' },
    { variable: 'batDischargePower', value: 0, unit: 'kW' },
    { variable: 'gridConsumptionPower', value: 0, unit: 'kW' },
    { variable: 'feedinPower', value: 0.55, unit: 'kW' }
  ]
}];

const REPORT = [
  { variable: 'generation', unit: 'kWh', values: [1, 2, 3, 4, 5, 8.3] },
  { variable: 'loads', unit: 'kWh', values: [1, 2, 3, 4, 5, 10.1] },
  { variable: 'feedin', unit: 'kWh', values: [1, 2, 3, 4, 5, 2.1] },
  { variable: 'gridConsumption', unit: 'kWh', values: [1, 2, 3, 4, 5, 3.9] }
];

test('signs path, key and timestamp with literal backslash-r-backslash-n between them', () => {
  const expected = crypto.createHash('md5').update('/op/v0/device/real/query\\r\\nKEY\\r\\n1700000000000').digest('hex');
  assert.equal(signature('/op/v0/device/real/query', 'KEY', '1700000000000'), expected);
});

test('parses real-time power and today\'s totals from the month report', () => {
  assert.deepEqual(parseReal(REAL), {
    solar: 2.41, house: 0.62, batteryLevel: 76, batteryCharge: 1.2, batteryDischarge: 0, gridImport: 0, gridExport: 0.55
  });
  assert.deepEqual(parseReport(REPORT, 6), { generated: 8.3, used: 10.1, exported: 2.1, imported: 3.9 });
  // A system without a battery just doesn't report one.
  assert.equal(parseReal([{ datas: [{ variable: 'pvPower', value: 1 }] }]).batteryLevel, null);
  assert.throws(() => parseReal({}), /Unexpected/);
});

test('caches answers, asks for the right things and keeps old figures if FoxESS fails', async () => {
  let now = new Date(2026, 10, 6, 12, 0).getTime();
  const calls = [];
  let broken = false;
  const request = async (path, body) => {
    calls.push([path, body]);
    if (broken) {
      throw new Error('FoxESS error 41808');
    }
    return path === REAL_PATH ? REAL : REPORT;
  };
  const solar = createSolar({ apiKey: 'KEY', sn: 'SN1', request, nowMs: () => now });

  const first = await solar.status();
  assert.equal(first.available, true);
  assert.equal(first.failed, false);
  assert.equal(first.now.solar, 2.41);
  assert.equal(first.today.generated, 8.3);
  assert.deepEqual(calls.map((c) => c[0]), [REAL_PATH, REPORT_PATH]);
  assert.equal(calls[0][1].sn, 'SN1');
  assert.deepEqual([calls[1][1].year, calls[1][1].month, calls[1][1].dimension], [2026, 11, 'month']);

  now += 60 * 1000;
  await solar.status();
  assert.equal(calls.length, 2, 'served from cache');

  now += 5 * 60 * 1000;
  broken = true;
  const stale = await solar.status();
  assert.equal(stale.failed, true);
  assert.equal(stale.available, true);
  assert.equal(stale.today.generated, 8.3);

  // Yesterday's totals aren't shown as today's.
  now = new Date(2026, 10, 7, 0, 5).getTime();
  const nextDay = await solar.status();
  assert.equal(nextDay.available, false);
  assert.equal(nextDay.failed, true);
});
