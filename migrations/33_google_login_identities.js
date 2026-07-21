'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ari_user_identities (
      provider VARCHAR(32) NOT NULL,
      provider_subject VARCHAR(255) NOT NULL,
      user_phone VARCHAR(50) NOT NULL,
      email VARCHAR(320),
      display_name VARCHAR(120),
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, provider_subject)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ari_user_identities_user_phone
      ON ari_user_identities(user_phone);
    CREATE INDEX IF NOT EXISTS idx_ari_user_identities_email
      ON ari_user_identities(provider, LOWER(email));

    CREATE TABLE IF NOT EXISTS ari_desktop_auth_tickets (
      token_hash CHAR(64) PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ari_desktop_auth_tickets_expiry
      ON ari_desktop_auth_tickets(expires_at);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS ari_desktop_auth_tickets;
    DROP TABLE IF EXISTS ari_user_identities;
  `);
};
