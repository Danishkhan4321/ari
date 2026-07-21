'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const retiredFiles = [
  ['src', 'services', 'meeting-' + 'recall.service.js'],
  ['src', 'services', 'meeting-' + 'aws.service.js'],
  ['src', 'services', 'meeting-' + 'backend.js'],
  ['src', 'services', 'meeting-' + 'bot.service.js'],
  ['src', 'services', 'meeting-' + 'billing.service.js'],
  ['src', 'services', 'meeting-' + 'joiner.service.js'],
  ['src', 'services', 'meeting-' + 'recorder.service.js'],
  ['src', 'jobs', 'meeting-' + 'auto-join.job.js'],
  ['src', 'jobs', 'meeting-' + 'orphan-sweep.job.js'],
  ['src', 'handlers', 'meeting-' + 'bot.handler.js'],
  ['src', 'scripts', 'meeting-' + 'worker.js'],
];

function collect(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', 'build', 'out'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolute, results);
    else if (/\.(?:js|cjs|mjs|ts|tsx|json|md|ya?ml|example)$/.test(entry.name)) results.push(absolute);
  }
  return results;
}

test('retired meeting provider runtime is absent', () => {
  for (const parts of retiredFiles) {
    assert.equal(fs.existsSync(path.join(root, ...parts)), false, parts.join('/'));
  }

  const files = [
    ...collect(path.join(root, 'src')),
    ...collect(path.join(root, 'scripts')),
    ...collect(path.join(root, 'dashboard')),
    ...collect(path.join(root, 'desktop')),
    ...collect(path.join(root, 'website')),
    path.join(root, 'package.json'),
    path.join(root, '.env.example'),
  ];
  const forbidden = [
    new RegExp('meeting_' + 'bot', 'i'),
    new RegExp('meeting-' + '(?:recall|aws|backend|bot|billing|joiner)(?:\\.service)?', 'i'),
    new RegExp('meeting-' + '(?:auto-join|orphan-sweep|worker)', 'i'),
    new RegExp('(?:RECALL_(?:API|WEBHOOK|REGION|TRANSCRIPT|ROMANIZE)|SKRIBBY_|ATTENDEE_(?:API|WEBHOOK)|VEXA_|AWS_MEETING_|MEETING_BOT_)', 'i'),
    new RegExp('Recall' + '\\.ai|Skribby|Vexa', 'i'),
    new RegExp('[\"\\\']/(?:webhook/)?' + '(?:recall|aws-meeting-callback|meeting-complete|meeting-warning|meeting-status)[\"\\\']', 'i'),
  ];

  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push(`${path.relative(root, file)}: ${pattern}`);
    }
  }
  assert.deepEqual(violations, []);
});
