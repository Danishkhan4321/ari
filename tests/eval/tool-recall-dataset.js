'use strict';

/**
 * Tool-recall dataset — "would the right tool even be ON the menu?"
 *
 * Before the model reasons at all, selectAriTools narrows ~90 tools down to a
 * visible subset (default 24) using lexical signals. If the correct tool does
 * not survive that cut, the model CANNOT call it no matter how well it reads
 * the request. That failure looks like "the AI is stupid" and is invisible in
 * normal testing.
 *
 * So every phrasing below is written the way a person actually talks, and
 * deliberately AVOIDS the tool's own obvious keyword wherever a natural
 * alternative exists. "cancel my reminder" proves nothing — the word
 * "reminder" is in the alias table. "scratch that, I don't need the nudge"
 * is the real test.
 *
 * Adding a tool without adding phrasings here fails the coverage test in
 * tests/tool-recall.test.js — the dataset cannot silently rot.
 *
 * EXCLUDED tools are listed at the bottom with reasons: they are reached
 * through conversation state (an open confirmation), not through phrasing, so
 * menu recall is not the mechanism that routes them.
 */

const CASES = [
  // ── reminders ──────────────────────────────────────────────────────────
  { tool: 'set_reminder', says: [
    'nudge me at 6 about the passport thing',
    'poke me tomorrow morning so I do not forget the rent',
    'buy milk on the way home at 7pm',
  ] },
  { tool: 'view_reminders', says: [
    'what am I supposed to be doing today',
    'show me everything you are holding for me',
  ] },
  { tool: 'update_reminder', says: [
    'push the 6pm one to 8',
    'move that nudge to tomorrow instead',
  ] },
  { tool: 'cancel_reminder', says: [
    'scratch that, I do not need the nudge anymore',
    'drop the one about the rent',
  ] },
  { tool: 'complete_reminder', says: [
    'already handled the dentist thing',
    'did that one, tick it off',
    'finished the passport renewal',
  ] },
  { tool: 'briefing_toggle', says: [
    'stop sending me the morning summary',
    'turn the daily digest back on',
  ] },
  { tool: 'remind_all_calendar', says: [
    'ping me before every meeting from now on',
    'I want a heads up ahead of all my events',
  ] },

  // ── calendar ───────────────────────────────────────────────────────────
  { tool: 'create_calendar_event', says: [
    'block an hour with Neha on friday',
    'put a design sync in for monday 11',
  ] },
  { tool: 'view_calendar', says: [
    'what have I got on friday',
    'am I free thursday afternoon',
  ] },
  { tool: 'reschedule_calendar_event', says: [
    'move the 3pm to 5',
    'push friday sync to monday',
  ] },
  { tool: 'cancel_calendar_event', says: [
    'drop the 3pm with Neha',
    'kill tomorrow standup, not happening',
  ] },
  { tool: 'list_calendars', says: [
    'which calendars can you see',
    'what accounts are feeding my schedule',
  ] },
  { tool: 'email_calendar_attendees', says: [
    'mail everyone coming to the friday review',
    'let the attendees know the room changed',
  ] },

  // ── email ──────────────────────────────────────────────────────────────
  { tool: 'send_email', says: [
    'mail Priya the invoice',
    'write to Acme saying we are ready to start',
  ] },
  { tool: 'schedule_email', says: [
    'send that mail tomorrow at 9 instead of now',
    'hold this email until monday morning',
  ] },
  { tool: 'bulk_email', says: [
    'mail everyone in the investors group about the raise',
    'blast this out to all my leads',
  ] },
  { tool: 'reuse_recent_email', says: [
    'send that same mail to Priya as well',
    'forward the one I just wrote to Neha too',
  ] },
  { tool: 'manage_campaigns', says: [
    'how did my last email blast do',
    'draft an outreach sequence for the investors',
    'pause the one that is going out right now',
  ] },

  // ── CRM ────────────────────────────────────────────────────────────────
  { tool: 'manage_sales', says: [
    'put Acme aside for now, they went quiet',
    'I called Acme this morning',
    'Acme is close to signing',
  ] },
  { tool: 'manage_contacts', says: [
    'what is Rahul number',
    'update Neha email address',
  ] },
  { tool: 'save_contact', says: [
    'Neha is on 9876543210',
    'add this number for Rahul: +91 98765 43210',
  ] },
  { tool: 'bulk_save_contacts', says: [
    'here are forty numbers, save them all',
    'import everyone from the sheet I sent',
  ] },
  { tool: 'manage_contact_groups', says: [
    'take Priya out of the investors list',
    'who is in the investors group',
    'put Neha and Raj in with the designers',
  ] },

  // ── tasks ──────────────────────────────────────────────────────────────
  { tool: 'manage_tasks', says: [
    'add: finish the deck before friday',
    'mark the report one as done',
    'give Rahul the PR review',
  ] },
  { tool: 'manage_google_tasks', says: [
    'add this to my google tasks',
    'sync that to google',
  ] },
  { tool: 'manage_follow_ups', says: [
    'circle back with Acme on tuesday',
    'chase Neha again next week',
  ] },

  // ── team ───────────────────────────────────────────────────────────────
  { tool: 'manage_team', says: [
    'add Neha to design',
    'who is on my crew',
  ] },
  { tool: 'manage_team_comms', says: [
    'who actually saw what I sent everyone',
    'book a catch up with Rahul next friday',
    'Priya starts monday, kick off her welcome flow',
    'when did Rahul join us',
    'how do new people join my group',
  ] },
  { tool: 'delegate_message', says: [
    'let Rahul know I am running late',
    'tell the design folks the deck moved',
  ] },
  { tool: 'scheduled_message', says: [
    'text Rahul at 5pm saying I am on the way',
    'message mom tomorrow at 9 that I landed',
  ] },
  { tool: 'check_team_availability', says: [
    'who is free this afternoon',
    'is anybody out tomorrow',
  ] },
  { tool: 'manage_leave', says: [
    'I am taking friday off',
    'how many days do I have left this year',
  ] },
  { tool: 'manage_standup', says: [
    'set up daily check ins for the team',
    'stop the morning check in questions',
  ] },
  { tool: 'personal_standup', says: [
    'what did I actually get done today',
    'give me my own wrap up for the week',
  ] },
  { tool: 'manage_polls', says: [
    'ask the team to vote on lunch',
    'get everyone to pick a date',
  ] },
  { tool: 'team_analytics', says: [
    'how is the team doing this month',
    'who is carrying the most work right now',
  ] },
  { tool: 'manage_sprints', says: [
    'kick off the next sprint',
    'how fast are we shipping lately',
  ] },
  { tool: 'manage_incidents', says: [
    'we have an outage on checkout',
    'log a sev2, payments are down',
  ] },
  { tool: 'manage_shared_board', says: [
    'put this on the team board',
    'stick this up where the whole team can see it',
    'what is on the shared board',
  ] },

  // ── notes and knowledge ────────────────────────────────────────────────
  { tool: 'manage_notes', says: [
    'jot this down: pricing goes up in march',
    'what did I write about pricing',
  ] },
  { tool: 'manage_lists', says: [
    'add milk to shopping',
    'what is left on the packing checklist',
  ] },
  { tool: 'manage_knowledge_base', says: [
    'save this in our internal wiki',
    'what does the handbook say about refunds',
  ] },
  { tool: 'manage_reading_list', says: [
    'save this article for later',
    'what have I got queued up to read',
  ] },
  { tool: 'save_memory', says: [
    'my passport expires in june 2028',
    'I am allergic to peanuts',
  ] },
  { tool: 'recall_memory', says: [
    'what do you know about me',
    'what is my wifi password',
  ] },
  { tool: 'thread_summary', says: [
    'recap what we just went through',
    'summarise this conversation for me',
  ] },

  // ── documents and drive ────────────────────────────────────────────────
  { tool: 'manage_docs', says: [
    'write up the proposal as a doc',
    'open the proposal document',
  ] },
  { tool: 'manage_sheets', says: [
    'read the budget spreadsheet',
    'make me a sheet for expenses',
  ] },
  { tool: 'manage_slides', says: [
    'build a deck for monday',
    'add a slide about pricing',
  ] },
  { tool: 'quick_note_docs', says: [
    'drop this into a google doc quickly',
    'stick these points in a doc',
  ] },
  { tool: 'search_drive', says: [
    'find the pitch deck in my files',
    'where is the contract stored',
  ] },
  { tool: 'create_drive_folder', says: [
    'make a folder in drive for Q3',
    'I need somewhere in my files to keep the Q3 invoices',
    'new drive folder called invoices',
  ] },
  { tool: 'upload_to_drive', says: [
    'put this file in my drive',
    'save this file to the cloud',
    'back this up to drive',
  ] },
  { tool: 'share_drive_file', says: [
    'give Neha access to the deck',
    'let Rahul see that file',
  ] },
  { tool: 'analyze_file', says: [
    'what does this attachment say',
    'pull the numbers out of the sheet I just sent',
  ] },

  // ── meetings ───────────────────────────────────────────────────────────
  { tool: 'get_meeting_recordings', says: [
    'that recording got stuck, run it again',
    'speaker B is actually Neha',
    'turn the action items from that meeting into tasks',
    'did the standup recording finish processing',
  ] },
  { tool: 'meeting_minutes', says: [
    'write up notes from today call',
    'what were the decisions in that meeting',
  ] },

  // ── media ──────────────────────────────────────────────────────────────
  { tool: 'manage_images', says: [
    'show me the picture I kept last week',
    'pull up that photo again',
  ] },
  { tool: 'save_image', says: [
    'keep this photo',
    'hold on to this picture for me',
  ] },

  // ── productivity ───────────────────────────────────────────────────────
  { tool: 'focus_mode', says: [
    'hold my notifications for an hour',
    'I need quiet time until 4',
  ] },
  { tool: 'manage_habits', says: [
    'track my gym streak',
    'did I drink enough water today',
  ] },
  { tool: 'manage_expenses', says: [
    'I spent 400 on lunch',
    'how much did I burn this month',
  ] },
  { tool: 'track_time', says: [
    'start the clock on the Acme work',
    'how long have I been on this',
  ] },

  // ── integrations ───────────────────────────────────────────────────────
  { tool: 'connect_google', says: [
    'hook up my gmail',
    'let me link my google account',
  ] },
  { tool: 'connect_outlook', says: [
    'attach my office 365 account',
    'link outlook please',
  ] },
  { tool: 'connect_apple', says: [
    'link my icloud calendar',
    'connect apple calendar',
  ] },
  { tool: 'disconnect_google', says: [
    'unlink my gmail',
    'stop using my google account',
  ] },
  { tool: 'disconnect_outlook', says: [
    'unlink outlook',
    'remove my office 365 connection',
  ] },
  { tool: 'disconnect_apple', says: [
    'unlink icloud',
    'remove the apple calendar connection',
  ] },
  { tool: 'link_account', says: [
    'connect my other number to this account',
    'I use two numbers, join them up',
  ] },

  // ── research and misc ──────────────────────────────────────────────────
  { tool: 'web_search', says: [
    'look up the latest on the RBI rules',
    'what is going on with that acquisition',
  ] },
  { tool: 'news_deep_dive', says: [
    'go deeper on that story',
    'tell me more about the third headline',
  ] },
  { tool: 'daily_briefing', says: [
    'what is on for today',
    'give me the rundown',
  ] },
  { tool: 'translate_text', says: [
    'say this in hindi',
    'how do I write that in french',
  ] },
  { tool: 'view_dashboard', says: [
    'open my dashboard',
    'show me the overview page',
    'show me the overview page',
  ] },
  { tool: 'delete_dashboard_item', says: [
    'remove that entry from my dashboard',
    'get rid of row 3 on the overview page',
    'delete item 3 from the dashboard',
  ] },
  { tool: 'set_timezone', says: [
    'I am in dubai now',
    'my clock should be london time',
  ] },
  { tool: 'view_timezone', says: [
    'what timezone am I set to',
    'which clock are you using for me',
  ] },
  { tool: 'export_data', says: [
    'give me a copy of everything you have on me',
    'I want my data downloaded',
  ] },
  { tool: 'clear_chat_history', says: [
    'wipe our conversation',
    'clear what we talked about here',
  ] },
  { tool: 'show_help', says: [
    'what can you actually do',
    'what are you good for',
  ] },
  { tool: 'show_version', says: [
    'which build is this',
    'what version are you on',
  ] },
];

/**
 * Tools routed by conversation STATE rather than by phrasing. A reply of "yes"
 * routes to whichever confirmation is open; menu recall is not the mechanism,
 * so scoring them here would measure nothing.
 */
const EXCLUDED = {
  handle_calendar_confirmation: 'answers an open calendar confirmation',
  handle_email_confirmation: 'answers an open email confirmation',
  handle_leave_approval: 'answers an open leave request',
  handle_poll_vote: 'answers an open poll',
  handle_sales_email_confirmation: 'answers an open sales email preview',
  handle_standup_response: 'answers an open standup prompt',
  handle_standup_setup: 'answers an open standup setup prompt',
  request_clarification: 'the model asks with it; a user never phrases it',
};

module.exports = { CASES, EXCLUDED };
