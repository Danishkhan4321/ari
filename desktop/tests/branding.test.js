const assert = require('node:assert/strict');
const { existsSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');

test('packages Ari icons for Windows and macOS', () => {
  const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.mac.icon, 'build/icon.icns');

  for (const file of ['icon.png', 'icon.ico', 'icon.icns']) {
    const target = path.join(desktopRoot, 'build', file);
    assert.equal(existsSync(target), true, `${file} is missing`);
    assert.ok(statSync(target).size > 1000, `${file} is unexpectedly small`);
  }
});

test('does not package the legacy wolf asset', () => {
  const pkg = readFileSync(path.join(desktopRoot, 'package.json'), 'utf8');
  assert.doesNotMatch(pkg, /logo-wolf/i);
});

test('startup screen uses the current Ari palette without a legacy logo block', () => {
  const startup = readFileSync(path.join(desktopRoot, 'src', 'startup.html'), 'utf8');
  assert.doesNotMatch(startup, /class="brand"|class="mark"|#8A65FF|#5A37D6|#D8CCFF|#6e49e8/i);
  assert.match(startup, /#f4d000/i);
  assert.match(startup, /Starting Ari/);
});
