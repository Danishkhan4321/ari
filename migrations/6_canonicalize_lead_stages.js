/**
 * Canonicalize sales_leads.stage to the single source of truth in
 * crm-shared.STAGES: new, contacted, replied, meeting, proposal,
 * negotiation, closed_won, closed_lost.
 *
 * Earlier the dashboard kanban + lead profile used a divergent 6-stage
 * vocabulary (lead/qualified/proposal/negotiation/won/lost) and persisted
 * those raw values, which computeStats() bucketed as "new" — so won/lost
 * deals were silently mis-counted as open in the KPI strip. The UI now writes
 * canonical stages; this backfills any rows still holding the legacy values.
 *
 *   lead      -> new
 *   qualified -> contacted
 *   discovery -> contacted
 *   won       -> closed_won
 *   lost      -> closed_lost
 *
 * proposal/negotiation already match canonical names; rows already on a
 * canonical value are untouched.
 */

exports.up = async (pgm) => {
  const result = await pgm.db.query(`SELECT to_regclass('sales_leads') AS table_name;`);
  if (!result.rows?.[0]?.table_name) return;

  await pgm.db.query(`
    UPDATE sales_leads
       SET stage = CASE LOWER(TRIM(stage))
         WHEN 'lead'      THEN 'new'
         WHEN 'qualified' THEN 'contacted'
         WHEN 'discovery' THEN 'contacted'
         WHEN 'won'       THEN 'closed_won'
         WHEN 'lost'      THEN 'closed_lost'
         ELSE stage
       END
     WHERE LOWER(TRIM(stage)) IN ('lead', 'qualified', 'discovery', 'won', 'lost');
  `);
};

exports.down = async () => {
  // Not safely reversible: 'qualified' and 'discovery' both map to
  // 'contacted', so the pre-migration value cannot be recovered. Mirrors the
  // baseline migration's irreversibility note rather than silently corrupting
  // data on rollback.
  throw new Error(
    '6_canonicalize_lead_stages is not reversible (qualified/discovery both collapse to contacted).'
  );
};
