const logger = require('../utils/logger');

class HandlerRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(intent, handlerFn) {
    if (this.handlers.has(intent)) {
      logger.warn(`Handler already registered for intent: ${intent}, overwriting`);
    }
    this.handlers.set(intent, handlerFn);
    logger.info(`Registered handler for intent: ${intent}`);
  }

  has(intent) {
    return this.handlers.has(intent);
  }

  async handle(intent, message, context) {
    const handler = this.handlers.get(intent);
    if (!handler) {
      throw new Error(`No handler registered for intent: ${intent}`);
    }
    return await handler(message, context);
  }

  getRegisteredIntents() {
    return [...this.handlers.keys()];
  }
}

module.exports = new HandlerRegistry();
