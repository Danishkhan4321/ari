import pg from "pg";

const { Client } = pg;
const user = process.env.ARI_DEMO_USER_PHONE || "+919000000001";
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: dbUrl });
await client.connect();

const sql = `
CREATE TABLE IF NOT EXISTS users (user_phone TEXT PRIMARY KEY, name TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS reminders (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, message TEXT NOT NULL, reminder_time TIMESTAMPTZ NOT NULL, status TEXT DEFAULT 'pending', is_recurring BOOLEAN DEFAULT FALSE, recurrence_pattern TEXT, recurrence_days TEXT, recurrence_time TEXT, next_occurrence TIMESTAMPTZ, snooze_until TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS conversation_history (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, category TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS sales_leads (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, name TEXT NOT NULL, email TEXT, company TEXT, stage TEXT, deal_value NUMERIC, source TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS contact_groups (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_group_members (group_id INTEGER NOT NULL, member_kind TEXT NOT NULL, member_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'normal', assigned_to TEXT, assigned_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS meeting_recordings (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, team_admin_phone TEXT, title TEXT NOT NULL, status TEXT, duration_seconds INTEGER, meeting_platform TEXT, summary TEXT, share_token TEXT, attendees TEXT, recording_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS scheduled_emails (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, recipients TEXT, subject TEXT, status TEXT, lead_id INTEGER, email_type TEXT, is_recurring BOOLEAN DEFAULT FALSE, recurrence_pattern TEXT, recurrence_days TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL, source TEXT DEFAULT 'manual', created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS reading_list (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, url TEXT, title TEXT, summary TEXT, category TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS knowledge_base (id SERIAL PRIMARY KEY, team_admin_phone TEXT NOT NULL, title TEXT, content TEXT, category TEXT, tags TEXT, created_by_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS habits (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, name TEXT, frequency TEXT, target_count INTEGER, active BOOLEAN DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS habit_logs (id SERIAL PRIMARY KEY, habit_id INTEGER NOT NULL, logged_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS focus_sessions (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, duration_mins INTEGER, mode TEXT, status TEXT, label TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS expenses (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, amount NUMERIC, currency TEXT, category TEXT, description TEXT, date DATE);
CREATE TABLE IF NOT EXISTS self_standups (id SERIAL PRIMARY KEY, user_phone TEXT NOT NULL, date DATE, yesterday_done TEXT, today_plan TEXT, blockers TEXT, mood TEXT, energy_level INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());
`;

