'use strict';

// Signs in to Hive once, answering the texted code, and has Hive remember this
// computer so the dashboard server can sign itself in from then on. Run it on
// the computer the server runs on: npm run hive-login

const path = require('node:path');
const readline = require('node:readline/promises');
const { loadWidgets } = require('../server/index.js');
const {
  createFileStorage, createPool, CognitoUser, AuthenticationDetails, POOL_ID, CLIENT_ID
} = require('../server/hive-auth.js');

const root = path.join(__dirname, '..');

async function checkPoolIds() {
  try {
    const page = await (await fetch('https://sso.hivehome.com/', { signal: AbortSignal.timeout(20000) })).text();
    const pool = /HiveSSOPoolId\s*=\s*'([^']+)'/.exec(page);
    const client = /HiveSSOPublicCognitoClientId\s*=\s*'([^']+)'/.exec(page);
    if (pool && client && (pool[1] !== POOL_ID || client[1] !== CLIENT_ID)) {
      console.warn('Hive has changed its sign-in settings. Update POOL_ID to ' + pool[1] +
        ' and CLIENT_ID to ' + client[1] + ' in server/hive-auth.js.');
    }
  } catch (err) {
    // Only a check: carry on with the ones we have.
  }
}

async function main() {
  const widgets = loadWidgets(process.env.WIDGETS_FILE || path.join(root, 'widgets.json'));
  if (!widgets.hive) {
    throw new Error('Add a "hive" section with your Hive username and password to widgets.json first. See README.md.');
  }
  await checkPoolIds();
  const file = process.env.HIVE_AUTH_FILE || path.join(root, 'hive-auth.json');
  const storage = createFileStorage(file);
  storage.clear();
  const user = new CognitoUser({ Username: widgets.hive.username, Pool: createPool(storage), Storage: storage });
  const details = new AuthenticationDetails({ Username: widgets.hive.username, Password: widgets.hive.password });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    await new Promise((resolve, reject) => {
      const callbacks = {
        onSuccess: (session, userConfirmationNecessary) => {
          if (!userConfirmationNecessary) {
            resolve();
            return;
          }
          // Without this the device is only half remembered, and Hive asks for a code next time.
          user.setDeviceStatusRemembered({ onSuccess: () => resolve(), onFailure: reject });
        },
        onFailure: reject,
        mfaRequired: async () => {
          const code = (await rl.question('Hive has texted you a code. Type it here: ')).trim();
          user.sendMFACode(code, callbacks);
        },
        totpRequired: async () => {
          const code = (await rl.question('Type the code from your authenticator app: ')).trim();
          user.sendMFACode(code, callbacks, 'SOFTWARE_TOKEN_MFA');
        },
        newPasswordRequired: () => reject(new Error('Hive wants a new password. Change it in the Hive app, then in widgets.json.'))
      };
      user.authenticateUser(details, callbacks);
    });
  } finally {
    rl.close();
  }
  const deviceKey = storage.getItem('CognitoIdentityServiceProvider.' + CLIENT_ID + '.' + user.getUsername() + '.deviceKey');
  console.log('Signed in to Hive. Saved to ' + path.relative(process.cwd(), file) + '.');
  if (!deviceKey) {
    console.warn('Hive did not remember this computer, so the server will need this run again when the sign-in runs out.');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
