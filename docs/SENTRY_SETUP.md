# Sentry Setup — Step by Step

This guide gets you from zero to seeing errors in Sentry in under 10 minutes.

## Why Sentry

Today, when Ari throws an error in production:
- It writes to `logs/error.log` on the EC2 box
- Nobody reads that file until a user complains
- You lose hours of MTTR per bug

After Sentry:
- You get a Slack alert (or email) within ~30 seconds of the first occurrence
- Each error shows: full stack trace, user ID, platform, what the user was doing, release version
- Errors are grouped by signature — you see "5 users hit this" not 5 separate incidents
- One click → "Replay in browser" equivalent for backend errors

## Step 1: Create a Sentry account (free tier)

1. Go to <https://sentry.io/signup/>
2. Sign up with your email (free — no credit card needed)
3. Free tier limits: 5,000 errors/month, 10,000 performance units/month — plenty for Ari at 500 DAU

## Step 2: Create a project

1. After login, Sentry asks "What are you building?" → choose **Node.js**
2. Name the project: `ari-backend`
3. Pick a team (or accept the default)
4. Click **Create Project**

## Step 3: Get your DSN

After creation, Sentry shows a page with the integration code. You want the **DSN** — it looks like:

```
https://abc123def456@o1234567.ingest.us.sentry.io/7890123
```

Copy that entire string.

If you miss the page, find it under:
- **Settings** → **Projects** → **ari-backend** → **Client Keys (DSN)**

## Step 4: Add it to your `.env`

On your EC2 box:

```bash
cd ~/whatsapp-assistant-supabase
vim .env
```

Add at the bottom:

```bash
# ── Sentry ──
SENTRY_DSN=https://abc123def456@o1234567.ingest.us.sentry.io/7890123
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.1

# ── Admin test endpoints (for verifying Sentry) ──
# Pick any random string. You'll use it to trigger test errors.
ADMIN_TEST_KEY=ari-admin-local-test
```

Save and restart PM2:

```bash
pm2 restart ari-backend
pm2 logs ari-backend --lines 30
```

You should see one of these log lines at startup:

```
Sentry: enabled (dsn: https://abc123...)
```

If you see nothing, Sentry is silently failing open (DSN wrong or env var not loaded).

## Step 5: Trigger a test error

From your local machine, run:

```bash
# Replace <IP> with your EC2 IP and <KEY> with your ADMIN_TEST_KEY
curl "http://<IP>:3000/debug/test-error?key=<KEY>&type=chain"
```

You should get a JSON response:

```json
{
  "ok": true,
  "captured": true,
  "errorMessage": "Sentry test: nested stack trace (deep → mid → shallow)",
  "note": "Check your Sentry dashboard within ~30 seconds..."
}
```

## Step 6: See the error in Sentry

1. Open <https://sentry.io>
2. Click **Issues** in the left sidebar
3. Within 30 seconds, you should see a new issue:
   - **Title:** `Error: Sentry test: nested stack trace`
   - **Project:** ari-backend
   - **Environment:** production
   - **Events:** 1
   - **Users:** 1 (wa_test_user_9999)

Click it. You'll see:

- **Full stack trace** with line numbers pointing to your code
- **Breadcrumbs** — the log lines that led to the error
- **Tags**: `platform:whatsapp`, `environment:production`, etc.
- **User:** id=wa_test_user_9999
- **Context:** `testScenario: "chain"`

This is what every real error will look like going forward.

## Step 7: Test the four error types

The `/debug/test-error` endpoint supports four scenarios:

| `type` | What it tests |
|--------|---------------|
| `sync` | Plain synchronous throw — classic exception capture |
| `async` | Rejected promise — tests async/await error flow |
| `message` | `Sentry.captureMessage()` — informational event (not an error) |
| `chain` | Deep stack trace with user + tag context — closest to real errors |

Try each:

```bash
curl "http://<IP>:3000/debug/test-error?key=<KEY>&type=sync"
curl "http://<IP>:3000/debug/test-error?key=<KEY>&type=async"
curl "http://<IP>:3000/debug/test-error?key=<KEY>&type=message"
curl "http://<IP>:3000/debug/test-error?key=<KEY>&type=chain"
```

Each appears in Sentry as a separate issue.

## Step 8: Set up Slack alerts (highly recommended)

1. In Sentry, go to **Settings** → **Integrations**
2. Find **Slack** → **Install**
3. Choose a channel (e.g. `#ari-alerts`)
4. Go back to your project → **Alerts** → **Create Alert Rule**
5. Simple rule: "When a new issue is created, send notification to Slack"

Now every new error class (not every occurrence) pings you in Slack with a link. Existing recurring errors get silently counted.

## Step 9: Configure alert quotas (stay free)

The free tier is 5,000 errors/month. To prevent a bug loop from eating your quota:

1. **Settings** → **Projects** → **ari-backend** → **Inbound Filters**
2. Enable **Filter out events from legacy browsers** (irrelevant for a bot)
3. Enable **Localhost IP address filter** (filters dev traffic)

And in your `.env`:

```bash
# Rate-limit Sentry captures (helps if you have a retry loop hitting the same error)
SENTRY_TRACES_SAMPLE_RATE=0.1   # 10% of transactions
```

## Troubleshooting

### "I set SENTRY_DSN but nothing shows up"
- Check the DSN is pasted correctly (no extra spaces, quotes, or line breaks in `.env`)
- Confirm `pm2 restart ari-backend` picked up the new env: `pm2 env 0 | grep SENTRY`
- Trigger the test endpoint — if THAT doesn't appear, the DSN is wrong

### "I see the test error but not real errors"
- Real errors may not propagate to `unhandledRejection` — check your try/catch blocks aren't swallowing them
- The logger auto-mirrors `logger.error(..., err)` to Sentry — confirm your error-path uses that pattern

### "I want to mute a noisy error"
- In Sentry UI: click the error → **Ignore** → choose "for 1 day" / "until affecting N more users" / etc.

## What Gets Sent to Sentry

- **Always:** Any error thrown in an Express route (via `Sentry.setupExpressErrorHandler`)
- **Always:** Any `process.on('unhandledRejection')` / `uncaughtException`
- **When called:** `captureException(err, extras)` from `utils/sentry.js`
- **When called:** `logger.error('msg', new Error(...))` — auto-mirrors to Sentry
- **When set:** User ID + platform tag (set at the top of each message handler)

## What Is NOT Sent

- Info/debug/warn logs (only errors)
- Health check traffic (`/health`, `/`, `/recording/:id/:token`)
- Retried transient errors (`ECONNRESET`, `ETIMEDOUT`, etc.) — these are already handled
- Nothing is sent if `SENTRY_DSN` is unset (full fail-open)
