const logger = require('../utils/logger');

const MAX_FALLBACK_CACHE = 10000;

class RedisClient {
  constructor() {
    this.baseUrl = process.env.UPSTASH_REDIS_REST_URL;
    this.token = process.env.UPSTASH_REDIS_REST_TOKEN;
    this.cache = new Map(); // Fallback in-memory cache (bounded)
  }

  async request(command, ...args) {
    if (!this.baseUrl || !this.token) {
      return this.fallbackOperation(command, args);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.baseUrl}/${command}/${args.join('/')}`, {
        headers: {
          Authorization: `Bearer ${this.token}`
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      const data = await response.json();
      return data.result;
    } catch (error) {
      logger.warn('Redis request failed, using fallback:', error.message);
      return this.fallbackOperation(command, args);
    }
  }

  fallbackOperation(command, args) {
    switch (command.toUpperCase()) {
      case 'GET':
        return this.cache.get(args[0]) || null;
      case 'SET':
        this.cache.set(args[0], args[1]);
        // Evict oldest if over limit
        if (this.cache.size > MAX_FALLBACK_CACHE) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
        return 'OK';
      case 'DEL':
        this.cache.delete(args[0]);
        return 1;
      case 'INCR':
        const val = (parseInt(this.cache.get(args[0])) || 0) + 1;
        this.cache.set(args[0], val.toString());
        return val;
      case 'EXPIRE':
        setTimeout(() => this.cache.delete(args[0]), parseInt(args[1]) * 1000);
        return 1;
      default:
        return null;
    }
  }

  async get(key) {
    return this.request('GET', key);
  }

  async set(key, value, options = {}) {
    if (options.ex) {
      await this.request('SET', key, value, 'EX', options.ex);
    } else {
      await this.request('SET', key, value);
    }
    return 'OK';
  }

  async del(key) {
    return this.request('DEL', key);
  }

  async incr(key) {
    return this.request('INCR', key);
  }

  async expire(key, seconds) {
    return this.request('EXPIRE', key, seconds);
  }
}

const redis = new RedisClient();

// Test connection
async function testConnection() {
  try {
    await redis.set('test', 'connected');
    const result = await redis.get('test');
    if (result === 'connected') {
      logger.info('Connected to Upstash Redis');
    }
    await redis.del('test');
  } catch (error) {
    logger.warn('Redis connection failed, using in-memory fallback');
  }
}

testConnection();

module.exports = redis;
