/**
 * Entity context layer — the shared substrate that connects meetings, CRM,
 * tasks, and emails so the assistant can reason across features.
 *
 * Two tables:
 *
 * 1. `associations` — polymorphic activity↔object links (HubSpot-style).
 *    A meeting "attended by" a contact, a meeting "discussed" a lead, an
 *    email "sent_to" a lead, a task "follow_up_of" a meeting. Auto-created
 *    by identity resolution (email/phone match), user commands, or the agent.
 *
 * 2. `entity_memories` — bi-temporal facts attached to business objects
 *    (a lead, a contact, a meeting, a team) rather than to chat history.
 *    Facts are never deleted: contradicted/superseded facts get
 *    `invalid_at` stamped so "what was true when" is preserved.
 *    `fact_key` is an optional slot name (e.g. 'budget', 'timeline') used
 *    to supersede older values of the same slot on write.
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS associations (
      id BIGSERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      source_type VARCHAR(30) NOT NULL,
      source_id TEXT NOT NULL,
      target_type VARCHAR(30) NOT NULL,
      target_id TEXT NOT NULL,
      relation VARCHAR(40) NOT NULL DEFAULT 'related_to',
      confidence REAL NOT NULL DEFAULT 1.0,
      created_by VARCHAR(20) NOT NULL DEFAULT 'auto',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_associations_edge UNIQUE
        (user_phone, source_type, source_id, target_type, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_associations_source
      ON associations(user_phone, source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_associations_target
      ON associations(user_phone, target_type, target_id);

    CREATE TABLE IF NOT EXISTS entity_memories (
      id BIGSERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      entity_type VARCHAR(30) NOT NULL,
      entity_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      fact_key VARCHAR(120),
      source_type VARCHAR(30),
      source_id TEXT,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      invalid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_entity_memories_entity
      ON entity_memories(user_phone, entity_type, entity_id)
      WHERE invalid_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_entity_memories_fts
      ON entity_memories
      USING GIN (to_tsvector('english', fact));
  `);
};

exports.down = async () => {
  throw new Error(
    '16_entity_context_layer is intentionally not reversible because cross-feature links and business facts must be preserved.'
  );
};
