const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Auto-load all handler files in this directory (except registry and index)
const handlersDir = __dirname;
const skipFiles = new Set(['handler-registry.js', 'index.js']);

fs.readdirSync(handlersDir)
  .filter(file => file.endsWith('.handler.js') && !skipFiles.has(file))
  .forEach(file => {
    try {
      require(path.join(handlersDir, file));
      logger.info(`Loaded handler: ${file}`);
    } catch (err) {
      logger.error(`Failed to load handler ${file}: ${err.message}`);
    }
  });

module.exports = require('./handler-registry');
