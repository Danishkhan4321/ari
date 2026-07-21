'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizedHostedUrl } = require('../src/config');

const dashboardUrl = normalizedHostedUrl(process.env.ARI_DESKTOP_DASHBOARD_URL);
if (!dashboardUrl) {
  throw new Error('ARI_DESKTOP_DASHBOARD_URL is required when building a public installer');
}

const outputPath = path.resolve(__dirname, '..', 'build', 'app-config.json');
fs.writeFileSync(outputPath, `${JSON.stringify({ dashboardUrl }, null, 2)}\n`, { mode: 0o600 });
console.log(`Prepared hosted Ari build for ${dashboardUrl}`);
