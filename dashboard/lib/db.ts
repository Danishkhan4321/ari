// dashboard/lib/db.ts
// Shared Postgres pool for the dashboard. Reuses the same DATABASE_URL the
// bot uses, so reads/writes hit the same tables (no sync).
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { newDb } from "pg-mem";

declare global {
  // eslint-disable-next-line no-var
  var __ari_pg_pool: Pool | undefined;
}

function getPool(): Pool {
  if (!global.__ari_pg_pool) {
    if (process.env.ARI_DEMO_MODE === "true") {
      const db = newDb();
      const demoUser = process.env.ARI_DEMO_USER_PHONE || "+919000000001";
      db.public.none(`
        CREATE TABLE reminders (id SERIAL PRIMARY KEY, user_phone TEXT, message TEXT, reminder_time TIMESTAMP, status TEXT, is_recurring BOOLEAN, recurrence_pattern TEXT, recurrence_days TEXT, recurrence_time TEXT, next_occurrence TIMESTAMP, snooze_until TIMESTAMP, created_at TIMESTAMP);
        CREATE TABLE ari_chat_sessions (id UUID PRIMARY KEY, user_phone TEXT, title TEXT, is_legacy BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), archived_at TIMESTAMP);
        CREATE TABLE conversation_history (id SERIAL PRIMARY KEY, user_phone TEXT, role TEXT, content TEXT, created_at TIMESTAMP, session_id UUID, client_message_id UUID);
        CREATE TABLE ari_chat_submissions (user_phone TEXT, session_id UUID, client_message_id UUID, run_id TEXT, status TEXT DEFAULT 'queued', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY(user_phone, session_id, client_message_id));
        CREATE TABLE ari_chat_attachments (id UUID PRIMARY KEY, user_phone TEXT, session_id UUID, client_message_id UUID, file_name TEXT, mime_type TEXT, local_path TEXT, size_bytes BIGINT, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE contacts (id SERIAL PRIMARY KEY, user_phone TEXT, name TEXT, phone TEXT, email TEXT, company TEXT, title TEXT, linkedin_url TEXT, website TEXT, category TEXT, notes TEXT, updated_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE sales_leads (id SERIAL PRIMARY KEY, user_phone TEXT, name TEXT, email TEXT, phone TEXT, company TEXT, title TEXT, location TEXT, linkedin_url TEXT, website TEXT, company_domain TEXT, enrichment_status TEXT, enriched_at TIMESTAMP, stage TEXT, deal_value NUMERIC, source TEXT, notes TEXT, last_contacted_at TIMESTAMP, archived_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE contact_groups (id SERIAL PRIMARY KEY, user_phone TEXT, name TEXT, emoji TEXT, archived_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE contact_group_members (id SERIAL PRIMARY KEY, group_id INTEGER, member_kind TEXT, member_id INTEGER, added_at TIMESTAMP DEFAULT NOW(), UNIQUE(group_id, member_kind, member_id));
        CREATE TABLE bulk_email_campaigns (id SERIAL PRIMARY KEY, user_phone TEXT, group_id INTEGER, subject TEXT NOT NULL, body_template TEXT NOT NULL, recipient_count INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', scheduled_for TIMESTAMP, daily_send_limit INTEGER DEFAULT 100, archived_at TIMESTAMP, error TEXT, created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP);
        CREATE TABLE email_sends (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, campaign_id INTEGER, recipient_email TEXT NOT NULL, subject TEXT, gmail_message_id TEXT, tracking_token TEXT UNIQUE NOT NULL, send_status TEXT NOT NULL DEFAULT 'sent', send_error TEXT, opened_at TIMESTAMP, open_count INTEGER NOT NULL DEFAULT 0, last_opened_at TIMESTAMP, clicked_at TIMESTAMP, click_count INTEGER NOT NULL DEFAULT 0, last_clicked_at TIMESTAMP, sent_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE tasks (id SERIAL PRIMARY KEY, user_phone TEXT, title TEXT, description TEXT, status TEXT, priority TEXT, due_date TIMESTAMP, assigned_to TEXT, assigned_by TEXT, team_admin_phone TEXT, team_name TEXT, completed_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE teams (id SERIAL PRIMARY KEY, admin_phone TEXT, team_name TEXT, member_phone TEXT, member_name TEXT, role TEXT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(admin_phone, team_name, member_phone));
        CREATE TABLE standup_configs (id SERIAL PRIMARY KEY, admin_phone TEXT, team_name TEXT, name TEXT, questions JSONB, schedule_days TEXT, is_active BOOLEAN DEFAULT TRUE);
        CREATE TABLE standup_responses (id SERIAL PRIMARY KEY, config_id INTEGER, member_phone TEXT, question_index INTEGER, answer TEXT, response_date DATE, response_streak INTEGER, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE polls (id SERIAL PRIMARY KEY, creator_phone TEXT, team_name TEXT, question TEXT, options JSONB, deadline TIMESTAMP, is_anonymous BOOLEAN DEFAULT FALSE, multi_select BOOLEAN DEFAULT FALSE, status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE poll_votes (id SERIAL PRIMARY KEY, poll_id INTEGER, voter_phone TEXT, selected_option INTEGER, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(poll_id, voter_phone));
        CREATE TABLE leave_requests (id SERIAL PRIMARY KEY, employee_phone TEXT, employee_name TEXT, manager_phone TEXT, leave_type TEXT, start_date DATE, end_date DATE, status TEXT DEFAULT 'pending', half_day BOOLEAN DEFAULT FALSE, half_day_period TEXT, reason TEXT, responded_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE incidents (id SERIAL PRIMARY KEY, team_admin_phone TEXT, title TEXT, description TEXT, severity TEXT, status TEXT, reported_by_name TEXT, assigned_to_name TEXT, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE team_chats (id SERIAL PRIMARY KEY, team_admin_phone TEXT, team_name TEXT, type TEXT, name TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT NOW(), last_message_at TIMESTAMP);
        CREATE TABLE team_chat_members (chat_id INTEGER, member_phone TEXT, member_name TEXT, joined_at TIMESTAMP DEFAULT NOW(), last_read_at TIMESTAMP, last_whatsapp_notified_at TIMESTAMP, last_notified_wamid TEXT, PRIMARY KEY(chat_id, member_phone));
        CREATE TABLE team_chat_messages (id SERIAL PRIMARY KEY, chat_id INTEGER, from_phone TEXT, from_name TEXT, text TEXT, sent_via TEXT, wamid TEXT, reply_to_wamid TEXT, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE contact_enrichment_runs (id SERIAL PRIMARY KEY, user_phone TEXT, member_kind TEXT, member_id INTEGER, fingerprint TEXT, status TEXT, attempts INTEGER DEFAULT 1, result JSONB, error_code TEXT, started_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP, updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_phone, member_kind, member_id, fingerprint));
        CREATE TABLE meeting_recordings (id SERIAL PRIMARY KEY, user_phone TEXT, team_admin_phone TEXT, title TEXT, status TEXT, duration_seconds INTEGER, meeting_platform TEXT, summary TEXT, share_token TEXT, attendees TEXT, recording_url TEXT, transcript TEXT, action_items TEXT, decisions TEXT, mom TEXT, topics TEXT, source_type TEXT NOT NULL DEFAULT 'manual_recording', processing_stage TEXT NOT NULL DEFAULT 'captured', processing_error_code TEXT, processing_error_message TEXT, recording_object_key TEXT, recording_mime_type TEXT, assemblyai_transcript_id TEXT, canonical_transcript_segments JSONB, canonical_report JSONB, speaker_names JSONB NOT NULL DEFAULT '{}'::jsonb, suggested_tasks JSONB, report_markdown TEXT, capture_platform TEXT, capture_codec TEXT, processing_attempts INTEGER NOT NULL DEFAULT 0, capture_session_id TEXT UNIQUE, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE meeting_task_links (meeting_id INTEGER NOT NULL, suggestion_index INTEGER NOT NULL CHECK (suggestion_index >= 0), task_id INTEGER NOT NULL, created_by_phone TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY (meeting_id, suggestion_index), FOREIGN KEY (meeting_id) REFERENCES meeting_recordings(id) ON DELETE CASCADE, FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE);
        CREATE INDEX idx_meeting_task_links_task_id ON meeting_task_links(task_id);
        CREATE TABLE scheduled_emails (id SERIAL PRIMARY KEY, user_phone TEXT, recipients TEXT, subject TEXT, status TEXT, lead_id INTEGER, email_type TEXT, is_recurring BOOLEAN, recurrence_pattern TEXT, recurrence_days TEXT);
        CREATE TABLE notes (id SERIAL PRIMARY KEY, user_phone TEXT, topic TEXT, content TEXT, source TEXT);
        CREATE TABLE reading_list (id SERIAL PRIMARY KEY, user_phone TEXT, url TEXT, title TEXT, summary TEXT, category TEXT, status TEXT);
        CREATE TABLE knowledge_base (id SERIAL PRIMARY KEY, team_admin_phone TEXT, title TEXT, content TEXT, category TEXT, tags TEXT, created_by_name TEXT);
        CREATE TABLE habits (id SERIAL PRIMARY KEY, user_phone TEXT, name TEXT, frequency TEXT, target_count INTEGER, active BOOLEAN);
        CREATE TABLE habit_logs (id SERIAL PRIMARY KEY, habit_id INTEGER);
        CREATE TABLE focus_sessions (id SERIAL PRIMARY KEY, user_phone TEXT, duration_mins INTEGER, mode TEXT, status TEXT, label TEXT);
        CREATE TABLE expenses (id SERIAL PRIMARY KEY, user_phone TEXT, amount NUMERIC, currency TEXT, category TEXT, description TEXT, date DATE);
        CREATE TABLE self_standups (id SERIAL PRIMARY KEY, user_phone TEXT, date DATE, yesterday_done TEXT, today_plan TEXT, blockers TEXT, mood TEXT, energy_level INTEGER, created_at TIMESTAMP);
        CREATE TABLE agent_runs (id UUID PRIMARY KEY, user_phone TEXT, source TEXT, prompt_preview TEXT, status TEXT, model TEXT, steps INTEGER DEFAULT 0, outcome JSONB, error_code TEXT, session_id UUID, client_message_id UUID, started_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP);
        CREATE TABLE agent_run_events (id BIGSERIAL PRIMARY KEY, run_id UUID, user_phone TEXT, event_type TEXT, step INTEGER, tool_name TEXT, summary TEXT, payload JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW());
      `);
      db.public.none(`
        INSERT INTO reminders (user_phone,message,reminder_time,status,is_recurring,created_at) VALUES
          ('${demoUser}','Send Vercel proposal to Priya',NOW(),'pending',false,NOW()),
          ('${demoUser}','Review Ari onboarding feedback',NOW(),'pending',false,NOW()),
          ('${demoUser}','Daily pipeline review',NOW(),'pending',true,NOW()),
          ('${demoUser}','Share launch notes with the team',NOW(),'completed',false,NOW());
        INSERT INTO conversation_history (user_phone,role,content,created_at) VALUES
          ('${demoUser}','user','Create a follow-up for Priya after our demo',NOW()),
          ('${demoUser}','assistant','Drafted a follow-up and added it to your pipeline.',NOW()),
          ('${demoUser}','user','Remind me to review onboarding feedback at 4pm',NOW());
        INSERT INTO sales_leads (user_phone,name,email,company,stage,deal_value,source,notes) VALUES
          ('${demoUser}','Priya Shah','priya@northstar.io','Northstar Labs','proposal',18000,'Inbound','Demo completed. Security review next.'),
          ('${demoUser}','Arjun Mehta','arjun@vectorworks.in','VectorWorks','meeting',12000,'WhatsApp','Meeting booked for Thursday.'),
          ('${demoUser}','Maya Chen','maya@loopbase.co','Loopbase','qualified',9000,'Referral','Interested in sales workflow.'),
          ('${demoUser}','Rohan Kapoor','rohan@relayhq.com','Relay HQ','negotiation',24000,'Outbound','Procurement and pricing discussion.');
        INSERT INTO contacts (user_phone,name,phone,category,notes) VALUES
          ('${demoUser}','Neha Rao','+91 98765 12001','Investor','Early-stage SaaS investor'),
          ('${demoUser}','Kunal Bhatia','+91 98765 12002','Design partner','Runs a six-person sales team'),
          ('${demoUser}','Aisha Malik','+91 98765 12003','Advisor','B2B product operator');
        INSERT INTO contact_groups (user_phone,name,emoji) VALUES ('${demoUser}','Launch network','L');
        INSERT INTO contact_group_members (group_id,member_kind,member_id) VALUES
          (1,'lead',1),(1,'lead',2),(1,'contact',1);
        INSERT INTO bulk_email_campaigns (user_phone,group_id,subject,body_template,recipient_count,sent_count,failed_count,status,created_at,completed_at) VALUES
          ('${demoUser}',1,'Product launch follow-up','Hi {first_name}, thank you for taking the time to explore Ari. Here are the next steps and the pilot plan for your team.',3,3,0,'completed',NOW(),NOW()),
          ('${demoUser}',1,'July partner update','Hi {first_name}, sharing a short update on the product launch, new CRM workflows, and what we are building next.',3,2,1,'partial',NOW(),NOW());
        INSERT INTO email_sends (user_phone,campaign_id,recipient_email,subject,tracking_token,send_status,opened_at,open_count,last_opened_at,clicked_at,click_count,last_clicked_at,sent_at) VALUES
          ('${demoUser}',1,'priya@northstar.io','Product launch follow-up','demo-track-001','sent',NOW(),2,NOW(),NOW(),1,NOW(),NOW()),
          ('${demoUser}',1,'arjun@vectorworks.in','Product launch follow-up','demo-track-002','sent',NOW(),1,NOW(),NULL,0,NULL,NOW()),
          ('${demoUser}',1,'neha@example.com','Product launch follow-up','demo-track-003','sent',NULL,0,NULL,NULL,0,NULL,NOW()),
          ('${demoUser}',2,'priya@northstar.io','July partner update','demo-track-004','sent',NOW(),1,NOW(),NULL,0,NULL,NOW()),
          ('${demoUser}',2,'arjun@vectorworks.in','July partner update','demo-track-005','sent',NULL,0,NULL,NULL,0,NULL,NOW()),
          ('${demoUser}',2,'neha@example.com','July partner update','demo-track-006','failed',NULL,0,NULL,NULL,0,NULL,NOW());
        INSERT INTO tasks (user_phone,title,description,status,priority,due_date) VALUES
          ('${demoUser}','Ship the investor demo flow','Finish the end-to-end walkthrough.','pending','high',NOW()),
          ('${demoUser}','Review feedback from Northstar',NULL,'pending','medium',NOW()),
          ('${demoUser}','Prepare weekly product update',NULL,'pending','medium',NOW()),
          ('${demoUser}','Send March metrics summary',NULL,'completed','medium',NOW());
        INSERT INTO teams (admin_phone,team_name,member_phone,member_name,role) VALUES
          ('${demoUser}','ari-core','${demoUser}','Danish Khan','admin'),
          ('${demoUser}','ari-core','919876541201','Aisha Malik','lead'),
          ('${demoUser}','ari-core','919876541202','Kunal Bhatia','member');
        INSERT INTO tasks (user_phone,title,description,status,priority,due_date,assigned_to,assigned_by,team_admin_phone,team_name) VALUES
          ('${demoUser}','Review onboarding handoff','Check the final onboarding checklist before tomorrow''s customer walkthrough.','in_progress','high',NOW() + INTERVAL '1 day','919876541201','${demoUser}','${demoUser}','ari-core'),
          ('${demoUser}','Prepare launch FAQ','Turn the latest support questions into a concise launch FAQ.','pending','medium',NOW() + INTERVAL '3 days','919876541202','${demoUser}','${demoUser}','ari-core'),
          ('${demoUser}','Share weekly product update','Post the weekly progress summary in the team channel.','completed','low',NOW() - INTERVAL '1 day','919876541201','${demoUser}','${demoUser}','ari-core');
        INSERT INTO team_chats (team_admin_phone,team_name,type,name,created_by,last_message_at) VALUES
          ('${demoUser}','ari-core','group','Launch room','${demoUser}',NOW());
        INSERT INTO team_chat_members (chat_id,member_phone,member_name,last_read_at) VALUES
          (1,'${demoUser}','Danish Khan',NOW()),(1,'919876541201','Aisha Malik',NOW()),(1,'919876541202','Kunal Bhatia',NOW());
        INSERT INTO team_chat_messages (chat_id,from_phone,from_name,text,sent_via,created_at) VALUES
          (1,'919876541201','Aisha Malik','The onboarding guide is ready for review.','dashboard',NOW()),
          (1,'${demoUser}','Danish Khan','Great — I will add it to today''s launch checklist.','dashboard',NOW());
        INSERT INTO polls (creator_phone,team_name,question,options,status) VALUES
          ('${demoUser}','ari-core','Which launch asset should we prioritize today?','["Customer demo", "Security overview", "Onboarding guide"]','active');
        INSERT INTO poll_votes (poll_id,voter_phone,selected_option) VALUES
          (1,'${demoUser}',0),(1,'919876541201',0),(1,'919876541202',2);
        INSERT INTO leave_requests (employee_phone,employee_name,manager_phone,leave_type,start_date,end_date,status,reason) VALUES
          ('919876541202','Kunal Bhatia','${demoUser}','Personal',CURRENT_DATE,CURRENT_DATE,'pending','Appointment after lunch');
        INSERT INTO incidents (team_admin_phone,title,description,severity,status,reported_by_name,assigned_to_name) VALUES
          ('${demoUser}','Partner demo environment needs new credentials','The shared demo workspace token expires today.','medium','investigating','Aisha Malik','Danish Khan');
        INSERT INTO meeting_recordings
          (user_phone,title,status,processing_stage,duration_seconds,meeting_platform,summary,decisions,
           action_items,suggested_tasks,canonical_transcript_segments,speaker_names,share_token,attendees,source_type)
        VALUES
          ('${demoUser}','Northstar Labs product demo','completed','completed',1860,'Google Meet',
           'Priya approved a 30-day pilot. The security review is the final blocker and onboarding will begin next Tuesday.',
           '["Proceed with a 30-day pilot for Sales and Customer Success.","Complete one security checkpoint before onboarding."]',
           '[{"text":"Send the Northstar security overview","assigneeSpeakerId":"A","assignee":"Danish Khan","deadline":"2026-07-24"},{"text":"Prepare the pilot onboarding checklist","assigneeSpeakerId":"B","assignee":"Aisha Malik","deadline":"2026-07-25"}]',
           '[{"title":"Send Northstar security overview","suggestedAssigneeSpeakerId":"A","suggestedAssignee":"Danish Khan","reason":"Danish agreed to send it before the security review."},{"title":"Prepare pilot onboarding checklist","suggestedAssigneeSpeakerId":"B","suggestedAssignee":"Aisha Malik","reason":"Aisha owns pilot onboarding."}]',
           '[{"speakerId":"A","startMs":0,"endMs":6500,"text":"I will send the security overview by Thursday."},{"speakerId":"B","startMs":7000,"endMs":13500,"text":"I will prepare the onboarding checklist for the pilot."},{"speakerId":"C","startMs":14000,"endMs":20500,"text":"Once security signs off, we can start next Tuesday."}]',
           '{"A":"Danish Khan","B":"Aisha Malik","C":"Priya Shah"}','demo-northstar','Priya Shah, Danish Khan, Aisha Malik','manual_recording'),
          ('${demoUser}','Ari weekly product review','completed','completed',2520,'Google Meet',
           'The team aligned on the launch checklist, onboarding fixes, and the final dashboard polish.',
           '["Ship the revised onboarding flow this week.","Use the new warm workspace design across product surfaces."]',
           '[{"text":"Publish the revised onboarding checklist","assigneeSpeakerId":"B","assignee":"Aisha Malik","deadline":"2026-07-25"}]',
           '[{"title":"Publish revised onboarding checklist","suggestedAssigneeSpeakerId":"B","suggestedAssignee":"Aisha Malik","reason":"Aisha confirmed ownership during the review."}]',
           '[{"speakerId":"A","startMs":0,"endMs":5000,"text":"The workspace redesign is ready."},{"speakerId":"B","startMs":5500,"endMs":11000,"text":"I will publish the onboarding checklist this week."}]',
           '{"A":"Danish Khan","B":"Aisha Malik"}','demo-product','Danish Khan, Aisha Malik, Kunal Bhatia','manual_recording'),
          ('${demoUser}','VectorWorks discovery call','completed','completed',1440,'Zoom',
           'Arjun needs faster WhatsApp lead capture and reliable follow-up reminders for the sales team.',
           '["Start with the CRM lead-capture workflow."]',
           '[{"text":"Share the CRM workflow proposal","assigneeSpeakerId":"A","assignee":"Danish Khan","deadline":"2026-07-26"}]',
           '[{"title":"Share VectorWorks CRM workflow proposal","suggestedAssigneeSpeakerId":"A","suggestedAssignee":"Danish Khan","reason":"Danish committed to send the proposed workflow."}]',
           '[{"speakerId":"A","startMs":0,"endMs":5500,"text":"I will share the CRM workflow proposal by Friday."},{"speakerId":"B","startMs":6000,"endMs":11500,"text":"Fast WhatsApp lead capture is our first priority."}]',
           '{"A":"Danish Khan","B":"Arjun Mehta"}','demo-vector','Arjun Mehta, Danish Khan','manual_recording');
        INSERT INTO scheduled_emails (user_phone,recipients,subject,status,email_type,is_recurring) VALUES
          ('${demoUser}','priya@northstar.io','Next steps from our Ari demo','scheduled','follow_up',false),
          ('${demoUser}','arjun@vectorworks.in','Your WhatsApp sales workflow','queued','outreach',false),
          ('${demoUser}','team@ari.local','Weekly product update','scheduled','internal',true);
        INSERT INTO notes (user_phone,topic,content,source) VALUES
          ('${demoUser}','Launch narrative','Ari helps small teams finish work without leaving the chat where work starts.','manual'),
          ('${demoUser}','Northstar follow-up','Send a short security note, product overview, and pilot proposal by Friday.','meeting'),
          ('${demoUser}','Onboarding insights','Users understand reminders immediately. CRM and team boards need clearer first-run examples.','manual');
        INSERT INTO reading_list (user_phone,url,title,summary,category,status) VALUES
          ('${demoUser}','https://example.com','How sales teams adopt AI workflows','Notes on workflow adoption and trust.','Research','saved'),
          ('${demoUser}','https://example.com','WhatsApp business messaging guide','Reference for opt-in and template messages.','Operations','reading');
        INSERT INTO knowledge_base (team_admin_phone,title,content,category,tags,created_by_name) VALUES
          ('${demoUser}','Product messaging','Ari is the execution layer for WhatsApp-first teams.','Product','positioning,launch','Danish'),
          ('${demoUser}','Customer interview guide','Ask about their current workflow, missed follow-ups, and meeting hand-offs.','Research','customers,discovery','Danish');
        INSERT INTO habits (user_phone,name,frequency,target_count,active) VALUES
          ('${demoUser}','Daily customer conversations','daily',3,true),
          ('${demoUser}','Deep work block','daily',1,true),
          ('${demoUser}','Weekly pipeline review','weekly',1,true);
        INSERT INTO focus_sessions (user_phone,duration_mins,mode,status,label) VALUES
          ('${demoUser}',50,'deep work','completed','Investor deck'),
          ('${demoUser}',25,'focus','completed','CRM polish'),
          ('${demoUser}',45,'deep work','completed','Onboarding flow');
        INSERT INTO expenses (user_phone,amount,currency,category,description,date) VALUES
          ('${demoUser}',149,'USD','Infrastructure','Cloud hosting and database','2026-07-09'),
          ('${demoUser}',79,'USD','AI','Model usage','2026-07-06'),
          ('${demoUser}',45,'USD','Design','Product design tools','2026-07-02');
      `);
      const DemoPool = db.adapters.createPg().Pool;
      global.__ari_pg_pool = new DemoPool() as unknown as Pool;
      return global.__ari_pg_pool;
    }
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set");
    }
    global.__ari_pg_pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      // Supabase / RDS use TLS; pg auto-detects from URL but be explicit
      ssl: process.env.DATABASE_URL.includes("supabase.co")
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return global.__ari_pg_pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(text, params as never);
}

export type TransactionClient = Pick<PoolClient, "query">;

export async function withTransaction<T>(work: (client: TransactionClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure; a broken connection is discarded on release.
    }
    throw error;
  } finally {
    client.release();
  }
}
