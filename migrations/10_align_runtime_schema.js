/**
 * Align the fresh AWS/Postgres baseline with the schemas used by the current
 * runtime. The original baseline captured older plaintext OAuth and account
 * linking tables; CREATE TABLE IF NOT EXISTS in services cannot repair those
 * existing tables, so explicit ALTER migrations are required.
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'user_phone'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone_number'
      ) THEN
        ALTER TABLE users RENAME COLUMN user_phone TO phone_number;
      END IF;
    END $$;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS id BIGSERIAL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_briefing_enabled BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_briefing_time VARCHAR(10);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'google_tokens' AND column_name = 'access_token'
      ) THEN
        ALTER TABLE google_tokens ALTER COLUMN access_token DROP NOT NULL;
      END IF;
    END $$;
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS access_token_enc TEXT;
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS refresh_token_enc TEXT;
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS token_iv VARCHAR(64);
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS token_auth_tag VARCHAR(64);
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS refresh_iv VARCHAR(64);
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS refresh_auth_tag VARCHAR(64);
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS google_email VARCHAR(255);
    ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS token_expiry TIMESTAMP;
    CREATE INDEX IF NOT EXISTS idx_google_tokens_phone ON google_tokens(user_phone);

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'linked_accounts' AND column_name = 'primary_phone'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'linked_accounts' AND column_name = 'primary_user_id'
      ) THEN
        ALTER TABLE linked_accounts RENAME COLUMN primary_phone TO primary_user_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'linked_accounts' AND column_name = 'linked_phone'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'linked_accounts' AND column_name = 'platform_user_id'
      ) THEN
        ALTER TABLE linked_accounts RENAME COLUMN linked_phone TO platform_user_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'linked_accounts' AND column_name = 'created_at'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'linked_accounts' AND column_name = 'linked_at'
      ) THEN
        ALTER TABLE linked_accounts RENAME COLUMN created_at TO linked_at;
      END IF;
    END $$;

    ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
    ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT FALSE;
    ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS notify_platform VARCHAR(20);
    CREATE INDEX IF NOT EXISTS idx_linked_primary ON linked_accounts(primary_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_platform_unique ON linked_accounts(platform_user_id);

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS followup_cadence_minutes INTEGER;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMP;
    CREATE INDEX IF NOT EXISTS idx_tasks_next_followup
      ON tasks(next_followup_at) WHERE next_followup_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS delegated_tasks (
      id SERIAL PRIMARY KEY,
      owner_phone VARCHAR(20) NOT NULL,
      recipient_phone VARCHAR(20) NOT NULL,
      task_description TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      follow_up_minutes INTEGER,
      follow_up_count INTEGER DEFAULT 0,
      last_follow_up TIMESTAMP,
      next_follow_up TIMESTAMP,
      follow_up_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_delegated_tasks_followup
      ON delegated_tasks(follow_up_at) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      creator_phone VARCHAR(20) NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_anonymous BOOLEAN DEFAULT FALSE,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      closed_at TIMESTAMP,
      deadline TIMESTAMP,
      anonymous BOOLEAN DEFAULT FALSE,
      multi_select BOOLEAN DEFAULT FALSE,
      poll_type VARCHAR(20) DEFAULT 'poll',
      team_name VARCHAR(100)
    );
    CREATE INDEX IF NOT EXISTS idx_polls_creator ON polls(creator_phone);

    CREATE TABLE IF NOT EXISTS poll_votes (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE,
      voter_phone VARCHAR(20) NOT NULL,
      selected_option INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(poll_id, voter_phone)
    );
  `);
};

exports.down = async () => {
  throw new Error('Runtime schema alignment is not safely reversible.');
};
