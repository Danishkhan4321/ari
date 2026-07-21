'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const googleAuthService = require('../src/services/google-auth.service');

test('Docs, Sheets, and Slides use the existing drive.file grant', () => {
  const driveFile = 'https://www.googleapis.com/auth/drive.file';

  assert.deepEqual(googleAuthService.getRequiredScopes('docs'), [driveFile]);
  assert.deepEqual(googleAuthService.getRequiredScopes('sheets'), [driveFile]);
  assert.deepEqual(googleAuthService.getRequiredScopes('slides'), [driveFile]);
});
