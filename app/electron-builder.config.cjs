const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Vite bundles the browser runtime. No Node dependencies belong in the app.
// The pinned DMG builder uses -noverify -noautoopen; also hide its temporary mount.
const hdiutil = require('dmg-builder/out/hdiuil');
const runHdiutil = hdiutil.hdiUtil;
hdiutil.hdiUtil = (args) => runHdiutil(args[0] === 'attach' ? [...args, '-nobrowse'] : args);

module.exports = {
  appId: 'dev.fetch.app',
  productName: 'fetch',
  directories: { output: 'dist/packages' },
  files: [
    'dist/electron/**/*',
    '!dist/electron/**/*.test.js',
    'dist/renderer/**/*',
    '!node_modules/**/*',
  ],
  extraMetadata: {
    fetchSearchLog: process.env.PROTO1_SEARCH_LOG === '1',
    fetchRelayUrl: process.env.PROTO1_RELAY_URL || 'http://127.0.0.1:8787',
  },
  asar: true,
  npmRebuild: false,
  // This builder has no ad hoc identity and skips afterSign without one. afterPack is its last step.
  afterPack: ({ electronPlatformName, appOutDir, packager }) => {
    if (electronPlatformName !== 'darwin') return;
    const bundle = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  },
  mac: {
    icon: 'build/icon.png',
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.music',
    identity: null,
    notarize: false,
    artifactName: '${productName}-${version}-mac-${arch}.${ext}',
  },
  // The DMG inherits the converted mac icon from getIconPath().
  dmg: { sign: false },
  win: {
    target: [{ target: 'zip', arch: ['x64'] }],
    signAndEditExecutable: false,
    artifactName: '${productName}-${version}-windows-${arch}-UNVERIFIED.${ext}',
  },
};
