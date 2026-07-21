-- Create link_codes table for dashboard magic-link login
CREATE TABLE IF NOT EXISTS link_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL UNIQUE,
  user_id VARCHAR(50) NOT NULL,
  platform VARCHAR(20) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_link_codes_code ON link_codes(code);
CREATE INDEX IF NOT EXISTS idx_link_codes_user ON link_codes(user_id);
