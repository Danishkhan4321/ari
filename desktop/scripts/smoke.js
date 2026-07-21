const { spawn } = require('node:child_process');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const electronBinary = require('electron');
const child = spawn(electronBinary, ['.'], {
  cwd: desktopRoot,
  env: { ...process.env, ARI_DESKTOP_SMOKE: 'true' },
  windowsHide: false,
  stdio: 'inherit'
});

const timeout = setTimeout(() => {
  console.error('Desktop smoke test exceeded 45 seconds.');
  child.kill('SIGKILL');
  process.exitCode = 1;
}, 45000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  if (code === 0) console.log('Desktop smoke window started and closed cleanly.');
  if (code && code !== 0) process.exitCode = code;
});
