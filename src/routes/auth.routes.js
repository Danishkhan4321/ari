const express = require('express');
const router = express.Router();
const googleAuthService = require('../services/google-auth.service');
const messagingService = require('../services/messaging.service');
const { escapeHtml, validateOAuthState } = require('../utils/security');
const { oauthCallbackLimiter } = require('../middleware/abuse-protection');
const logger = require('../utils/logger');

// Composio completes Google OAuth on its hosted callback and then returns here.
// Ari never receives or stores the Google authorization code or tokens.
router.get('/composio-callback', oauthCallbackLimiter, async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const product = typeof req.query.product === 'string' ? req.query.product : 'gmail';
  const remaining = typeof req.query.remaining === 'string'
    ? req.query.remaining.split(',').filter(Boolean)
    : [];
  const userPhone = googleAuthService.validateStateParam(state);
  if (!userPhone) {
    return res.status(400).send('<h2>Invalid or expired connection request</h2>');
  }

  try {
    // A completed connect must be visible immediately, not after the 60s
    // not-connected cache expires.
    googleAuthService.clearComposioNotConnected?.(userPhone);
    if (!await googleAuthService.isProductConnected(userPhone, product)) {
      return res.status(409).send('<h2>Google connection was not completed</h2><p>Please return to Ari and try again.</p>');
    }

    if (remaining.length) {
      const [next, ...rest] = remaining;
      const nextUrl = await googleAuthService.generateProductAuthUrl(userPhone, next, rest);
      return res.redirect(302, nextUrl);
    }

    const googleEmail = await googleAuthService.getGoogleEmail(userPhone);
    try {
      await messagingService.send(userPhone, `Google connected!${googleEmail ? `\n\nAccount: ${googleEmail}` : ''}`);
    } catch (messageError) {
      logger.warn('Could not send Composio connection confirmation:', messageError.message);
    }

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Connected!</h2>
        <p>Your Google account${googleEmail ? ` (${escapeHtml(googleEmail)})` : ''} is now linked to Ari.</p>
        <p>You can close this window and return to Ari.</p>
      </body></html>
    `);
  } catch (error) {
    logger.error('Composio callback error:', error.message);
    return res.status(500).send('<h2>Connection check failed</h2><p>Please return to Ari and try again.</p>');
  }
});

// OAuth callback endpoint — rate limited per IP (10/hour)
router.get('/callback', oauthCallbackLimiter, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logger.warn('OAuth denied:', error);
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Authorization Denied</h2>
        <p>You declined the Google authorization. No data was shared.</p>
        <p>You can try again by saying "connect google" in WhatsApp.</p>
      </body></html>
    `);
  }

  // Validate code and state format — reject injection attempts before hitting Google API
  if (!code || typeof code !== 'string' || code.length > 500 || !state) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Invalid Request</h2>
        <p>Missing authorization parameters. Please try again from WhatsApp.</p>
      </body></html>
    `);
  }

  const validState = validateOAuthState(state);
  if (!validState) {
    logger.security('oauth_invalid_state', { ip: req.ip, stateLen: String(state).length });
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Invalid Request</h2>
        <p>Invalid authorization state. Please try again from WhatsApp.</p>
      </body></html>
    `);
  }

  try {
    const { userPhone, googleEmail, grantedScopes } = await googleAuthService.handleCallback(code, validState);

    // Build feature list based on granted scopes
    const scopeStr = grantedScopes || '';
    let features = '- "Book a meeting tomorrow at 3pm"\n- "My meetings"\n- "Cancel my meeting"\n- "Email attendees about the meeting"';

    if (scopeStr.includes('gmail.readonly')) {
      features += '\n- "Check my inbox"\n- "Find email about [topic]"';
    }
    if (scopeStr.includes('drive')) {
      features += '\n- "Find file [name]"\n- "My drive"';
    }
    if (scopeStr.includes('documents')) {
      features += '\n- "Summarize doc [link]"';
    }
    if (scopeStr.includes('spreadsheets')) {
      features += '\n- "Read sheet [link]"';
    }

    // Send WhatsApp confirmation
    try {
      await messagingService.send(userPhone,
        `Google connected!\n\nAccount: ${googleEmail}\n\nYou can now:\n${features}`
      );
    } catch (msgError) {
      logger.warn('Could not send WhatsApp confirmation:', msgError.message);
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Connected!</h2>
        <p>Your Google account (${escapeHtml(googleEmail)}) is now linked.</p>
        <p>You can close this window and return to WhatsApp.</p>
      </body></html>
    `);

  } catch (error) {
    logger.error('OAuth callback error:', error.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Connection Failed</h2>
        <p>Something went wrong. Please try again by saying "connect google" in WhatsApp.</p>
      </body></html>
    `);
  }
});

module.exports = router;
