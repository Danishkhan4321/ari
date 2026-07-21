const express = require('express');
const router = express.Router();
const microsoftAuthService = require('../services/microsoft-auth.service');
const messagingService = require('../services/messaging.service');
const { escapeHtml, validateOAuthState } = require('../utils/security');
const { oauthCallbackLimiter } = require('../middleware/abuse-protection');
const logger = require('../utils/logger');

// Microsoft OAuth callback endpoint — rate limited per IP (10/hour)
router.get('/callback', oauthCallbackLimiter, async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    logger.warn('Microsoft OAuth denied:', error, error_description);
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Authorization Denied</h2>
        <p>You declined the Microsoft authorization. No data was shared.</p>
        <p>You can try again by saying "connect outlook" in WhatsApp.</p>
      </body></html>
    `);
  }

  // Validate code and state format
  if (!code || typeof code !== 'string' || code.length > 2000 || !state) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Invalid Request</h2>
        <p>Missing authorization parameters. Please try again from WhatsApp.</p>
      </body></html>
    `);
  }

  const validState = validateOAuthState(state);
  if (!validState) {
    logger.security('ms_oauth_invalid_state', { ip: req.ip, stateLen: String(state).length });
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Invalid Request</h2>
        <p>Invalid authorization state. Please try again from WhatsApp.</p>
      </body></html>
    `);
  }

  try {
    const { userPhone, msEmail } = await microsoftAuthService.handleCallback(code, validState);

    try {
      await messagingService.send(userPhone,
        `Outlook connected!\n\nAccount: ${msEmail}\n\nYou can now:\n- "My meetings" (includes Outlook events)\n- "List my calendars"\n- Daily briefing includes Outlook events`
      );
    } catch (msgError) {
      logger.warn('Could not send WhatsApp confirmation:', msgError.message);
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Connected!</h2>
        <p>Your Microsoft account (${escapeHtml(msEmail)}) is now linked.</p>
        <p>You can close this window and return to WhatsApp.</p>
      </body></html>
    `);

  } catch (error) {
    logger.error('Microsoft OAuth callback error:', error.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Connection Failed</h2>
        <p>Something went wrong. Please try again by saying "connect outlook" in WhatsApp.</p>
      </body></html>
    `);
  }
});

module.exports = router;
