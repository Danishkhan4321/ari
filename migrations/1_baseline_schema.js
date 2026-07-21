/**
 * Baseline schema — represents the state of the DB when migrations were
 * introduced.
 *
 * This migration is deliberately idempotent (uses `IF NOT EXISTS`) so running
 * it on an existing Supabase database is a no-op. Future migrations should
 * NOT use `IF NOT EXISTS` — they rely on the migration runner to track state.
 *
 * The actual tables already exist in production (created via the legacy
 * `ensureXxxSchema()` pattern in each service). This file serves to:
 *   1. Record that state in git
 *   2. Let fresh dev databases bootstrap via `npm run migrate`
 *   3. Give future ALTER migrations a stable baseline to reference
 */

exports.up = async (pgm) => {
  // Core tables — defined with raw SQL because the existing prod schema was
  // created piecemeal across services and we want byte-compatible DDL here,
  // not pgm.createTable (which has its own column-type conventions).
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_phone TEXT PRIMARY KEY,
      name TEXT,
      onboarded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_phone TEXT PRIMARY KEY,
      timezone TEXT,
      timezone_source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      target_phone TEXT,
      message TEXT NOT NULL,
      reminder_time TIMESTAMPTZ NOT NULL,
      status TEXT DEFAULT 'pending',
      is_recurring BOOLEAN DEFAULT FALSE,
      recurrence_pattern TEXT,
      recurrence_time TEXT,
      recurrence_days TEXT,
      except_days TEXT,
      next_occurrence TIMESTAMPTZ,
      last_sent TIMESTAMPTZ,
      retry_count INTEGER DEFAULT 0,
      priority TEXT DEFAULT 'normal',
      message_type TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_pending_time
      ON reminders(status, reminder_time) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_reminders_user_phone
      ON reminders(user_phone);

    CREATE TABLE IF NOT EXISTS memory_trunk (
      user_phone TEXT NOT NULL,
      category TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_phone, category, key_name)
    );

    CREATE TABLE IF NOT EXISTS conversation_history (
      id SERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_history_user_time
      ON conversation_history(user_phone, created_at DESC);

    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_name
      ON contacts(user_phone, LOWER(name));

    CREATE TABLE IF NOT EXISTS user_lists (
      id SERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      list_name TEXT NOT NULL,
      list_type TEXT DEFAULT 'general',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_phone, list_name)
    );

    CREATE TABLE IF NOT EXISTS list_items (
      id SERIAL PRIMARY KEY,
      list_id INTEGER REFERENCES user_lists(id) ON DELETE CASCADE,
      item_text TEXT NOT NULL,
      is_completed BOOLEAN DEFAULT FALSE,
      priority TEXT DEFAULT 'normal',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notes_user_topic
      ON notes(user_phone, LOWER(topic));

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      due_date TIMESTAMPTZ,
      assigned_to TEXT,
      assigned_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_user_status
      ON tasks(user_phone, status);

    CREATE TABLE IF NOT EXISTS google_tokens (
      user_phone TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      scopes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS microsoft_tokens (
      user_phone TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      scopes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS linked_accounts (
      id SERIAL PRIMARY KEY,
      primary_phone TEXT NOT NULL,
      linked_phone TEXT NOT NULL,
      platform TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (primary_phone, linked_phone)
    );
  `);
};

exports.down = async (pgm) => {
  // Baseline migration is intentionally NOT reversible — rolling back this
  // would drop the entire schema. If you need to start over, use a fresh DB.
  // Throwing here makes `npm run migrate:down` fail loudly instead of
  // silently destroying prod data.
  throw new Error('Baseline migration is not reversible. Use a fresh database instead.');
};
