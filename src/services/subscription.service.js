const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Legacy purchase/onboarding storage.
 *
 * Ari has one unrestricted feature set. These compatibility methods remain
 * because older webhook and onboarding paths still read purchase records, but
 * no record, tier, quota, or payment status can limit product access.
 */
class SubscriptionService {
  constructor() {
    this.tableReady = false;
  }

  async checkFeature() {
    return { allowed: true };
  }

  async checkFreeReminderQuotaMonthly() {
    return { allowed: true, remaining: null };
  }

  async checkFreeSearchQuotaMonthly() {
    return { allowed: true, remaining: null };
  }

  async checkFreeAIChatQuotaMonthly() {
    return { allowed: true, remaining: null };
  }

  async checkFreeVoiceQuotaMonthly() {
    return { allowed: true, remaining: null };
  }

  checkFreeReminderQuota() {
    return { allowed: true, remaining: null };
  }

  async checkAndIncrementFriendReminder() {
    return { allowed: true, remaining: null };
  }

  async checkTeamLimit(_userPhone, currentTeamCount = 0) {
    return {
      allowed: true,
      limit: null,
      used: Number(currentTeamCount) || 0,
      remaining: null,
    };
  }

  // Kept for older callers that display account metadata. It is never used
  // to authorize a feature.
  async getUserPlan() {
    return 'unrestricted';
  }

  invalidatePlanCache() {}

  async ensureTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          razorpay_payment_id VARCHAR(100) UNIQUE,
          razorpay_order_id VARCHAR(100),
          plan VARCHAR(50),
          amount INTEGER,
          currency VARCHAR(10),
          status VARCHAR(20) DEFAULT 'active',
          onboarding_step VARCHAR(30) DEFAULT 'awaiting_name',
          friend_reminders_sent INTEGER DEFAULT 0,
          friend_reminders_reset_at TIMESTAMP DEFAULT date_trunc('month', NOW()),
          subscribed_at TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          cancelled_at TIMESTAMP,
          refunded_at TIMESTAMP
        )
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_subscriptions_phone ON subscriptions(user_phone)');
      await query('CREATE INDEX IF NOT EXISTS idx_subscriptions_payment ON subscriptions(razorpay_payment_id)');
      this.tableReady = true;
    } catch (error) {
      logger.error('Error creating legacy purchase table:', error.message);
      this.tableReady = true;
    }
  }

  async createSubscription({ userPhone, paymentId, orderId, plan, amount, currency }) {
    await this.ensureTable();
    try {
      const result = await query(
        `INSERT INTO subscriptions
           (user_phone, razorpay_payment_id, razorpay_order_id, plan, amount, currency, status, onboarding_step)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', 'awaiting_name')
         ON CONFLICT (razorpay_payment_id) DO UPDATE SET
           user_phone = EXCLUDED.user_phone,
           razorpay_order_id = EXCLUDED.razorpay_order_id,
           amount = EXCLUDED.amount,
           currency = EXCLUDED.currency,
           status = 'active',
           updated_at = NOW()
         RETURNING *`,
        [userPhone, paymentId, orderId || null, plan || null, amount || null, currency || null]
      );
      return { success: true, subscription: result.rows[0] || null, isDuplicate: false };
    } catch (error) {
      logger.error('Error recording legacy purchase:', error.message);
      return { success: false, error: error.message };
    }
  }

  async handleRenewalCharged({ userPhone, status }) {
    try {
      await query(
        `UPDATE subscriptions
            SET status = $2, subscribed_at = CASE WHEN $2 = 'active' THEN NOW() ELSE subscribed_at END,
                updated_at = NOW()
          WHERE user_phone = $1 AND status IN ('active', 'expired')`,
        [userPhone, status === 'paid' ? 'active' : 'expired']
      );
    } catch (error) {
      logger.error(`Legacy purchase renewal update failed: ${error.message}`);
    }
  }

  async handleCancellation({ userPhone }) {
    try {
      await query(
        `UPDATE subscriptions
            SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
          WHERE user_phone = $1 AND status IN ('active', 'expired')`,
        [userPhone]
      );
    } catch (error) {
      logger.error(`Legacy purchase cancellation update failed: ${error.message}`);
    }
  }

  async handleRefund({ paymentId }) {
    try {
      await query(
        `UPDATE subscriptions
            SET status = 'refunded', refunded_at = NOW(), updated_at = NOW()
          WHERE razorpay_payment_id = $1`,
        [paymentId]
      );
    } catch (error) {
      logger.error(`Legacy purchase refund update failed: ${error.message}`);
    }
  }

  async backfillBriefingForPaidUsers() {
    return { totalPhones: 0, ok: 0, fail: 0 };
  }

  async getSubscription(userPhone) {
    await this.ensureTable();
    try {
      const result = await query(
        `SELECT * FROM subscriptions
          WHERE user_phone = $1
          ORDER BY subscribed_at DESC
          LIMIT 1`,
        [userPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching legacy purchase:', error.message);
      return null;
    }
  }

  async getOnboardingStep(userPhone) {
    await this.ensureTable();
    try {
      const result = await query(
        `SELECT onboarding_step FROM subscriptions
          WHERE user_phone = $1 AND onboarding_step != 'complete'
          ORDER BY subscribed_at DESC
          LIMIT 1`,
        [userPhone]
      );
      return result.rows[0]?.onboarding_step || null;
    } catch (error) {
      logger.error('Error fetching onboarding step:', error.message);
      return null;
    }
  }

  async updateOnboardingStep(userPhone, step) {
    await this.ensureTable();
    try {
      await query(
        `UPDATE subscriptions SET onboarding_step = $1, updated_at = NOW()
          WHERE user_phone = $2`,
        [step, userPhone]
      );
    } catch (error) {
      logger.error('Error updating onboarding step:', error.message);
    }
  }

  async saveUserName(userPhone, name) {
    try {
      await query(
        `INSERT INTO users (phone_number, name) VALUES ($1, $2)
         ON CONFLICT (phone_number) DO UPDATE SET name = $2, updated_at = NOW()`,
        [userPhone, name]
      );
    } catch (error) {
      logger.error('Error saving user name:', error.message);
    }
  }
}

module.exports = new SubscriptionService();
