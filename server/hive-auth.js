'use strict';

// Signs in to Hive, which uses an AWS Cognito user pool, and hands out the ID
// token its API wants.
//
// Hive texts a code for every new sign-in, which a server can't answer. So
// `npm run hive-login` signs in once by hand, and tells Cognito to remember
// this computer as a device. Its tokens and device key go in hive-auth.json.
// After that the server renews the tokens by itself, and when they run out it
// signs in again with the password and the remembered device, which needs no
// code. If Hive ever asks for a code anyway, the server stops trying (so it
// doesn't send a text every minute) until hive-login is run again.

const fs = require('node:fs');
const { CognitoUserPool, CognitoUser, AuthenticationDetails } = require('amazon-cognito-identity-js');

// From the page at https://sso.hivehome.com/ (HiveSSOPoolId and
// HiveSSOPublicCognitoClientId). hive-login warns if they change.
const POOL_ID = 'eu-west-1_SamNfoWtf';
const CLIENT_ID = '3rl4i0ajrmtdm8sbre54p9dvd9';
const SIGN_IN_MESSAGE = 'Hive needs signing in: run npm run hive-login on the server';

class NeedsSignInError extends Error {
  constructor(message = SIGN_IN_MESSAGE) {
    super(message);
    this.needsSignIn = true;
  }
}

// The library's Storage interface, kept in a file so the server and hive-login
// share it. Read fresh each time, so a new hive-login is picked up straight away.
function createFileStorage(file) {
  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (err) {
      return {};
    }
  }
  function write(items) {
    fs.writeFileSync(file, JSON.stringify(items, null, 2), { mode: 0o600 });
  }
  return {
    getItem: (key) => {
      const items = read();
      return Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null;
    },
    setItem: (key, value) => {
      const items = read();
      items[key] = String(value);
      write(items);
    },
    removeItem: (key) => {
      const items = read();
      delete items[key];
      write(items);
    },
    clear: () => write({}),
    // Not part of the interface: changes whenever hive-login signs in afresh.
    stamp: () => {
      const items = read();
      return items['CognitoIdentityServiceProvider.' + CLIENT_ID + '.LastAuthUser'] || '';
    }
  };
}

function createPool(storage) {
  return new CognitoUserPool({ UserPoolId: POOL_ID, ClientId: CLIENT_ID, Storage: storage });
}

function deviceKeyOf(storage, user) {
  return storage.getItem('CognitoIdentityServiceProvider.' + CLIENT_ID + '.' + user.getUsername() + '.deviceKey');
}

function getSession(user) {
  return new Promise((resolve, reject) => {
    user.getSession((err, session) => (err ? reject(err) : resolve(session)));
  });
}

function createHiveAuth({ password, storage, pool = createPool(storage) }) {
  let blockedStamp = null; // The sign-in that Hive last asked for a code on.
  let pending = null;

  function signIn(user) {
    return new Promise((resolve, reject) => {
      const details = new AuthenticationDetails({ Username: user.getUsername(), Password: password });
      const askedForCode = () => {
        blockedStamp = storage.stamp();
        reject(new NeedsSignInError('Hive asked for a code: run npm run hive-login on the server'));
      };
      user.authenticateUser(details, {
        onSuccess: resolve,
        onFailure: reject,
        mfaRequired: askedForCode,
        totpRequired: askedForCode,
        selectMFAType: askedForCode,
        mfaSetup: askedForCode,
        newPasswordRequired: () => reject(new NeedsSignInError('Hive wants a new password: change it in the Hive app'))
      });
    });
  }

  async function fetchToken() {
    if (blockedStamp !== null && blockedStamp === storage.stamp()) {
      throw new NeedsSignInError();
    }
    // The user hive-login signed in as, by Cognito's own name for them, which
    // is what the tokens and the device are filed under.
    const user = pool.getCurrentUser();
    if (!user) {
      throw new NeedsSignInError();
    }
    let session;
    try {
      session = await getSession(user); // Renews with the refresh token if needed.
    } catch (err) {
      // Without a remembered device, signing in would text a code each time.
      if (!deviceKeyOf(storage, user)) {
        throw new NeedsSignInError();
      }
      console.log('Hive tokens could not be renewed (' + err.message + '), so signing in again');
      session = await signIn(user);
    }
    return session.getIdToken().getJwtToken();
  }

  // One sign-in at a time, however many requests want a token.
  function getToken() {
    if (!pending) {
      pending = fetchToken().finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  return { getToken };
}

module.exports = {
  createHiveAuth, createFileStorage, createPool, NeedsSignInError, POOL_ID, CLIENT_ID, CognitoUser, AuthenticationDetails
};
