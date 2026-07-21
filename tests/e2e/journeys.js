'use strict';

/**
 * Feature journeys — what a real user does, in the order they do it.
 *
 * Each journey is a lifecycle, not a single action, because that is where this
 * product breaks: the create works, and the rename silently targets nothing.
 * Every mutating step carries a `verify` that reads the database back.
 *
 * Names are prefixed `e2e-` so cleanup can find them and so a half-finished
 * run never leaves anything that looks like real user data.
 */

const G = 'e2e-investors';
const G2 = 'e2e-backers';
const LEAD = 'E2E Acme Corp';
const TEAM = 'e2e-design';

const one = async (query, sql, params) => (await query(sql, params)).rows[0] || null;

const JOURNEYS = [
  // ── contact groups: create → add → rename → emoji → remove → archive → delete
  {
    name: 'groups — full lifecycle',
    steps: [
      { say: `create a contact group called ${G}`,
        expect: /created|added|group/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM contact_groups WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, G]) },

      { say: `add ${LEAD} to my ${G} group`,
        // The lead does not exist yet, so an honest agent refuses. A pass here
        // is the REFUSAL — inventing a member would be the bug.
        expect: /no exact|not found|couldn't find|save|import|did not actually run/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            `SELECT COUNT(*)::int n FROM contact_group_members m
               JOIN contact_groups g ON g.id = m.group_id
              WHERE g.user_phone = ANY($1) AND LOWER(g.name) = LOWER($2)`, [phones, G]);
          return row.n === 0;
        } },

      { say: `rename my ${G} group to ${G2}`,
        expect: /renamed|now/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM contact_groups WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, G2]) },

      { say: `set the emoji for my ${G2} group to 💰`,
        expect: /emoji|updated|set|now uses/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            'SELECT emoji FROM contact_groups WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, G2]);
          return !!row && !!row.emoji;
        } },

      { say: 'show my contact groups',
        expect: new RegExp(G2, 'i') },

      { say: `delete the ${G2} group`,
        expect: /deleted|removed|confirm|sure|yes|waiting for approval/i,
        // Deletion is gated behind a confirmation, so the row SHOULD still be
        // here. Vanishing without a confirmed "yes" would be the bug.
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM contact_groups WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, G2]) },

      { say: 'yes',
        expect: /deleted|removed|done/i,
        verify: async ({ query, phones }) => !await one(query,
          'SELECT id FROM contact_groups WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, G2]) },
    ],
    cleanup: async ({ query, phones }) => {
      await query('DELETE FROM contact_groups WHERE user_phone = ANY($1) AND name ILIKE $2', [phones, 'e2e-%']);
    },
  },

  // ── CRM: add → move stage → log contact → archive → restore → delete
  {
    name: 'CRM leads — full lifecycle',
    steps: [
      { say: `add a new sales lead named ${LEAD} with email hello@e2e-acme.test, interested in the premium plan`,
        expect: /added|lead/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM sales_leads WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, LEAD]) },

      { say: `move ${LEAD} to negotiation`,
        expect: /negotiat|moved/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            'SELECT stage FROM sales_leads WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, LEAD]);
          return row && row.stage === 'negotiation';
        } },

      { say: `I called ${LEAD} this morning`,
        expect: /logged|contact|noted|updated/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            'SELECT last_contacted_at FROM sales_leads WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, LEAD]);
          return !!(row && row.last_contacted_at);
        } },

      // "Put them aside for now, they went quiet" is genuinely ambiguous — the
      // model read it as closed_lost, which is defensible. Archiving and
      // marking Lost are different CRM decisions, so the test says which one it
      // means rather than pinning the product to one reading of a vague phrase.
      { say: `archive ${LEAD} for now, they have gone quiet`,
        expect: /archiv|aside|paused/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            'SELECT archived_at FROM sales_leads WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, LEAD]);
          return !!(row && row.archived_at);
        } },

      { say: `bring ${LEAD} back`,
        expect: /restor|back|active/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            'SELECT archived_at FROM sales_leads WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)', [phones, LEAD]);
          return !!row && row.archived_at === null;
        } },

      { say: 'show my leads', expect: /acme/i },
    ],
    cleanup: async ({ query, phones }) => {
      await query('DELETE FROM sales_leads WHERE user_phone = ANY($1) AND name ILIKE $2', [phones, 'E2E %']);
    },
  },

  // ── campaigns: draft → inspect → rename/compose → archive
  {
    name: 'campaigns — draft and manage',
    steps: [
      // A campaign needs a recipient group with EMAILABLE members. Build the
      // whole chain here rather than depending on another journey's leftovers:
      // refusing to stage a campaign that would reach nobody is correct
      // behaviour, so an empty group would fail this for the wrong reason.
      { say: 'new sales lead E2E Campaign Contact, email reachme@e2e-acme.test',
        expect: /added|lead/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM sales_leads WHERE user_phone = ANY($1) AND email ILIKE $2',
          [phones, '%reachme@e2e-acme.test%']) },

      { say: 'create a contact group called e2e-campaign-list',
        expect: /created|group/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM contact_groups WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)',
          [phones, 'e2e-campaign-list']) },

      { say: 'add E2E Campaign Contact to my e2e-campaign-list group',
        expect: /added|group/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            `SELECT COUNT(*)::int n FROM contact_group_members m
               JOIN contact_groups g ON g.id = m.group_id
              WHERE g.user_phone = ANY($1) AND LOWER(g.name) = 'e2e-campaign-list'`, [phones]);
          return row.n > 0;
        } },

      { say: 'draft an email campaign to my e2e-campaign-list group about our new e2e pricing',
        expect: /draft|campaign|created/i,
        // Verify via the GROUP the campaign targets, not its subject text: the
        // model writes its own subject ("Introducing our new end-to-end
        // pricing"), which legitimately need not contain the token "e2e".
        verify: async ({ query, phones }) => !!await one(query,
          `SELECT c.id FROM bulk_email_campaigns c
             JOIN contact_groups g ON g.id = c.group_id
            WHERE c.user_phone = ANY($1) AND LOWER(g.name) = 'e2e-campaign-list'`, [phones]) },

      { say: 'show my campaigns', expect: /e2e|campaign|draft/i },

      { say: 'archive that e2e campaign',
        expect: /archiv|done|updated/i,
        verify: async ({ query, phones }) => {
          // Archiving stamps archived_at; status keeps tracking the send
          // lifecycle, so checking status here tested the wrong column.
          const row = await one(query,
            `SELECT c.archived_at FROM bulk_email_campaigns c
               JOIN contact_groups g ON g.id = c.group_id
              WHERE c.user_phone = ANY($1) AND LOWER(g.name) = 'e2e-campaign-list'`, [phones]);
          return !!(row && row.archived_at);
        } },
    ],
    cleanup: async ({ query, phones }) => {
      await query('DELETE FROM bulk_email_campaigns WHERE user_phone = ANY($1) AND subject ILIKE $2', [phones, '%e2e%']);
      await query('DELETE FROM contact_groups WHERE user_phone = ANY($1) AND name ILIKE $2', [phones, 'e2e-%']);
      await query('DELETE FROM sales_leads WHERE user_phone = ANY($1) AND name ILIKE $2', [phones, 'E2E %']);
    },
  },

  // ── tasks + reminders: the two highest-traffic writes
  {
    name: 'tasks and reminders — create, complete, list',
    steps: [
      { say: 'add a task to ship the e2e release notes',
        expect: /task|added/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM tasks WHERE user_phone = ANY($1) AND title ILIKE $2', [phones, '%e2e release notes%']) },

      { say: 'mark the e2e release notes task as done',
        expect: /done|complete/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            'SELECT status FROM tasks WHERE user_phone = ANY($1) AND title ILIKE $2', [phones, '%e2e release notes%']);
          return !!row && row.status !== 'pending';
        } },

      { say: 'remind me tomorrow at 9am to send the e2e invoice',
        expect: /remind|9/i,
        verify: async ({ query, phones }) => !!await one(query,
          `SELECT id FROM reminders WHERE user_phone = ANY($1) AND message ILIKE $2 AND status = 'pending'`,
          [phones, '%e2e invoice%']) },

      { say: 'show my reminders', expect: /e2e invoice/i },

      { say: 'already sent the e2e invoice',
        expect: /done|complete|marked/i,
        verify: async ({ query, phones }) => {
          const row = await one(query,
            'SELECT status FROM reminders WHERE user_phone = ANY($1) AND message ILIKE $2 ORDER BY id DESC',
            [phones, '%e2e invoice%']);
          return !!row && row.status === 'completed';
        } },
    ],
    cleanup: async ({ query, phones }) => {
      await query('DELETE FROM tasks WHERE user_phone = ANY($1) AND title ILIKE $2', [phones, '%e2e %']);
      await query('DELETE FROM reminders WHERE user_phone = ANY($1) AND message ILIKE $2', [phones, '%e2e %']);
    },
  },

  // ── notes: the save_memory/manage_notes boundary we just re-cut
  {
    name: 'notes — routing away from save_memory',
    steps: [
      { say: 'jot down that e2e pricing goes up in march',
        expect: /note|saved|jotted/i,
        // The verb decides: this belongs in notes, NOT the memory trunk.
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM notes WHERE user_phone = ANY($1) AND content ILIKE $2', [phones, '%e2e pricing%']) },

      { say: 'my e2e desk is on the third floor',
        expect: /remember|saved|got it|noted|third floor/i,
        // No note-taking verb + a personal fact => memory, not notes.
        // Memory lives in the versioned fact store (migration 29), not the
        // legacy `memories` table — that table stays empty on a current schema.
        verify: async ({ query, phones }) => !!await one(query,
          `SELECT id FROM ari_agent_memory_fact_versions
            WHERE user_phone = ANY($1) AND value ILIKE $2 AND is_current = TRUE`,
          [phones, '%third floor%']) },

      { say: 'show my notes', expect: /e2e/i },
    ],
    cleanup: async ({ query, phones }) => {
      await query('DELETE FROM notes WHERE user_phone = ANY($1) AND content ILIKE $2', [phones, '%e2e %']);
      await query('DELETE FROM ari_agent_memory_fact_versions WHERE user_phone = ANY($1) AND value ILIKE $2', [phones, '%e2e %']).catch(() => {});
    },
  },

  // ── team: create → add member → member details → invite link → 1:1 → onboarding
  {
    name: 'team — members, 1:1s, onboarding, invite',
    steps: [
      { say: `create a ${TEAM} team`,
        expect: /team|created/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT admin_phone FROM teams WHERE admin_phone = ANY($1) AND LOWER(team_name) = LOWER($2) LIMIT 1', [phones, TEAM]) },

      { say: `add E2E Priya 919900000077 to the ${TEAM} team`,
        expect: /added|priya/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM teams WHERE admin_phone = ANY($1) AND member_name ILIKE $2', [phones, '%Priya%']) },

      { say: `set E2E Priya's start date to 2026-01-15 on the ${TEAM} team`,
        expect: /saved|updated|start/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM team_member_meta WHERE admin_phone = ANY($1) AND joined_at IS NOT NULL', [phones]) },

      { say: `schedule a 1:1 with E2E Priya next friday at 4pm on the ${TEAM} team`,
        expect: /1:1|scheduled|friday/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM one_on_ones WHERE admin_phone = ANY($1) AND report_name ILIKE $2', [phones, '%Priya%']) },

      { say: `start onboarding for E2E Priya on the ${TEAM} team`,
        expect: /onboard|started/i,
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT id FROM team_onboardings WHERE admin_phone = ANY($1) AND member_name ILIKE $2', [phones, '%Priya%']) },

      { say: `get the invite link for the ${TEAM} team`,
        expect: /invite|code|join/i,
        // Match on the admin only: the stored team_name is whatever the agent
        // resolved, and asserting a spelling tests the harness, not the feature.
        verify: async ({ query, phones }) => !!await one(query,
          'SELECT code FROM team_invite_codes WHERE admin_phone = ANY($1)', [phones]) },

      { say: 'show my teams', expect: new RegExp(TEAM, 'i') },
    ],
    cleanup: async ({ query, phones }) => {
      await query('DELETE FROM one_on_ones WHERE admin_phone = ANY($1)', [phones]).catch(() => {});
      await query('DELETE FROM team_onboardings WHERE admin_phone = ANY($1)', [phones]).catch(() => {});
      await query('DELETE FROM team_member_meta WHERE admin_phone = ANY($1)', [phones]).catch(() => {});
      await query('DELETE FROM team_invite_codes WHERE admin_phone = ANY($1)', [phones]).catch(() => {});
      await query('DELETE FROM teams WHERE admin_phone = ANY($1) AND team_name ILIKE $2', [phones, 'e2e-%']).catch(() => {});
    },
  },

  // ── meetings: read-only here on purpose. Recordings come from the desktop
  // recorder, so a journey cannot create one — but the agent must handle the
  // empty case honestly rather than inventing a recording.
  {
    name: 'meetings — recordings read path',
    steps: [
      { say: 'show my meeting recordings',
        expect: /recording|no meeting|not been used|meetings page/i },
      { say: 'is the standup recording finished processing',
        expect: /could not find|no meeting|not been used|status|recording/i },
    ],
  },

  // ── multi-task: the capability the new model was chosen for
  {
    name: 'multi-task — two writes in one message',
    steps: [
      { say: 'add a task to prep the e2e demo and remind me tomorrow at 10am to rehearse it',
        expect: /task|remind/i,
        verify: async ({ query, phones }) => {
          const task = await one(query,
            'SELECT id FROM tasks WHERE user_phone = ANY($1) AND title ILIKE $2', [phones, '%e2e demo%']);
          const rem = await one(query,
            'SELECT id FROM reminders WHERE user_phone = ANY($1) AND message ILIKE $2', [phones, '%rehearse%']);
          return !!task && !!rem;
        } },
    ],
    cleanup: async ({ query, phones }) => {
      await query('DELETE FROM tasks WHERE user_phone = ANY($1) AND title ILIKE $2', [phones, '%e2e %']);
      await query('DELETE FROM reminders WHERE user_phone = ANY($1) AND message ILIKE $2', [phones, '%rehearse%']);
    },
  },
];

module.exports = { JOURNEYS };