await client.query(sql);
for (const table of ["reminders", "conversation_history", "contacts", "sales_leads", "contact_groups", "tasks", "meeting_recordings", "scheduled_emails", "notes", "reading_list", "knowledge_base", "habits", "focus_sessions", "expenses", "self_standups"]) {
  const scope = table === "knowledge_base" ? "team_admin_phone" : "user_phone";
  await client.query(`DELETE FROM ${table} WHERE ${scope} = $1`, [user]);
}
await client.query("INSERT INTO users (user_phone, name) VALUES ($1, 'Danish') ON CONFLICT (user_phone) DO UPDATE SET name = EXCLUDED.name", [user]);
await client.query("INSERT INTO reminders (user_phone, message, reminder_time, status, is_recurring, next_occurrence) VALUES ($1,'Send Vercel proposal to Priya', NOW() + interval '45 minutes','pending',false,NULL),($1,'Review Ari onboarding feedback', NOW() + interval '3 hours','pending',false,NULL),($1,'Daily pipeline review', NOW() + interval '1 day','pending',true,NOW() + interval '1 day'),($1,'Share launch notes with the team', NOW() - interval '1 day','completed',false,NULL)", [user]);
await client.query("INSERT INTO conversation_history (user_phone, role, content, created_at) VALUES ($1,'user','Create a follow-up for Priya after our demo',NOW() - interval '15 minutes'),($1,'assistant','Drafted a follow-up and added it to your pipeline.',NOW() - interval '14 minutes'),($1,'user','Remind me to review onboarding feedback at 4pm',NOW() - interval '8 minutes'),($1,'assistant','Done. I will remind you at 4pm.',NOW() - interval '7 minutes')", [user]);
const leads = await client.query("INSERT INTO sales_leads (user_phone,name,email,company,stage,deal_value,source,notes) VALUES ($1,'Priya Shah','priya@northstar.io','Northstar Labs','proposal',18000,'Inbound','Demo completed. Security review next.'),($1,'Arjun Mehta','arjun@vectorworks.in','VectorWorks','meeting',12000,'WhatsApp','Meeting booked for Thursday.'),($1,'Maya Chen','maya@loopbase.co','Loopbase','qualified',9000,'Referral','Interested in sales workflow.'),($1,'Rohan Kapoor','rohan@relayhq.com','Relay HQ','negotiation',24000,'Outbound','Procurement and pricing discussion.') RETURNING id,name", [user]);
await client.query("INSERT INTO contacts (user_phone,name,phone,category,notes) VALUES ($1,'Neha Rao','+91 98765 12001','Investor','Early-stage SaaS investor'),($1,'Kunal Bhatia','+91 98765 12002','Design partner','Runs a six-person sales team'),($1,'Aisha Malik','+91 98765 12003','Advisor','B2B product operator')", [user]);
const group = await client.query("INSERT INTO contact_groups (user_phone,name) VALUES ($1,'Design partners') RETURNING id", [user]);
for (const lead of leads.rows.slice(0, 3)) await client.query("INSERT INTO contact_group_members (group_id,member_kind,member_id) VALUES ($1,'lead',$2)", [group.rows[0].id, lead.id]);
await client.query("INSERT INTO tasks (user_phone,description,status,priority) VALUES ($1,'Ship the investor demo flow','pending','high'),($1,'Review feedback from Northstar','pending','medium'),($1,'Prepare weekly product update','pending','normal'),($1,'Send March metrics summary','completed','normal')", [user]);
await client.query("INSERT INTO meeting_recordings (user_phone,title,status,duration_seconds,meeting_platform,summary,share_token,attendees) VALUES ($1,'Northstar Labs product demo','complete',1860,'Google Meet','Priya wants the team workspace and CRM workflow. Next step: send security overview and a proposal.','demo-northstar','Priya Shah, Danish'),($1,'Ari weekly product review','complete',2520,'Google Meet','Team aligned on the launch checklist, onboarding fixes, and dashboard polish.','demo-product','Danish, Aisha, Kunal'),($1,'VectorWorks discovery call','complete',1440,'Zoom','Arjun needs fast lead capture from WhatsApp and follow-up reminders.','demo-vector','Arjun Mehta, Danish')", [user]);
await client.query("INSERT INTO scheduled_emails (user_phone,recipients,subject,status,email_type,is_recurring) VALUES ($1,'priya@northstar.io','Next steps from our Ari demo','scheduled','follow_up',false),($1,'arjun@vectorworks.in','Your WhatsApp sales workflow','queued','outreach',false),($1,'team@ari.local','Weekly product update','scheduled','internal',true)", [user]);
await client.query("INSERT INTO notes (user_phone,topic,content,source) VALUES ($1,'Launch narrative','Ari helps small teams finish work without leaving the chat where work starts.','manual'),($1,'Northstar follow-up','Send a short security note, product overview, and pilot proposal by Friday.','meeting'),($1,'Onboarding insights','Users understand reminders immediately. CRM and team boards need clearer first-run examples.','manual')", [user]);
await client.query("INSERT INTO reading_list (user_phone,url,title,summary,category,status) VALUES ($1,'https://example.com','How sales teams adopt AI workflows','Notes on workflow adoption and trust.','Research','saved'),($1,'https://example.com','WhatsApp business messaging guide','Reference for opt-in and template messages.','Operations','reading')", [user]);
await client.query("INSERT INTO knowledge_base (team_admin_phone,title,content,category,tags,created_by_name) VALUES ($1,'Product messaging','Ari is the execution layer for WhatsApp-first teams.','Product','positioning,launch','Danish'),($1,'Customer interview guide','Ask about their current workflow, missed follow-ups, and meeting hand-offs.','Research','customers,discovery','Danish')", [user]);
const habits = await client.query("INSERT INTO habits (user_phone,name,frequency,target_count,active) VALUES ($1,'Daily customer conversations','daily',3,true),($1,'Deep work block','daily',1,true),($1,'Weekly pipeline review','weekly',1,true) RETURNING id", [user]);
for (const habit of habits.rows) await client.query("INSERT INTO habit_logs (habit_id) VALUES ($1),($1),($1)", [habit.id]);
await client.query("INSERT INTO focus_sessions (user_phone,duration_mins,mode,status,label) VALUES ($1,50,'deep work','completed','Investor deck'),($1,25,'focus','completed','CRM polish'),($1,45,'deep work','completed','Onboarding flow')", [user]);
await client.query("INSERT INTO expenses (user_phone,amount,currency,category,description,date) VALUES ($1,149,'USD','Infrastructure','Cloud hosting and database',CURRENT_DATE - 2),($1,79,'USD','AI','Model usage',CURRENT_DATE - 5),($1,45,'USD','Design','Product design tools',CURRENT_DATE - 9)", [user]);
await client.query("INSERT INTO self_standups (user_phone,date,yesterday_done,today_plan,blockers,mood,energy_level) VALUES ($1,CURRENT_DATE - 1,'Completed CRM flow and meeting notes polish.','Finish deck screens and schedule design-partner calls.','Need final screenshots for investor deck.','focused',4),($1,CURRENT_DATE - 2,'Interviewed two design partners.','Refine onboarding and prep follow-ups.','None.','good',4)", [user]);

await client.end();
console.log("Demo data seeded for", user);
