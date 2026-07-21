const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const subscriptionService = require('../services/subscription.service');
const messagingService = require('../services/messaging.service');
const googleAuthService = require('../services/google-auth.service');
const microsoftAuthService = require('../services/microsoft-auth.service');
const logger = require('../utils/logger');

/**
 * Verify Razorpay webhook signature.
 * Razorpay sends X-Razorpay-Signature = HMAC-SHA256(rawBody, webhookSecret)
 */
function verifyRazorpaySignature(req, res, next) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.warn('RAZORPAY_WEBHOOK_SECRET not set — skipping signature verification (dev mode)');
    return next();
  }

  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    logger.security('razorpay_missing_signature', { ip: req.ip });
    return res.status(401).json({ error: 'Missing Razorpay signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(401).json({ error: 'Cannot verify signature' });
  }

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  try {
    const isValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!isValid) {
      logger.security('razorpay_invalid_signature', { ip: req.ip });
      return res.status(401).json({ error: 'Invalid Razorpay signature' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid Razorpay signature' });
  }

  next();
}

/**
 * Build onboarding welcome message after payment.
 */
function buildWelcomeMessage(plan) {
  const planLabel = plan === 'enterprise' ? 'Enterprise' : plan === 'starter' ? 'Starter' : 'Pro';
  return (
    `🎉 *Welcome to Ari ${planLabel}!*\n\n` +
    `Your payment was successful and your account is now active.\n\n` +
    `To personalise your experience, what should I call you? ` +
    `_(Just reply with your first name)_`
  );
}

/**
 * POST /webhook/razorpay
 * Handles Razorpay payment events.
 *
 * Required setup:
 *   - RAZORPAY_WEBHOOK_SECRET env var
 *   - Include `notes.whatsapp_phone` (e.g. "919876543210") when creating
 *     the Razorpay order/payment link so we know which WhatsApp number to message.
 */
router.post('/', verifyRazorpaySignature, async (req, res) => {
  // Acknowledge immediately — Razorpay expects 200 within 5 seconds
  res.status(200).json({ status: 'ok' });

  try {
    const event = req.body?.event;
    const payload = req.body?.payload;

    // Batch F2 (May 19 2026): handle subscription lifecycle events so
    // renewals, cancellations, and refunds actually update our state.
    // The original handler only watched payment.captured / order.paid —
    // anything else slipped through and left status='active' forever.
    if (event === 'subscription.charged') {
      const sub = payload?.subscription?.entity || {};
      const pay = payload?.payment?.entity || {};
      const phone = String(sub.notes?.whatsapp_phone || sub.notes?.phone || pay.contact || '').replace(/\D/g, '');
      if (phone && phone.length >= 10) {
        await subscriptionService.handleRenewalCharged({
          userPhone: phone,
          subscriptionId: sub.id,
          paymentId: pay.id,
          status: pay.status || sub.status
        });
      }
      return;
    }
    if (event === 'subscription.cancelled' || event === 'subscription.halted'
        || event === 'subscription.completed' || event === 'subscription.expired') {
      const sub = payload?.subscription?.entity || {};
      const phone = String(sub.notes?.whatsapp_phone || sub.notes?.phone || '').replace(/\D/g, '');
      if (phone && phone.length >= 10) {
        await subscriptionService.handleCancellation({
          userPhone: phone,
          subscriptionId: sub.id,
          reason: event
        });
      }
      return;
    }
    if (event === 'payment.refunded' || event === 'refund.processed') {
      const pay = payload?.payment?.entity || {};
      const refund = payload?.refund?.entity || {};
      const phone = String(pay.notes?.whatsapp_phone || pay.notes?.phone || pay.contact || '').replace(/\D/g, '');
      if (phone && phone.length >= 10) {
        await subscriptionService.handleRefund({
          userPhone: phone,
          paymentId: pay.id || refund.payment_id,
          amount: refund.amount || pay.amount,
          currency: refund.currency || pay.currency || 'INR'
        });
      }
      return;
    }

    // We only care about successful payments after this point
    if (event !== 'payment.captured' && event !== 'order.paid') {
      logger.info(`[Razorpay] Ignored event: ${event}`);
      return;
    }

    // Extract payment entity (structure differs slightly between event types)
    const paymentEntity =
      payload?.payment?.entity ||
      payload?.order?.entity; // fallback for order.paid

    if (!paymentEntity) {
      logger.warn('[Razorpay] Webhook payload missing payment entity');
      return;
    }

    const paymentId = paymentEntity.id;
    const orderId = paymentEntity.order_id;
    const amount = paymentEntity.amount; // in paise
    const currency = paymentEntity.currency || 'INR';
    const notes = paymentEntity.notes || {};

    // The WhatsApp phone must be passed in notes when creating the Razorpay order.
    // Example: notes: { whatsapp_phone: "919876543210", plan: "pro" }
    let userPhone = notes.whatsapp_phone || notes.phone || paymentEntity.contact;

    if (!userPhone) {
      logger.warn(`[Razorpay] Payment ${paymentId}: no whatsapp_phone in notes — cannot send onboarding message`);
      return;
    }

    // Normalise: strip leading + and spaces, keep digits only
    userPhone = String(userPhone).replace(/\D/g, '');
    if (!userPhone || userPhone.length < 10) {
      logger.warn(`[Razorpay] Payment ${paymentId}: invalid phone after normalisation: ${userPhone}`);
      return;
    }

    const plan = notes.plan || 'pro';

    logger.info(`[Razorpay] Payment captured: ${paymentId} for ${userPhone} (plan: ${plan})`);

    // Idempotent subscription creation
    const result = await subscriptionService.createSubscription({
      userPhone,
      paymentId,
      orderId,
      plan,
      amount,
      currency
    });

    if (!result.success) {
      logger.error(`[Razorpay] Failed to create subscription: ${result.error}`);
      return;
    }

    if (result.isDuplicate) {
      logger.info(`[Razorpay] Duplicate webhook for payment ${paymentId} — skipping`);
      return;
    }

    // Send welcome + onboarding kick-off via WhatsApp.
    // M8-N fix (Batch F2): until May 19 2026 a single failed welcome
    // send meant the user paid but never heard from us. Now we retry
    // up to 3 times with exponential backoff (2s, 4s, 8s). Fire-and-
    // forget so the webhook still acks 200 immediately to Razorpay.
    (async () => {
      const welcomeText = buildWelcomeMessage(plan);
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await messagingService.send(userPhone, welcomeText);
          if (attempt > 1) {
            logger.info(`[Razorpay] Welcome delivered on attempt ${attempt} to ${userPhone}`);
          }
          return;
        } catch (msgError) {
          lastErr = msgError;
          logger.warn(`[Razorpay] Welcome send attempt ${attempt}/3 failed for ${userPhone}: ${msgError.message}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
          }
        }
      }
      logger.error(`[Razorpay] Welcome message failed all 3 attempts for ${userPhone}: ${lastErr?.message}`);
      // Audit so an ops dashboard can surface "user paid but no welcome"
      try {
        require('../utils/audit-log').log('welcome_send_failed', {
          actor: 'razorpay',
          target: userPhone,
          meta: { plan, paymentId, error: lastErr?.message }
        });
      } catch (_) { /* swallow */ }
    })().catch(() => {});

  } catch (error) {
    logger.error('[Razorpay] Webhook handler error:', error.message);
  }
});

module.exports = router;
