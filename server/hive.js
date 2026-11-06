'use strict';

// Heating and hot water from Hive (British Gas): the thermostat's readings and
// modes, and boosts. Uses the same beekeeper API as the Hive app.

const BASE_URL = 'https://beekeeper.hivehome.com/1.0';
const CACHE_MS = 30 * 1000;
const RETRY_MS = 30 * 1000;
const TIMEOUT_MS = 20 * 1000;
const MIN_BOOST_MINUTES = 15;
const MAX_BOOST_MINUTES = 6 * 60;

function createHiveRequest(getToken) {
  return async (method, path, body) => {
    const response = await fetch(BASE_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        // The bare ID token, without "Bearer", as the Hive app sends it.
        Authorization: await getToken()
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

function number(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !isFinite(n) ? null : n;
}

// /products lists everything on the account. Heating is one product per zone;
// hot water, if there is a cylinder, is one more.
function parseProducts(products) {
  if (!Array.isArray(products)) {
    throw new Error('Unexpected products response');
  }
  const parse = (product) => {
    const props = product.props || {};
    const state = product.state || {};
    const mode = state.mode ? String(state.mode) : null;
    const previous = props.previous && props.previous.mode ? String(props.previous.mode) : null;
    return {
      id: String(product.id),
      name: state.name ? String(state.name) : '',
      online: props.online !== false,
      mode,
      // What it goes back to when a boost ends.
      previousMode: previous,
      // Minutes left, while boosting.
      boost: mode === 'BOOST' ? number(state.boost) : null,
      // Whether it's calling for heat right now.
      active: typeof props.working === 'boolean' ? props.working :
        state.status === 'ON' ? true : state.status === 'OFF' ? false : null
    };
  };
  return {
    heating: products.filter((p) => p && p.type === 'heating').map((p) => {
      const zone = parse(p);
      const props = p.props || {};
      const state = p.state || {};
      return {
        ...zone,
        temperature: number(props.temperature),
        target: number(state.target),
        previousTarget: props.previous ? number(props.previous.target) : null
      };
    }),
    hotWater: products.filter((p) => p && p.type === 'hotwater').map(parse)
  };
}

function createHive({ getToken, boostTemperature = 21, request = createHiveRequest(getToken), nowMs = Date.now }) {
  let data = null; // { updatedAt, heating, hotWater }
  let fetchedAt = 0;
  let failed = false;
  let needsSignIn = false;
  let pending = null;

  async function fetchData() {
    const started = nowMs();
    try {
      data = { updatedAt: started, ...parseProducts(await request('GET', '/products')) };
      failed = false;
      needsSignIn = false;
    } catch (err) {
      failed = true;
      needsSignIn = Boolean(err.needsSignIn);
      console.error('Hive failed to update: ' + err.message);
    }
    fetchedAt = started;
  }

  function refresh() {
    if (!pending) {
      pending = fetchData().finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  function report() {
    return { configured: true, available: !!data, failed, needsSignIn, boostTemperature, ...(data || {}) };
  }

  async function status() {
    const age = nowMs() - fetchedAt;
    if (!fetchedAt || age >= (failed ? RETRY_MS : CACHE_MS)) {
      await refresh();
    }
    return report();
  }

  async function find(id) {
    if (!data) {
      await refresh();
    }
    const heating = data && data.heating.find((p) => p.id === id);
    const hotWater = data && data.hotWater.find((p) => p.id === id);
    if (!heating && !hotWater) {
      throw new Error('No Hive heating or hot water with id ' + id);
    }
    return heating ? { type: 'heating', product: heating } : { type: 'hotwater', product: hotWater };
  }

  // Sends a change, then reads everything back so the popup shows what Hive now says.
  async function change(type, id, body) {
    await pending; // So a read in flight can't land after the change and undo it on screen.
    await request('POST', '/nodes/' + type + '/' + encodeURIComponent(id), body);
    fetchedAt = 0;
    await refresh();
    return report();
  }

  async function boost(id, minutes) {
    const mins = Math.round(Number(minutes));
    if (!(mins >= MIN_BOOST_MINUTES && mins <= MAX_BOOST_MINUTES)) {
      throw new Error('Boost minutes must be between ' + MIN_BOOST_MINUTES + ' and ' + MAX_BOOST_MINUTES);
    }
    const { type } = await find(id);
    return change(type, id, type === 'heating' ?
      { mode: 'BOOST', boost: mins, target: boostTemperature } :
      { mode: 'BOOST', boost: mins });
  }

  // Back to whatever it was doing before the boost, as the Hive app does.
  async function stopBoost(id) {
    const { type, product } = await find(id);
    const mode = product.previousMode && product.previousMode !== 'BOOST' ? product.previousMode : 'SCHEDULE';
    const body = { mode };
    if (type === 'heating' && (mode === 'MANUAL' || mode === 'OFF')) {
      body.target = product.previousTarget || 7;
    }
    return change(type, id, body);
  }

  return { status, boost, stopBoost };
}

module.exports = { createHive, parseProducts, MIN_BOOST_MINUTES, MAX_BOOST_MINUTES };
