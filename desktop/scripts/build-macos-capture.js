'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  console.log('Skipping macOS capture helper build on non-macOS host.');
  process.exit(0);
}

const desktopRoot = path.resolve(__dirname, '..');
const packageRoot = path.join(desktopRoot, 'native', 'macos');
const result = spawnSync('swift', ['build', '-c', 'release', '--package-path', packageRoot], { stdio: 'inherit', shell: false });
if (result.status !== 0) process.exit(result.status || 1);
const source = path.join(packageRoot, '.build', 'release', 'AriMeetingCapture');
const destinationDir = path.join(desktopRoot, 'build', 'native', 'macos');
const destination = path.join(destinationDir, 'ari-meeting-capture');
fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);
fs.chmodSync(destination, 0o755);
console.log(`Built ${destination}`);
