// Ad-hoc sign a prepackaged macOS .app for local/CI test builds.
// This is not Developer ID signing or notarization.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { signAsync } = require('@electron/osx-sign');

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS only');
  }
  if (process.argv.length !== 3) {
    throw new Error('Usage: node scripts/macos-sign-adhoc.js /path/to/SAM WhatsApp Web.app');
  }

  const app = path.resolve(process.argv[2]);
  const entRoot = path.resolve(__dirname, '..', 'build');
  if (path.basename(app) !== 'SAM WhatsApp Web.app' || !fs.statSync(app).isDirectory()) {
    throw new Error('Unexpected app path: ' + app);
  }
  for (const name of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    if (!fs.statSync(path.join(entRoot, name)).isFile()) {
      throw new Error('Missing entitlements: ' + name);
    }
  }

  await signAsync({
    app,
    identity: '-',
    identityValidation: false,
    platform: 'darwin',
    preAutoEntitlements: false,
    strictVerify: false, // osx-sign 1.0.5 otherwise emits invalid --strict=true.
    optionsForFile(file) {
      return {
        hardenedRuntime: true,
        entitlements: path.join(
          entRoot,
          path.resolve(file) === app
            ? 'entitlements.mac.plist'
            : 'entitlements.mac.inherit.plist'
        )
      };
    }
  });

  console.log('MAC_CI_ADHOC_SIGNING=COMPLETE');
}

main().catch(error => {
  console.error('MAC_CI_ADHOC_SIGNING=FAILED');
  console.error(error);
  process.exitCode = 1;
});
