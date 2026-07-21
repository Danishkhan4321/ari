const logger = require('./logger');

const RETRYABLE_STATUS_CODES = [429, 500, 503];
const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'];
const NON_RETRYABLE_STATUS_CODES = [400, 401, 403, 404];

async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 30000 } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const httpStatus = error.response?.status;
      const errorCode = error.code;

      if (NON_RETRYABLE_STATUS_CODES.includes(httpStatus)) {
        throw error;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      const isRetryable = RETRYABLE_STATUS_CODES.includes(httpStatus)
        || RETRYABLE_ERROR_CODES.includes(errorCode)
        || (!httpStatus && !errorCode);

      if (isRetryable) {
        const jitter = Math.random() * 0.5 + 0.75; // 0.75-1.25x
        const delay = Math.min(baseDelay * Math.pow(2, attempt) * jitter, maxDelay);
        logger.warn(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms (status: ${httpStatus || errorCode})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
}

module.exports = { withRetry };
