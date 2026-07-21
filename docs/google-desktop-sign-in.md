# Google sign-in for Ari Desktop

Ari uses a normal system browser for Google sign-in. Google OAuth is never
loaded inside Electron. After Google verifies the account, the dashboard gives
the installed app a five-minute, single-use ticket. Ari exchanges that ticket
for an HTTP-only session cookie stored in Electron's persistent profile.

## Google Cloud configuration

1. Create an OAuth 2.0 **Web application** client in Google Cloud Console.
2. Configure the consent screen as **External**. While the app remains in
   testing, add every judge as a test user.
3. Add this authorized redirect URI, replacing the host with the final AWS URL:

   `https://app.your-domain.com/api/auth/google/callback`

4. Store these values only in the AWS service environment or Secrets Manager:

   ```dotenv
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_DASHBOARD_REDIRECT_URI=https://app.your-domain.com/api/auth/google/callback
   DASHBOARD_BASE_URL=https://app.your-domain.com
   ARI_SESSION_DAYS=365
   ```

Never add the client secret to GitHub or package it in the Windows installer.

## Database and installer

Run `npm run migrate` before deploying the dashboard. Migration 33 creates the
Google identity and one-time desktop ticket tables.

The NSIS installer registers the `ari://` protocol. A user signs in once and
stays signed in across app restarts until they log out, the server session is
revoked, or the configured session lifetime expires.
