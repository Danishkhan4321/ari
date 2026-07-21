// dashboard/lib/email-tracking.ts
// Schema + helpers for the per-recipient email tracking table. Both the
// bot (when sending) and the dashboard (when serving the pixel /
// recording opens) use the same table.
//
//   email_sends one row per (campaign × recipient) — or per (1:1 email)
//   when campaign_id is null. The tracking_token is what the pixel and
//   click-redirect endpoints look up.
import { query } from "./db";

let ready = false;

export async function ensureEmailSendsTable(): Promise<void> {
  if (ready) return;
  if (process.env.ARI_DEMO_MODE === "true") {
    ready = true;
    return;
  }
  await query(`
    CREATE TABLE IF NOT EXISTS email_sends (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(20) NOT NULL,
      campaign_id INT,
      recipient_email VARCHAR(255) NOT NULL,
      subject TEXT,
      gmail_message_id VARCHAR(120),
      tracking_token VARCHAR(40) UNIQUE NOT NULL,
      send_status VARCHAR(20) NOT NULL DEFAULT 'sent',
      send_error TEXT,
      opened_at TIMESTAMP,
      open_count INT NOT NULL DEFAULT 0,
      last_opened_at TIMESTAMP,
      clicked_at TIMESTAMP,
      click_count INT NOT NULL DEFAULT 0,
      last_clicked_at TIMESTAMP,
      sent_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_email_sends_campaign  ON email_sends(campaign_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_email_sends_user      ON email_sends(user_phone)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_email_sends_recipient ON email_sends(recipient_email)`);
  ready = true;
}
