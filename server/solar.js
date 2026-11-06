'use strict';

// Today's solar figures from the FoxESS Cloud Open API (www.foxesscloud.com):
// what the panels, house, battery and grid are doing now, and today's totals.
//
// The API allows about 1440 calls a day per inverter and one a second, and the
// cloud only updates every five minutes or so, so answers are cached and calls
// are spaced out. Each refresh makes two calls.

const crypto = require('node:crypto');

const BASE_URL = 'https://www.foxesscloud.com';
const REAL_PATH = '/op/v0/device/real/query';
const REPORT_PATH = '/op/v0/device/report/query';
const CACHE_MS = 4 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const CALL_GAP_MS = 1100;
const TIMEOUT_MS = 20 * 1000;

const REAL_VARIABLES = ['pvPower', 'loadsPower', 'SoC', 'batChargePower', 'batDischargePower',
  'gridConsumptionPower', 'feedinPower'];
const REPORT_VARIABLES = ['generation', 'loads', 'feedin', 'gridConsumption'];

// FoxESS signs path, key and timestamp joined by a literal backslash-r-backslash-n
// (their example builds it from a Python raw string), not a real line break.
function signature(path, apiKey, timestamp) {
  return crypto.createHash('md5').update(path + '\\r\\n' + apiKey + '\\r\\n' + timestamp).digest('hex');
}

function createFoxRequest(apiKey) {
  let lastCallAt = 0;
  let queue = Promise.resolve();

  async function call(path, body) {
    const wait = lastCallAt + CALL_GAP_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastCallAt = Date.now();
    const timestamp = String(Date.now());
    const response = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: apiKey,
        timestamp,
        signature: signature(path, apiKey, timestamp),
        lang: 'en'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const json = await response.json();
    if (json.errno !== 0) {
      throw new Error('FoxESS error ' + json.errno + (json.msg ? ' (' + json.msg + ')' : ''));
    }
    return json.result;
  }

  // One call at a time, so the gap between them holds.
  return (path, body) => {
    const result = queue.then(() => call(path, body));
    queue = result.catch(() => {});
    return result;
  };
}

function number(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !isFinite(n) ? null : n;
}

// Real-time result: [{ datas: [{ variable, value, unit }], time, deviceSN }].
function parseReal(result) {
  const values = {};
  const datas = Array.isArray(result) && result[0] && Array.isArray(result[0].datas) ? result[0].datas : null;
  if (!datas) {
    throw new Error('Unexpected real-time response');
  }
  datas.forEach((item) => {
    values[item.variable] = number(item.value);
  });
  const get = (name) => (name in values ? values[name] : null);
  return {
    solar: get('pvPower'),
    house: get('loadsPower'),
    batteryLevel: get('SoC'),
    batteryCharge: get('batChargePower'),
    batteryDischarge: get('batDischargePower'),
    gridImport: get('gridConsumptionPower'),
    gridExport: get('feedinPower')
  };
}

// Monthly report result: [{ variable, unit, values: [day 1, day 2, ...] }], in kWh.
function parseReport(result, day) {
  if (!Array.isArray(result)) {
    throw new Error('Unexpected report response');
  }
  const totals = {};
  result.forEach((item) => {
    totals[item.variable] = Array.isArray(item.values) ? number(item.values[day - 1]) : null;
  });
  const get = (name) => (name in totals ? totals[name] : null);
  return {
    generated: get('generation'),
    used: get('loads'),
    exported: get('feedin'),
    imported: get('gridConsumption')
  };
}

function createSolar({ apiKey, sn, request = createFoxRequest(apiKey), nowMs = Date.now }) {
  let data = null; // { updatedAt, now, today }
  let fetchedAt = 0;
  let failed = false;
  let pending = null;

  async function fetchData() {
    const started = new Date(nowMs());
    try {
      const real = parseReal(await request(REAL_PATH, { sn, variables: REAL_VARIABLES }));
      const today = parseReport(await request(REPORT_PATH, {
        sn,
        year: started.getFullYear(),
        month: started.getMonth() + 1,
        dimension: 'month',
        variables: REPORT_VARIABLES
      }), started.getDate());
      data = { updatedAt: started.getTime(), now: real, today };
      failed = false;
    } catch (err) {
      failed = true;
      console.error('FoxESS solar failed to update: ' + err.message);
    }
    fetchedAt = started.getTime();
  }

  async function status() {
    const now = nowMs();
    const age = now - fetchedAt;
    // Yesterday's totals would be wrong, not just old.
    const newDay = data && new Date(data.updatedAt).toDateString() !== new Date(now).toDateString();
    if (newDay) {
      data = null;
    }
    if (!fetchedAt || newDay || age >= (failed ? RETRY_MS : CACHE_MS)) {
      if (!pending) {
        pending = fetchData().finally(() => {
          pending = null;
        });
      }
      await pending;
    }
    return { configured: true, available: !!data, failed, ...(data || {}) };
  }

  return { status };
}

module.exports = { createSolar, signature, parseReal, parseReport, REAL_PATH, REPORT_PATH };
