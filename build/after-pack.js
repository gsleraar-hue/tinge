'use strict';

// Ad-hoc signing for macOS.
//
// A Mac with Apple Silicon refuses programs that carry no signature at all,
// even if you grant permission in System Settings. A real signature needs an
// Apple account at $99 a year, but there is a free middle ground: ad-hoc
// signing (`codesign -s -`). With that the app starts, and you only have to
// allow it once on first launch.
//
// electron-builder calls this file after it has assembled the .app, right
// before the dmg is made.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const name = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, name + '.app');

  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--timestamp=none', app],
      { stdio: 'inherit' }
    );
    console.log('  • ad-hoc signed    ' + app);

    // Check that it actually worked; a silent failure produces an app that
    // only refuses to start once it reaches someone else's Mac.
    execFileSync('codesign', ['--verify', '--verbose=1', app], { stdio: 'inherit' });
  } catch (err) {
    console.error('  • ad-hoc signing failed: ' + err.message);
    throw err;
  }
};
