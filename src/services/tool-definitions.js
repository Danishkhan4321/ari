/**
 * OpenAI Function Calling Tool Definitions
 *
 * Replaces keyword/regex-based intent detection with structured tool calling.
 * The LLM selects the right tool AND extracts parameters in a single call.
 */

const toolDefinitions = [

  // ========== REMINDERS ==========
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Create a reminder when ANY of these are true: (1) User EXPLICITLY says remind/reminder/alarm/yaad-dilana/reminder-bhejna/ping-me/alert; (2) User mentions ACTION_VERB + FUTURE_TIME *without* other tool semantics — "call mahaprasad at 11", "gym tomorrow 6am", "pick up kids at 3:30", "take meds at 9", "mom birthday march 15", "dentist 3pm thursday", "flight at 7am tomorrow", "meds rozana 9pm"; (3) User mentions a DEADLINE — "pay bill by monday", "submit report by friday", "insurance expires march 15". KEY RULE: Action + future time = reminder (implicit). Don\'t wait for the word "remind".\n\n★ HARD ROUTING — LEAD VERB "REMIND" WINS over noun-tokens that look like other categories: ★\n  • "remind me every monday at 9am for team standup" → set_reminder (lead verb is "remind"; "team standup" is the SUBJECT of the reminder, not a manage_team operation). Set is_recurring=true, recurring_pattern="every monday", reminder_message="team standup".\n  • "remind me about the email from Sarah" → set_reminder (NOT email_query — the lead verb "remind" wins).\n  • "remind me to delete the file" → set_reminder (NOT file management).\n  • "remind me of meeting tomorrow" → set_reminder (NOT calendar_view — the lead verb "remind" overrides the noun "meeting").\n  Whenever the FIRST verb of the message is "remind/reminder/yaad-dilana/erinnere/rappelle/recuérdame", route HERE regardless of what nouns appear later. Body content is NOT a routing signal.\n\nOnly SKIP when: (a) no time specified, (b) clearly conversational ("call me crazy", "I remember when we were 11", "what time is it"), (c) message is email/tell/ask someone (use delegate_message), (d) it\'s a calendar-style named appointment with explicit attendees (use create_calendar_event). When ambiguous between reminder & calendar event, prefer set_reminder. CRITICAL TARGET RULE: "call X at Y", "meet X at Y", "email X at Y" = reminder for THE USER (self), NOT for X. The person named in the action is the OBJECT of the action, not the reminder target. OMIT target_name in these cases. ONLY set target_name when user EXPLICITLY says "remind [person]" or "[person] ko reminder" (the person is the recipient of the reminder, not the action target).',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'The complete original message text for the reminder handler to parse' },
          reminder_message: { type: 'string', description: 'The actual reminder content/task ONLY (not the instruction). E.g. "remind me to call the doctor at 3pm" → reminder_message="call the doctor". "remind Rahul to send the report" → reminder_message="send the report". "call mahaprasad at 6pm" → reminder_message="call mahaprasad".' },
          target_name: { type: 'string', description: 'Who RECEIVES the reminder notification (NOT who the user is going to call/meet). OMIT in these cases: "call X at Y", "meet X at Y", "email X at Y", "message X at Y" — these are SELF reminders (user wants to be reminded to do the action). ONLY set target_name when user EXPLICITLY says "remind [person]" or "[person] ko reminder bhejna" — i.e. the reminder itself is being delegated to that person. Examples: "remind Rahul at 5pm" → "Rahul" (correct). "call Rahul at 5pm" → omit (reminder is for USER). "team ko remind karo" → "team".' },
          target_phone: { type: 'string', description: 'Phone number if user specified one (e.g. "remind +919876543210")' },
          is_recurring: { type: 'boolean', description: 'true if user wants recurring reminder ("every day", "daily", "every Monday", "rozana", "har din")' },
          recurring_pattern: { type: 'string', description: 'Recurrence pattern if recurring (e.g. "daily", "weekdays", "every monday", "every 2 hours")' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_reminders',
      description: 'Show the user their active reminders/alarms list. Triggers include VERB phrases AND NOUN phrases in any language. English verb: "show my reminders", "list reminders", "what reminders do I have", "pending reminders". English noun: "active alarms", "my alarms", "upcoming reminders", "pending pings". Hinglish: "mere reminders", "kaun kaun se reminders hain", "alarm list dikhao". Hindi: "मेरे रिमाइंडर दिखाओ". Spanish: "mis recordatorios". French: "mes rappels". German: "meine Erinnerungen". Arabic: "تذكيراتي". KEY: this is the READ/VIEW tool — any phrasing that asks TO SEE existing reminders (as opposed to creating new ones or cancelling them) maps here.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: 'Cancel, stop, or delete exactly one reminder. Use reminder_id only when Ari previously showed a stable reminder ID, position only for a one-based item in the most recently displayed reminder list, and query for distinctive reminder text. Never put a list position in reminder_id or guess a different reminder when a selector does not resolve.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'The original message for the legacy non-agent parser.' },
          reminder_id: { type: 'integer', description: 'Stable reminder database ID previously shown by Ari; never a display-list position.' },
          position: { type: 'integer', description: 'One-based position from the most recently displayed reminder list; never a stable reminder ID.' },
          query: { type: 'string', description: 'Distinctive text from the reminder message.' },
          reason: { type: 'string', description: 'Optional user-provided reason for the cancellation confirmation preview.' }
        },
        required: ['full_text']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'manage_team_comms',
      description: 'The team workspace behind the dashboard Team pages: past broadcasts and their read receipts, 1:1 meetings, new-hire onboarding, per-member details (birthday, start date, manager, notes), the team invite link, and team chat threads. Use for "who read my last broadcast", "show my broadcasts", "schedule a 1:1 with Rahul on Friday 4pm", "cancel 1:1 3", "who is being onboarded", "start onboarding for Priya", "Priya finished onboarding", "when did Rahul join", "set Rahul\'s birthday to 12 March", "get the team invite link", "show team chats", "post in the design chat". To SEND a new broadcast, use delegate_message with target_name="team" — it asks for confirmation before messaging everyone. Use manage_team to add or remove members.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original team message' },
          action: {
            type: 'string',
            enum: [
              'list_broadcasts', 'broadcast_status',
              'list_one_on_ones', 'schedule_one_on_one', 'cancel_one_on_one',
              'list_onboardings', 'start_onboarding', 'complete_onboarding',
              'member_info', 'set_member_info',
              'invite_link', 'list_chats', 'send_chat_message',
            ],
            description: 'broadcast_status=per-person delivered/read for one broadcast (latest when no ID), set_member_info=save a birthday/start date/manager/note for one member, send_chat_message=post into an existing team chat thread you belong to',
          },
          team_name: { type: 'string', description: 'Team name; omit when the user has only one team' },
          member_name: { type: 'string', description: 'Exact team member name (the report for a 1:1, the new hire for onboarding, the subject of member details)' },
          manager_name: { type: 'string', description: 'Exact team member name acting as manager; defaults to the requester' },
          due_time: { type: 'string', description: 'When the 1:1 happens, ISO-8601 or a clear phrase such as friday at 4pm' },
          cadence_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Repeat interval in days for a recurring 1:1' },
          agenda: { type: 'string', description: 'Agenda or talking points for the 1:1' },
          birthday: { type: 'string', description: 'Member birthday as YYYY-MM-DD' },
          start_date: { type: 'string', description: 'Member joining date as YYYY-MM-DD' },
          notes: { type: 'string', description: 'Free-text note about the member' },
          broadcast_id: { type: 'integer', minimum: 1, description: 'Stable broadcast ID for broadcast_status' },
          one_on_one_id: { type: 'integer', minimum: 1, description: 'Stable 1:1 ID for cancel_one_on_one' },
          onboarding_id: { type: 'integer', minimum: 1, description: 'Stable onboarding ID for complete_onboarding' },
          chat_id: { type: 'integer', minimum: 1, description: 'Stable chat thread ID' },
          chat_name: { type: 'string', description: 'Chat thread name when no ID is known' },
          message: { type: 'string', description: 'Text to post in the chat thread' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_reminder',
      description: 'Mark exactly one pending reminder as DONE because the user already did it ("done", "finished that", "I called mom", "mark reminder 2 complete"). This is not a cancellation: use cancel_reminder when the user no longer wants the reminder at all. Use reminder_id only for a stable ID Ari showed, position only for a one-based item in the most recently displayed reminder list, and query for distinctive reminder text.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'The original message for the legacy non-agent parser.' },
          reminder_id: { type: 'integer', description: 'Stable reminder database ID previously shown by Ari; never a display-list position.' },
          position: { type: 'integer', description: 'One-based position from the most recently displayed reminder list; never a stable reminder ID.' },
          query: { type: 'string', description: 'Distinctive text from the reminder message.' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== MEMORY ==========
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a durable fact about the user\'s own world — their identity, credentials, preferences, possessions, or the people in their life — so Ari can recall it later. Save when ANY of these are true: (1) User EXPLICITLY says "remember" or "save that"; (2) User DECLARES a fact about themselves, people they know, things they own, credentials, preferences — even WITHOUT the word "remember". Implicit patterns: "my X is Y" ("my wifi password is abc", "my car is Honda City"), "[person]\'s X is Y" ("mom\'s birthday is march 15"), "X expires on Y" ("passport expires june 2028"), "I work at X", "I live in X", "I\'m allergic to X". KEY: if user is STATING info worth remembering (not asking, not chatting), save it. Don\'t wait for "remember".\n\n★ THE VERB DECIDES, NOT THE CONTENT ★\nIf the message contains ANY note-taking verb — note, jot, jot down, write down, take down, record, "save this as a note", "add to my notes", or the Hinglish "note karo / note bana do / note likho" — route to manage_notes instead, whatever the content is. "Jot down that pricing goes up in march" is a NOTE, not a memory, even though it states a fact. save_memory is only for facts stated WITHOUT a note-taking verb.\n\n★ OTHER VETOES ★\n- The message contains a phone number after a name → use save_contact.\n- The message is about a future time-bound action ("call X at 5") → use set_reminder, not save_memory.\n\nNOT for saving notes (use manage_notes for "save a note about X"). NOT for contacts with phone numbers (use save_contact — "rohan\'s number is +91..."). If the statement is about a time-bound event ("car insurance expires march 15"), prefer save_memory but a set_reminder is also valid.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'The original message containing the fact to remember' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: 'Retrieve previously saved personal info or preferences. Use when user asks "what\'s my birthday?", "where do I work?", "what do you know about me?", "show my memory trunk", "show my personal info", "my memories". For BROAD queries like "what do you know about me?", "tell me everything you remember", "show all memories", "my info" — use action=show_all. For SPECIFIC queries like "what\'s my wifi password?", "where do I live?" — use action=recall.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'What the user wants to recall' },
          action: {
            type: 'string',
            enum: ['recall', 'show_all', 'show_category', 'forget', 'clear_all'],
            description: 'recall=specific fact, show_all=ALL memories (use for broad questions like "what do you know about me?"), show_category=specific category, forget=delete specific, clear_all=delete everything'
          },
          category: {
            type: 'string',
            enum: ['personal', 'work', 'finance', 'health', 'family', 'friends', 'travel', 'vehicle', 'preferences', 'general'],
            description: 'Memory category if showing specific category'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },

  // ========== CONTACTS ==========
  {
    type: 'function',
    function: {
      name: 'save_contact',
      description: 'Save a contact when user provides [PERSON_NAME] + [PHONE_NUMBER] in ANY form — explicit or implicit. EXPLICIT: "save contact Danish 9876543210", "save this number as Rahul". IMPLICIT (don\'t need the word "save"): "rohan\'s number is +919876543210", "mom\'s mobile: +9184201..", "emily — 9876543210", "new contact: rahul 987..." If user states a name with what looks like a phone number (10+ digits, optional +, country code, spaces/dashes), trigger this tool. Not for generic numbers without a person (those might be memory — "my account number is X").',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Contact name' },
          phone: { type: 'string', description: 'Phone number (digits, may include +, spaces, dashes)' }
        },
        required: ['name', 'phone']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bulk_save_contacts',
      description: 'Save multiple contacts at once. Use when user provides 2 or more contacts in a single message. Each contact needs a name and phone number. Examples: "save these contacts: Rahul 9876543210, Priya 8765432109", "add neha number 917595977796 and ammi number +919998887777", "save contacts: Danish +919997776666, Emily 8420117521".',
      parameters: {
        type: 'object',
        properties: {
          contacts: {
            type: 'array',
            minItems: 2,
            maxItems: 500,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Contact name' },
                phone: { type: 'string', description: 'Phone number' }
              },
              required: ['name', 'phone']
            },
            description: 'Array of contacts to save. Extract ALL name-phone pairs from the message.'
          }
        },
        required: ['contacts']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_contacts',
      description: 'View, lookup, update, or delete contacts. Use for "show my contacts", "show me X\'s number", "what is X\'s number", "X ka number dikhao", "delete contact X", "update X\'s number to Y", "list contacts", "find X". Use action "get" when user asks for a specific person\'s number or contact info.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'delete', 'update'], description: 'What to do. Use "get" to look up a specific contact by name.' },
          name: { type: 'string', description: 'Contact name (for get/delete/update)' },
          phone: { type: 'string', description: 'New phone number (for update only)' }
        },
        required: ['action']
      }
    }
  },

  // ========== DASHBOARD ==========
  {
    type: 'function',
    function: {
      name: 'view_dashboard',
      description: 'Show the user their personal dashboard with stats on reminders, memories, lists, images. ★ TRIGGER ONLY on EXPLICIT dashboard wording ★: the user must say "dashboard", "my dashboard", "show dashboard", "show me dashboard", "my stats", "show stats", "show my overview", "show me my reminders/memories/lists/images". The single word "dashboard" alone is allowed (section=overview). \n\n★ DO NOT TRIGGER on bare single-word replies like "all", "yes", "no", "first", "last", "1", "2", "#3", "option 2". Those are POSITIONAL/CONTEXT replies and MUST resolve to whatever tool produced the most recent numbered list in the conversation (see HARD-FORCE rule 9 in the system prompt). DO NOT trigger merely because the word "all" or a number appears in the message — only trigger when the user explicitly names the dashboard or one of its sections.',
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['overview', 'reminders', 'recurring_reminders', 'memories', 'lists', 'contacts', 'images'],
            description: 'Which dashboard section to show. "overview" for full dashboard.'
          }
        },
        required: ['section']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_dashboard_item',
      description: 'Delete a specific item from dashboard by index number. Use for "delete reminder 3", "delete image 2".',
      parameters: {
        type: 'object',
        properties: {
          item_type: { type: 'string', enum: ['reminder', 'image', 'recurring'], description: 'Type of item to delete' },
          index: { type: 'integer', minimum: 1, maximum: 10000, description: 'One-based item number/index to delete' }
        },
        required: ['item_type', 'index']
      }
    }
  },

  // ========== IMAGES ==========
  {
    type: 'function',
    function: {
      name: 'manage_images',
      description: 'Retrieve, search, delete, or list saved images/photos. Use when user says "show me that image", "send the ticket photo", "my saved images", "delete the receipt image", "show me that photo from yesterday". Use select_number ONLY when the user was just shown an IMAGE list; a bare number after a task/reminder/email/other list belongs to that list\'s own tool, never this one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'list', 'delete', 'select_number'], description: 'What to do with images' },
          search_query: { type: 'string', description: 'What image to search for (for search/delete)' },
          number: { type: 'integer', minimum: 1, maximum: 10000, description: 'One-based image number to select (for select_number)' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_image',
      description: 'Save/store a recently shared or generated image. Use when user says "save this", "store it", "keep this image", "save as [title]" after an image was shared. Also handles "no"/"don\'t save"/"discard" to decline saving.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'save_with_title', 'discard'], description: 'Save, save with custom title, or discard' },
          title: { type: 'string', description: 'Custom title for the image (for save_with_title)' }
        },
        required: ['action']
      }
    }
  },

  // ========== CALENDAR ==========
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Create a calendar event when the FIRST verb in the message is "schedule/book/set up/arrange/plan/fix/lagao" + an event-noun (meeting/call/appointment/event/sync/standup/interview/lunch/dinner/catchup), with TIME and optionally attendees/location.\n\n★ USE THIS TOOL when the lead verb is event-creation. The presence of an email address means the email is the ATTENDEE — NEVER a send target. Examples that ALL go HERE:\n  • "schedule meeting tomorrow 3pm with john@example.com about Q3 review"\n  • "book a call with priya@x.com for Friday 5pm"\n  • "set up sync with team@company.com tomorrow"\n  • "schedule interview with candidate@gmail.com Monday 10am about backend role"\n  • "kal 11am pe rahul@x.com se meeting set karo"\n  • "dentist appointment 3pm thursday"\n  • "lunch with priya 1pm"\n\n★ DO NOT USE WHEN the FIRST verb is "send/email/mail/write/draft/compose/reply/forward" ★ — those route to send_email even if the body contains "schedule a meeting" or similar phrases. The lead verb wins:\n  • "send a mail to X, let\'s schedule a meeting tomorrow" → send_email, NOT here (lead: send mail; "schedule meeting" is body)\n  • "email rahul about the kickoff meeting" → send_email, NOT here\n  • "draft an email about scheduling Q3 review" → send_email, NOT here\n\nMultilingual lead-verb triggers. English: "schedule a meeting", "book call", "set up sync", "arrange interview", "plan lunch". Hinglish: "kal 11am pe rahul se meeting set karo", "lunch book karo", "appointment fix karo", "meeting lagao". Hindi: "कल 3 बजे मीटिंग लगाओ". Spanish: "agenda una reunión". French: "planifie une réunion". German: "termin um".\n\nDistinguishing from set_reminder: CREATE CALENDAR EVENT when there\'s a named event-noun (meeting, appointment, interview, call, lunch, dinner) AND/OR explicit attendees. Use set_reminder for plain action-verbs ("call X", "take meds", "pick up kids") with no event-noun. "schedule a meeting" = CREATE new, NOT reschedule (use reschedule_calendar_event for moves).',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message with event details for NLP parsing' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_calendar_event',
      description: 'Cancel/delete a SCHEDULED calendar event. Use for "cancel my 3pm meeting" or "delete the standup".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message for identifying which event to cancel' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_calendar_event',
      description: 'Reschedule/move an EXISTING event to a new time. MUST explicitly say "reschedule", "move", "shift", "postpone". NOT for creating new events.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message for parsing event + new time' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_calendar',
      description: 'View calendar events, schedule, or availability. Any language, any phrasing that ASKS ABOUT existing scheduled events (vs creating new). English: "my calendar", "what meetings do I have today", "show my schedule", "am I free at 3pm", "when\'s my next meeting", "whens my next meeting", "what\'s on my calendar today", "am I busy tuesday", "my schedule for tomorrow". Hinglish: "mera calendar dikhao", "aaj meri kya meetings hain", "kal free hu kya", "meri agli meeting kab hai". Hindi: "मेरा कैलेंडर", "कल क्या मीटिंग है". Spanish: "mi calendario", "¿estoy libre mañana?". French: "mon agenda", "je suis libre à 15h?". German: "mein kalender", "bin ich morgen frei". Arabic: "جدولي اليوم".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message for date/period parsing' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_calendar_attendees',
      description: 'Email attendees about a calendar event. Use for "email everyone about the meeting", "send meeting details to attendees".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message for event identification' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remind_all_calendar',
      description: 'Enable automatic reminders for ALL upcoming calendar events (including ones NOT booked through Ari). Use when user says: "remind me about all meetings", "send me reminders for every event on my calendar", "turn on calendar reminders", "meeting reminders on". One-time toggle per user. Do NOT use for a single one-off reminder (that\'s set_reminder) or for cancelling reminders (cancel_reminder).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_calendars',
      description: 'List all calendar accounts the user has connected (Google primary, Google secondary, Outlook, Apple iCloud, etc.). Use when user asks: "show my calendars", "list calendars", "which calendars am I connected to", "what calendars do you see". Do NOT use to list events (that\'s view_calendar).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'handle_calendar_confirmation',
      description: 'Respond to a pending calendar confirmation (conflict resolution, cancel confirm, etc.). Use ONLY when there is an active calendar confirmation context and user replies with "yes", "no", "option 1", "go ahead", "cancel it", etc.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User response to the confirmation' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== EMAIL ==========
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send or DRAFT an email to someone IMMEDIATELY (no schedule). ★ ROUTING IS DETERMINED BY THE FIRST WORD/VERB OF THE USER MESSAGE, not by body content. ★\n\n★ USE THIS TOOL when the FIRST verb is email-specific: "send/email/mail/write/draft/compose/reply/forward" + recipient. EVEN IF the body mentions scheduling something, route HERE. The body content (after a comma or after "about/to discuss/saying/that") never overrides the lead verb.\n\nExamples that ALL go HERE (body content has meeting/schedule words but lead verb is email):\n  • "send a mail to john@x.com, let\'s schedule a meeting tomorrow at 10am" → HERE (lead: send mail; meeting is body)\n  • "email rahul about the kickoff meeting next week" → HERE (lead: email; meeting is body)\n  • "draft an email about the friday deadline" → HERE (lead: draft email; friday is body)\n  • "mail priya saying the call is at 5pm" → HERE (lead: mail; call at 5pm is body)\n  • "send follow-up email to priya about scheduling Q3 review" → HERE (lead: send email; scheduling is body)\n\n★ DO NOT USE WHEN the FIRST verb is "schedule/book/set up/arrange/plan/fix/lagao" + meeting-noun ★ — those route to create_calendar_event, EVEN IF the message contains an email address. The email is an ATTENDEE, not a send target. Specifically:\n  • "schedule meeting tomorrow 3pm with john@x.com" → create_calendar_event, NOT here\n  • "book call with priya@x.com Friday 5pm" → create_calendar_event, NOT here\n  • "set up sync with team@company.com" → create_calendar_event, NOT here\n\nMultilingual triggers (lead verb only). English: "send email to priya", "write mail", "draft email", "mail john", "compose", "reply", "forward". Hinglish: "priya ko email karo", "john ko mail bhejna hai", "draft kar do email". Hindi: "प्रिया को ईमेल भेजो". Spanish: "envía un correo". French: "envoie un email". German: "schick eine email". "draft an email" ALWAYS routes here.\n\n★ schedule_email vs send_email — body-content time ★ A future time only routes to schedule_email when the time DIRECTLY modifies the SEND verb (e.g., "send email at 9am tomorrow", "email john on Monday morning"). If the time describes content INSIDE the email (deadline, meeting, event), use send_email. When in doubt → send_email. Bulk sends to 2+ recipients → bulk_email.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message with recipient, subject, body' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_email',
      description: 'Schedule an email to be sent at a SPECIFIC FUTURE SEND TIME — not for emails that merely mention a future time in their content. ROUTE HERE ONLY when one of these two patterns is present:\n\n  (1) Explicit "schedule" verb: "schedule an email to X", "schedule a follow-up to Y", "set up an email to Z for next Monday".\n\n  (2) A time that DIRECTLY MODIFIES the SEND action — the time appears right next to the send verb with no "about/regarding/saying/that the [X] is at" between them. Examples:\n    • "send email to john at 9am tomorrow"\n    • "email priya on Monday morning"\n    • "kal subah 9 baje email bhejo" (Hindi: send email tomorrow at 9am)\n    • "schedule email to alice for Friday 4pm"\n\n★ DO NOT ROUTE HERE — these go to send_email INSTEAD ★\n  • "send email to X about the meeting tomorrow at 3pm" → time describes meeting (body content)\n  • "email about kickoff on Monday" → time describes kickoff\n  • "send mail saying call is at 5pm" → time describes the call\n  • "draft email about the Friday deadline" → time describes deadline\n  In all the above, the time is part of the email\'s SUBJECT/BODY, not a send time. Route to send_email.\n\nAlso handles viewing/canceling scheduled emails: "show scheduled emails", "cancel scheduled email #3".\n\nDistinguishing test: try removing "about ..." or "saying ..." or "regarding ..." from the message. If the time still makes sense as the SEND time of the email, schedule_email. If the time only made sense BECAUSE it was inside the about/saying clause, route to send_email instead.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message for parsing recipient, time, body' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bulk_email',
      description: 'Send or schedule email to MULTIPLE recipients (2+ email addresses). ALWAYS use when message contains 2 or more email addresses. Also for editing an active bulk email draft.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message with recipients, subject, body' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_inbox',
      description: 'Check inbox / view emails / search received emails / read a specific email. Any phrasing that asks about EXISTING received emails (not composing new ones, not generic web info). English: "check my inbox", "any new emails", "any emails from the CEO", "did i receive any mail from X", "did anyone reply about Y", "did sarah reply", "search my email for Z", "find email about", "unread emails", "read email 3", "open email #2", "urgent emails". Hinglish: "inbox check karo", "koi naya email aaya", "X se mail aaya kya", "urgent mail hai kya". Hindi: "मेरे ईमेल देखो", "X से कोई मेल आया". Spanish: "revisa mi bandeja", "¿alguien respondió?". French: "vérifie ma boîte mail", "quelqu\'un a-t-il répondu?". German: "prüfe meinen posteingang". Arabic: "تحقق من بريدي". STRICT: "did anyone reply / did i receive mail / kisi ka mail aaya" pattern is ALWAYS check_inbox — never web_search. The user is asking about THEIR inbox, not the public web.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check', 'read'],
            description: 'check=show unread/inbox summary, read=read specific email by number'
          },
          email_index: { type: 'integer', description: 'Email number to read (for read action, e.g. "read email 3" → email_index=3)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_inbox',
      description: 'Search emails by keyword, sender, or subject. Use for "search emails about invoice", "find emails from Rahul", "check my sent emails", "emails I sent to X". Supports searching inbox, sent folder, or all mail.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Search query' },
          folder: {
            type: 'string',
            enum: ['inbox', 'sent', 'all'],
            description: 'Which folder to search: inbox (default), sent (for emails user sent), or all (both). Use "sent" when user says "my sent emails", "emails I sent", "check sent mail".'
          }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'followup_email',
      description: 'Write a follow-up email to someone the user previously emailed. Use when user says "followup to X", "follow up with X", "send another email to X about the previous one", "write a followup mail to X which I sent earlier". Searches sent folder for the original email and drafts a contextual follow-up.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User message about the follow-up' },
          recipient_email: { type: 'string', description: 'Email address to follow up with (if mentioned)' },
          recipient_name: { type: 'string', description: 'Name of the person to follow up with (if no email given)' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_query',
      description: 'Ask a question about emails. Use for "did anyone send me the report?", "any email about the invoice?", "did X reply?", "has the client responded?".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'The question about emails' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'handle_email_confirmation',
      description: 'Respond to a pending email draft/schedule confirmation. Use whenever there is an active email draft/schedule context AND the user is iterating on it. Triggers (English + Hinglish): (a) approval — "send it", "looks good", "ok send", "go ahead", "bhej do"; (b) tone/style edits — "make it more formal", "make it shorter", "more casual", "punchier", "thoda formal kar do", "isko short kar do"; (c) content edits — "add a line about X", "remove the part about Y", "change subject to Z", "edit the greeting", "change time to 5pm"; (d) cancellation — "cancel", "don\'t send", "scrap it", "nahi bhejna". KEY: any iterative request while a draft is pending is this tool, not a brand new send_email.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User response to email confirmation' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reuse_recent_email',
      description: 'Reuse or reschedule a recently discussed email. Use for "same email to Emily", "schedule that email", "send it again", "same draft", "previous email".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message about reusing the email' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== TASKS ==========
  {
    type: 'function',
    function: {
      name: 'manage_tasks',
      description: 'Add, view, complete, assign, or track tasks. Use for "add task: finish report", "my tasks", "mark task 1 done", "assign task to Rahul: review PR", "done task 3", "delete task 2", "show tasks assigned to me", "tasks I assigned to others", "show my assigned tasks", "what tasks did I give". Also: when user says something like "follow up every 4 hours" or "remind every day at 9am" right after assigning a task, include follow_up_directive — that adjusts the assignee follow-up cadence. ★ ALWAYS PICK THIS for "assign task to <name>", "give <name> a task", "task for <name>", "delegate task to <name>", "<name> ke liye task" — even if the task description is missing or vague. NEVER route those to delegate_message; manage_tasks creates a tracked, follow-up-able task. If the user says "assign task to X" and you can\'t extract the actual task description, set action="assign" + assignee_name="X" and leave task_title empty or null — the bot has a clarification flow that will ask the user "What task?" automatically.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original task management message' },
          action: {
            type: 'string',
            enum: ['add', 'list', 'complete', 'edit', 'reopen', 'assign', 'delete', 'list_assigned_to_me', 'list_assigned_by_me', 'set_task_followup'],
            description: 'add=create task, list=show my tasks, complete=mark done, edit=change title/priority/due date, reopen=return a completed task to pending, assign=give to person, delete=remove task, list_assigned_to_me=tasks others assigned to me, list_assigned_by_me=tasks I assigned to others, set_task_followup=set follow-up cadence on an already-assigned task'
          },
          task_title: { type: 'string', description: 'The task description only — do NOT include the assignee name, time, or date in this field. E.g., "send my ticket", "review PR", "do the cores"' },
          new_title: { type: 'string', description: 'Replacement task title/description (for edit)' },
          task_id: { type: 'integer', description: 'Task ID number (for complete/edit/reopen/delete/set_task_followup)' },
          assignee_name: { type: 'string', description: 'ONLY the person\'s name — do NOT include time, date, or other details. E.g., "ammi", "Rahul", "Emily". Extract JUST the name from phrases like "assign task to ammi at 5:42 to send ticket" → assignee_name="ammi"' },
          due_time: { type: 'string', description: 'Due time/date if mentioned (e.g., "5:42", "tomorrow", "at 3pm"). Extract from phrases like "at 5:42 today"' },
          follow_up_directive: { type: 'string', description: 'Optional follow-up cadence the user specified inline with an assign/follow-up command. Examples: "every 4 hours", "every day at 9am", "at 5pm tomorrow", "in 2 hours", "no". When set, the bot schedules an assignee follow-up reminder according to this cadence.' },
          priority: {
            type: 'string',
            enum: ['high', 'normal', 'low'],
            description: 'Task priority'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },

  // ========== TEAM ==========
  {
    type: 'function',
    function: {
      name: 'manage_team',
      description: 'Add/remove/view named teams and their members. Supports multiple named teams. Can add by name from saved contacts OR with phone number. Use for "add Rahul +91xxx to stitch boat team", "add Emily to design team", "add Rahul and Priya to design team", "remove Rahul from stitch boat team", "my stitch boat team", "my teams", "show all teams", "delete design team". A single person can be in multiple teams.\n\n★ DO NOT USE manage_team when the lead verb is "remind/reminder/yaad-dilana" — even if the message mentions a team. "remind me every monday for team standup" → set_reminder, NOT manage_team. The presence of the word "team" inside a reminder body does NOT make it a team-management operation. ★',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'IMPORTANT: If the user uses pronouns like "them", "both of them", "her", "him", "all of them", "these people" etc., you MUST resolve these to actual names from the conversation history. For example, if prior messages mention neha and ammi, and user says "add both of them to ghar team", output "add neha and ammi to ghar team". Always output explicit names, never pronouns.' },
          action: {
            type: 'string',
            enum: ['create', 'add', 'remove', 'list', 'list_teams', 'delete_team'],
            description: 'Structured team operation. Prefer setting this together with team_name/members — it is executed exactly, without re-parsing full_text.'
          },
          team_name: { type: 'string', description: 'Team name, e.g. "design" or "stitch boat"' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Member name' },
                phone: { type: 'string', description: 'Member phone with country code; omit to resolve from saved contacts' }
              },
              additionalProperties: false
            },
            description: 'Members to add (action=add or create) or the single member to remove (action=remove)'
          }
        },
        required: ['full_text']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'manage_leave',
      description: 'Apply for leave, check leave balance, approve/reject leave requests.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original leave management message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'handle_leave_approval',
      description: 'Respond to a pending leave approval/rejection. Use ONLY when there is active leave approval context and user replies with "approve", "reject", "go ahead".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User response to leave approval' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_standup',
      description: 'Setup/configure TEAM standups, view team standup results. For personal standups use personal_standup instead.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original standup management message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'handle_standup_setup',
      description: 'Set up a smart standup with morning check-in and evening wrap-up. AI compares planned vs actual work and sends alignment reports. Use when user says "setup standup", "create standup", "start standup for team", or is answering a standup setup step.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User answer for standup setup step' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'handle_standup_response',
      description: 'Answer standup questions. Use ONLY when there is active standup response context and user is answering a standup question.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User standup answer' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_polls',
      description: 'Create, view, close polls, surveys, or team votes. Use for "create a poll", "start a vote", "poll results", "close the poll".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original poll management message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'handle_poll_vote',
      description: 'Vote on an active poll. Use ONLY when there is active poll context and user replies with a vote like "2", "option 1", "the first one".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User vote response' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_team_availability',
      description: 'Check when OTHER TEAM MEMBERS are free or available — NOT for the user\'s own availability. Use ONLY when the query explicitly references other people, a named team, or the collective team: "when is Rahul free?", "team availability for the standup", "who on the team is available at 3pm". For the user\'s own calendar / schedule / availability queries ("am I free at 3pm", "what\'s my availability this week"), use view_calendar instead.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original availability query' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== NOTES & LISTS ==========
  {
    type: 'function',
    function: {
      name: 'manage_notes',
      description: 'Save, view, search, or delete notes. Use for "save a note: meeting went well", "note under ideas: caching strategy", "my notes", "show my ideas notes", "search notes for caching", "find note about X", "look in my notes for X", "delete note #3", "delete ideas notes". ★ THE VERB DECIDES ★ Any note-taking verb — note, jot, jot down, write down, take down, record, "save this as a note", "add to my notes" — routes HERE, even when the content is a personal fact that would otherwise suit save_memory. Use save_memory only for a personal fact stated with NO note-taking verb ("my wifi password is abc"). HARD RULE: if the message contains the exact phrase "search notes" / "find notes" / "in my notes" / "from my notes" / "my notes for" / "search my notes", this MUST be manage_notes with action=search — NEVER web_search.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original note management message' },
          action: {
            type: 'string',
            enum: ['save', 'list', 'list_topic', 'search', 'delete_note', 'delete_topic', 'view'],
            description: 'save=create note, list=list note topics, list_topic=notes for a specific topic, search=find notes, delete_note=delete by ID, delete_topic=delete all in topic, view=compatibility alias for list_topic and requires topic; it does not retrieve a single note'
          },
          note_content: { type: 'string', description: 'Note text content (for save)' },
          topic: { type: 'string', description: 'Note topic/category (for save/list_topic/delete_topic, e.g. "ideas", "meeting", "work")' },
          note_id: { type: 'integer', description: 'Note ID number (for delete_note)' },
          search_query: { type: 'string', description: 'Search term (for search action)' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_lists',
      description: 'Create, view, or manage lists (shopping, todo, etc.). Use for "create a shopping list", "add milk to my shopping list", "add eggs and bread to shopping list", "show my shopping list", "show all lists", "done milk from shopping list", "remove bread from list", "clear shopping list".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original list management message' },
          action: {
            type: 'string',
            enum: ['create', 'add_item', 'view', 'view_all', 'check_item', 'remove_item', 'clear'],
            description: 'create=new list, add_item=add items to list, view=show specific list, view_all=show all lists, check_item=mark done, remove_item=delete item, clear=empty list'
          },
          list_name: { type: 'string', description: 'List name (e.g. "shopping", "todo", "groceries")' },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Items to add (for add_item). Split "eggs and bread" into ["eggs", "bread"]. Split "milk, eggs, bread" into ["milk", "eggs", "bread"].'
          },
          item_text: { type: 'string', description: 'Single item text (for check_item/remove_item)' },
          priority: {
            type: 'string',
            enum: ['high', 'normal', 'low'],
            description: 'Item priority. "urgent", "important", "asap" = high. "whenever", "someday" = low.'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },

  // ========== BRIEFING & SUMMARIES ==========
  {
    type: 'function',
    function: {
      name: 'daily_briefing',
      description: 'Get a COMBINED daily-overview digest (calendar + reminders + tasks all together) for TODAY. Use ONLY for explicitly omnibus phrasing: "what\'s on my plate today", "daily digest", "morning summary", "brief me on my day", "what\'s my day look like", "give me the rundown", "what\'s on the agenda", "aaj kya hai schedule mein", "aaj ka plate", "आज क्या है", "¿qué tengo hoy?", "mon programme du jour", "was steht heute an", "ماذا لدي اليوم". STRICT EXCLUSIONS — DO NOT use daily_briefing for: (a) "show my tasks" / "मेरे कार्य दिखाओ" / "मेरे tasks" / "mes tâches" → use manage_tasks. (b) "what\'s on my calendar today" / "show my calendar" / "show my meetings" / "मेरा कैलेंडर" → use view_calendar. (c) "show my reminders" → use view_reminders. Daily-briefing is ONLY when the user wants the omnibus combined view; if they\'re asking specifically about tasks OR calendar OR reminders alone, route to that specific tool.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'thread_summary',
      description: 'Summarize the recent WhatsApp conversation with Ari. Use when user asks: "summarize our chat", "what have we been talking about", "recap", "tl;dr of our conversation", "summarize the last 20 messages", "humari baat ka summary". Do NOT use for summarizing a meeting transcript (that\'s meeting_minutes) or summarizing emails (that\'s email_query).',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original summary request' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== DELEGATION ==========
  {
    type: 'function',
    function: {
      name: 'delegate_message',
      description: 'Send a WhatsApp message to someone on user\'s behalf. Triggers (explicit OR implicit): "tell Emily I\'ll be late", "message Rahul about X", "let the team know", "notify rahul about X", "ask emily to review the deck", "tell rahul meeting moved to 3pm", "send rahul the address", "update team on the delay". KEY: verbs "tell/ask/message/notify/update/inform + [person or team]" imply this tool, regardless of whether "delegate" is said. NOT for "remind [person]" (that\'s set_reminder with target_name). For team broadcast, set target_name="team". If the request is a FUTURE-scheduled message ("tell rahul at 5pm tomorrow..."), use scheduled_message instead. ★ CRITICAL DISAMBIGUATION ★ If the user explicitly says "ASSIGN TASK to X", "give X a task", "delegate task to X", "task for X", "assign work to X", "X ke liye task" — that is NEVER delegate_message. It is ALWAYS manage_tasks with action=assign. delegate_message is only for sending a one-off informational message; manage_tasks/assign creates a tracked task with follow-ups, status, and accountability. When in doubt and the word "task" appears, prefer manage_tasks.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original delegation message' },
          target_name: { type: 'string', description: 'Name of recipient or "team" for team broadcast' },
          message_content: { type: 'string', description: 'The actual message to send' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scheduled_message',
      description: 'Send a WhatsApp message to a person at a SPECIFIC future time (scheduled delivery). Use when user says: "message Rahul at 5pm saying...", "send a message to mom tomorrow at 9am", "schedule a text to John for Monday 10am", "kal subah Rahul ko message bhejna". Key signal: recipient + future timestamp + message content all specified. Do NOT use for delegate_message (immediate send) or set_reminder (Ari pings the user themselves, not a third party).',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original scheduled message request' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== GOOGLE WORKSPACE ==========
  {
    type: 'function',
    function: {
      name: 'connect_google',
      description: 'Connect/link Google account for calendar, email, drive access.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'disconnect_google',
      description: 'Disconnect/unlink Google account.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_drive',
      description: 'Search for files in Google Drive, list Drive files, find documents. Use when: "find file X in drive", "search drive for X", "show my drive files", "list files", "upload to drive".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'File search query' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_drive_folder',
      description: 'Create a new folder in the user\'s Google Drive. Use when: "create a drive folder called X", "make a new folder in drive named X", "new google drive folder X". Uses the drive.file scope (write to files this app creates).',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message' },
          folder_name: { type: 'string', description: 'Name of the folder to create' }
        },
        required: ['full_text', 'folder_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'share_drive_file',
      description: 'Share a Google Drive file or FOLDER (one previously created by this app, or one Ari uploaded for the user) with another person\'s email address. Use when: "share my drive file X with alice@example.com" (read-only), "give bob@x.com edit access to the Acme folder", "share the Q3 folder with the team so they can add docs", "send the Project folder to john@x.com to upload files". Detect the access level from the wording: "view" / "see" / "share with" → reader; "comment" / "leave feedback" → commenter; "edit" / "add" / "upload" / "collaborate" / "contribute" / "drop files" → writer. Defaults to reader if unclear. Uses drive.file scope.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message' },
          file_query: { type: 'string', description: 'Filename or folder name to find' },
          recipient_email: { type: 'string', description: 'Email address of the person to share with' },
          role: {
            type: 'string',
            enum: ['reader', 'commenter', 'writer'],
            description: 'reader = view only (default), commenter = view + comment, writer = edit/upload/add files (use when user wants the recipient to add documents or collaborate)'
          },
          message: { type: 'string', description: 'Optional short note included in the Google share email' }
        },
        required: ['full_text', 'file_query', 'recipient_email']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_docs',
      description: 'Create, read, summarize, or search Google Docs. Use when: "create a google doc", "create document called X", "read this doc [link]", "summarize doc [link]", "search my docs for X", "make a new document".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original docs management message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_sheets',
      description: 'Read, summarize, search, OR CREATE Google Spreadsheets/Sheets. Use when: "read this spreadsheet [link]", "summarize sheet [link]", "open this Google Sheets link", "create a google sheet called X", "make a new spreadsheet named X".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original sheets management message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_slides',
      description: 'Read, summarize, search, or CREATE Google Slides presentations. Use when: "create a google slides called X", "make a new presentation named X", "read this slides [link]", "summarize this presentation [link]", "search my presentations for X". Uses presentations / presentations.readonly scopes.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original slides management message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upload_to_drive',
      description: 'Upload a file the user JUST SENT in this WhatsApp conversation (PDF, image, document, etc.) into the user\'s Google Drive. Use when, AFTER the user sent a document or image attachment in WhatsApp, they say: "save this to drive", "upload it to my drive", "put this in my google drive", "save the PDF to drive". Requires a recently-uploaded document in context — do NOT call this if no file was sent. Uses drive.file scope.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_google_tasks',
      description: 'Directly view, create, or complete items in the user\'s Google Tasks list (separate from Ari\'s internal task manager). Use for "show my google tasks", "add to google tasks: X", "complete google task 1", "sync with google tasks". Do NOT use this for general "add task" — that goes to manage_tasks which auto-syncs.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string' },
          action: {
            type: 'string',
            enum: ['list', 'create', 'complete'],
            description: 'What to do with Google Tasks'
          },
          title: { type: 'string', description: 'Task title (for create)' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_google_contacts',
      description: 'Find a person in the user\'s Gmail correspondence history (most-emailed names + addresses). Use for "find John in my google contacts", "search google contacts for Sarah", "what is John\'s email from my contacts". This uses the existing gmail.readonly scope to scan recent inbox/sent — it does NOT call the Google People/Contacts API and requires no extra scope. Most contact lookups should fall through normal flow; use this only when the user explicitly asks to find a contact by name.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string' },
          query: { type: 'string', description: 'Name or search term' }
        },
        required: ['full_text', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_labels',
      description: 'Archive, label, unlabel, or mark Gmail emails as read/unread. Use for "archive email X", "label email as Work", "mark as read", "move email to Y label", "list my gmail labels", "remove Work label from email 1". The user may reference an email by subject, sender, or position (e.g., "1", "first one").',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original user message' },
          action: {
            type: 'string',
            enum: ['archive', 'mark_read', 'mark_unread', 'apply_label', 'remove_label', 'list_labels'],
            description: 'What to do with the email'
          },
          message_ref: {
            type: 'string',
            description: 'Email reference: subject, sender name, position like "1" or "first", or message ID. Omit for list_labels action.'
          },
          label_name: {
            type: 'string',
            description: 'Label name (required for apply_label and remove_label actions)'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },

  // ========== EMAIL AUTOMATION ==========
  {
    type: 'function',
    function: {
      name: 'manage_email_automation',
      description: 'Enable/disable email automation features: auto-labeling (AI categorizes inbox emails into Urgent, Action Needed, FYI, Newsletter, Promotion every 15 min) and reply tracking (get notified on WhatsApp when no reply received). Use for "enable auto labeling", "turn off reply tracking", "set reply tracking to 48 hours", "email automation settings", "show email settings", "disable auto label".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original user message' },
          action: {
            type: 'string',
            enum: ['enable_auto_label', 'disable_auto_label', 'enable_reply_tracking', 'disable_reply_tracking', 'set_reply_hours', 'view_settings'],
            description: 'What to do'
          },
          hours: { type: 'integer', description: 'Reply tracking wait hours (for set_reply_hours action)' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'track_email_reply',
      description: 'Track a specific sent email for replies, or view/cancel tracked emails. Use for "track reply from John", "am I tracking any emails", "show tracked emails", "stop tracking email 2", "notify me if no reply to the last email".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original user message' },
          action: {
            type: 'string',
            enum: ['track', 'list', 'cancel'],
            description: 'track=track a specific email, list=show tracked emails, cancel=stop tracking'
          },
          recipient: { type: 'string', description: 'Email or name of recipient to track' },
          hours: { type: 'integer', description: 'Custom wait hours before notification' },
          tracking_index: { type: 'integer', description: 'Index of tracked email to cancel (for cancel action)' }
        },
        required: ['full_text', 'action']
      }
    }
  },

  // ========== MICROSOFT ==========
  {
    type: 'function',
    function: {
      name: 'connect_outlook',
      description: 'Connect Microsoft/Outlook account.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'disconnect_outlook',
      description: 'Disconnect Microsoft/Outlook account.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },

  // ========== APPLE ==========
  {
    type: 'function',
    function: {
      name: 'connect_apple',
      description: 'Connect Apple Calendar/iCloud.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'disconnect_apple',
      description: 'Disconnect Apple Calendar.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },

  // ========== SALES ==========
  {
    type: 'function',
    function: {
      name: 'manage_sales',
      description: 'Manage sales leads, pipeline, cold emails, follow-ups. Use for "add lead John from Acme", "sales summary", "move John to proposal", "cold email to lead", "my leads", "new leads", "leads in meeting stage", "lead details John", "delete lead John", "update John\'s email/company/title".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original sales management message' },
          action: {
            type: 'string',
            enum: ['add_lead', 'move_stage', 'list', 'details', 'update', 'delete', 'archive', 'restore', 'mark_contacted', 'summary', 'cold_email', 'follow_up_email', 'set_follow_up'],
            description: 'add_lead=new lead, move_stage=change pipeline stage, list=show leads (optionally filtered by stage), details=show lead info, update=edit CRM profile fields the user explicitly names (email/company/title/source/phone/linkedin_url/website/priority/location/notes/deal_value), delete=remove lead permanently, archive=hide a lead without deleting it, restore=unarchive it, mark_contacted=RECORD AN INTERACTION THAT ALREADY HAPPENED and stamp last-contacted now. Any past-tense report of reaching the lead routes here, not to update: \"I called Acme this morning\", \"spoke to Priya\", \"just got off a call with them\", \"emailed them yesterday\", \"met them at the conference\", \"followed up with Acme\". Put anything they told you in notes; the interaction itself is still mark_contacted, summary=pipeline overview, cold_email=draft cold email, follow_up_email=draft a follow-up email, set_follow_up=record a follow-up due time'
          },
          lead_name: { type: 'string', description: 'Lead/contact name' },
          company: { type: 'string', description: 'Company name (for add_lead or update)' },
          email: { type: 'string', description: 'Email address (for add_lead or update)' },
          title: { type: 'string', description: 'Job title (for update)' },
          source: { type: 'string', description: 'Lead source (for update)' },
          phone: { type: 'string', description: 'Phone number (for update)' },
          linkedin_url: { type: 'string', description: 'LinkedIn URL (for update)' },
          website: { type: 'string', description: 'Website URL (for update)' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Lead priority (for update)' },
          location: { type: 'string', description: 'Location (for update)' },
          notes: { type: 'string', description: 'Lead notes (for add_lead or update)' },
          deal_value: { type: 'number', description: 'Deal value (for add_lead or update)' },
          stage: {
            type: 'string',
            enum: ['new', 'contacted', 'replied', 'meeting', 'proposal', 'negotiation', 'won', 'lost', 'closed_won', 'closed_lost'],
            description: 'Pipeline stage (for move_stage or list filter). won/closed_won and lost/closed_lost are equivalent.'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_file',
      description: 'Analyze or summarize the user\'s most recently attached/saved Excel, CSV, PDF, or Word document. This returns a bounded model-readable preview, not a lossless bulk data stream. For creating CRM groups/members from workbook tabs, use manage_contact_groups with action sync_from_file so every row is parsed locally and checkpointed.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original message' },
          question: {
            type: 'string',
            description: 'What to extract or answer from the file, e.g. "list every tab name and the leads in each tab with name, email, company"'
          },
          file_name: { type: 'string', description: 'Optional: part of the file name, when the user refers to a specific saved file' }
        },
        required: ['full_text', 'question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_contact_groups',
      description: 'Create and manage CRM contact groups — named buckets of leads/contacts shown in the dashboard under Contacts → Groups. For a spreadsheet with multiple group tabs or many contacts, call sync_from_file exactly once; it parses the workbook server-side, imports contacts by exact email/phone, checkpoints progress, and safely resumes retries. Do not call create/add_members once per row.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original group management message' },
          action: {
            type: 'string',
            enum: ['create', 'add_members', 'remove_members', 'list', 'rename', 'set_emoji', 'archive', 'restore', 'delete', 'sync_from_file'],
            description: 'create=new group, add_members=add existing leads/contacts by exact name, remove_members=remove named members from the group (the people themselves are kept), list=show groups, rename=change a group\'s name, set_emoji=change its emoji, archive=hide it from active views (reversible), restore=unarchive, delete=delete one group by name (or all groups with delete_all), sync_from_file=import every workbook tab and member in one resumable bulk operation'
          },
          group_name: { type: 'string', description: 'Group name, e.g. "greencardguide"' },
          new_name: { type: 'string', description: 'New group name (for rename)' },
          member_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact names of existing leads/contacts to add to or remove from the group'
          },
          emoji: { type: 'string', description: 'Optional emoji for the group' },
          delete_all: { type: 'boolean', description: 'For delete: true deletes EVERY group. Requires confirm=true after the user explicitly confirms.' },
          confirm: { type: 'boolean', description: 'For delete with delete_all: set true ONLY after the user has explicitly confirmed the bulk deletion in this conversation.' },
          file_name: { type: 'string', description: 'For sync_from_file: optional full or partial name of the attached workbook' },
          retry_failed: { type: 'boolean', description: 'For sync_from_file: retry only failed or unfinished workbook groups; defaults to true' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_campaigns',
      description: 'Create and manage bulk email campaigns — the campaigns shown in the dashboard under Contacts → Campaigns. Use for "what campaigns are running", "create a campaign for the leads group", "draft the campaign email", "start the campaign", "pause it", "campaign status". create_draft stages a campaign WITHOUT sending anything; compose writes the subject/body; start begins sending and requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original campaigns message' },
          action: {
            type: 'string',
            enum: ['list', 'status', 'create_draft', 'compose', 'update', 'start', 'pause', 'resume', 'archive', 'restore', 'delete'],
            description: 'list=recent campaigns, status=stats for one, create_draft=CREATE THE CAMPAIGN RECORD for a named group without sending it. Whenever the user names a recipient group — \"draft a campaign for the investors\", \"set up a campaign to my leads about X\", \"create a campaign for [group]\" — use this, not compose. It stages a real campaign the dashboard can show. compose=write subject/body copy ONLY, creating nothing. Use it when the user just wants wording (\"what should the email say\", \"reword that\") or to revise an existing draft. Composing when the user named a group leaves them with text and no campaign, update=edit subject/body/daily limit, start=begin sending (confirmed), pause/resume, archive/restore, delete'
          },
          campaign_id: { type: 'integer', minimum: 1, description: 'Stable campaign ID' },
          campaign_subject: { type: 'string', description: 'Distinctive subject text to find one campaign' },
          group_name: { type: 'string', description: 'CRM group whose members receive the campaign (for create_draft)' },
          subject: { type: 'string', description: 'Email subject line (create_draft/update)' },
          body: { type: 'string', description: 'Email body template; may use {first_name}, {name}, {company} placeholders (create_draft/update)' },
          purpose: { type: 'string', description: 'What the email should say, in the user\'s words (for compose)' },
          tone: { type: 'string', description: 'Optional tone for compose, e.g. friendly or professional' },
          daily_send_limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum emails per day for this campaign' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_meeting_recordings',
      description: 'Work with recorded meetings — the recordings on the dashboard Meetings page. Read: list recordings, check processing status. Write: retry a failed or stuck recording, rename a diarized speaker (SPEAKER A to a real name, which rebuilds the transcript and report), or turn the report\'s suggested action items into real tasks. Use meeting_minutes for typed meeting NOTES instead.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original meeting-recording message' },
          action: {
            type: 'string',
            enum: ['list', 'status', 'retry', 'rename_speaker', 'create_tasks'],
            description: 'list=recent recordings, status=details for one recording, retry=reprocess a failed or stuck recording, rename_speaker=give a diarized speaker their real name, create_tasks=save the report\'s suggested action items as tasks'
          },
          meeting_id: { type: 'integer', minimum: 1, description: 'Stable recording ID (for status, retry, rename_speaker, create_tasks)' },
          meeting_title: { type: 'string', description: 'Distinctive title text to find one recording when no stable ID is known' },
          speaker_id: { type: 'string', description: 'Diarized speaker label to rename, uppercase letters only, e.g. A or B' },
          speaker_name: { type: 'string', description: 'Real name to give that speaker' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'handle_sales_email_confirmation',
      description: 'Respond to a pending sales email confirmation. Use ONLY when there is active sales email context.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'User response to sales email confirmation' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== WEB SEARCH ==========
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Fetch real-time info from the web. Triggers (explicit or implicit): (1) Explicit — "search for X", "google X", "look up X", "find out X"; (2) Implicit — question about CURRENT/LIVE data. Patterns: "weather in [city]", "price of [thing]", "bitcoin/stock/crypto price", "USD/INR rate", "latest news", "who is [public person]", "what happened in [recent event]", "best [product] under [price]", "today\'s match score". KEY: any question about NOW / TODAY / CURRENT / LATEST → web_search. Don\'t require the word "search". Also triggers: recipes, movie info, restaurants, travel prices. NEVER answer live financial/currency/weather/news from training knowledge — always search. STRICT EXCLUSIONS (HARD VETO — never web_search if any apply): (a) message contains "search notes", "find notes", "in my notes", "from my notes", "my notes for", "search my notes" → manage_notes (search). (b) message contains "search tasks", "my tasks for", "find task" → manage_tasks. (c) "search reminders" / "find reminder" → reminders_manage. (d) "search contacts" / "find contact" → contact_manage. (e) "search memory" / "what do you remember about X" → recall_memory. (f) "search inbox" / "find the email about" → check_inbox. The general rule: if the user is searching their OWN saved DATA (anything they previously entered into Ari), it is NEVER web_search — even if the message also contains the word "search".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'The search query / question' }
        },
        required: ['full_text']
      }
    }
  },

  // ========== TIMEZONE ==========
  {
    type: 'function',
    function: {
      name: 'set_timezone',
      description: 'Set or change the user\'s timezone. Use for "set timezone to IST", "change my timezone to America/New_York", "timezone London".',
      parameters: {
        type: 'object',
        properties: {
          timezone_input: { type: 'string', description: 'The timezone value (e.g. "IST", "America/New_York", "London", "GMT+5:30")' }
        },
        required: ['timezone_input']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_timezone',
      description: 'Show the user\'s current timezone setting. Use for "what\'s my timezone?", "show timezone", "tz?".',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },

  // ========== ACCOUNT & UTILITY ==========
  {
    type: 'function',
    function: {
      name: 'link_account',
      description: 'Create a one-time login link for the Ari web dashboard, or list the accounts already connected. Use for "open my dashboard", "dashboard link", "my linked accounts". Unlinking, notification routing, and link-code entry are not supported.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original account linking message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'translate_text',
      description: 'Translate text between languages. ALWAYS use this tool (never answer directly) when the user wants translation. Triggers: "translate X to Y", "say X in Y", "how do you say X in Y", "X in French/Hindi/Spanish/etc.", "convert to Urdu", "what is X in Y language", "X ka hindi me kya hoga", "translate this". Do NOT answer translation requests yourself — ALWAYS call this tool.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'The full original user message containing the translation request' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'export_data',
      description: 'Export/download user data (contacts, memories, reminders, etc.).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_version',
      description: 'Show app version, features, what\'s new, changelog.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_help',
      description: 'Show help message with available features. Use when user asks "what can you do?", "help", "features".',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clear_chat_history',
      description: 'Clear/reset the conversation history.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },

  // ========== HANDLER REGISTRY FEATURES ==========
  {
    type: 'function',
    function: {
      name: 'focus_mode',
      description: 'Start/stop a focus session or pomodoro timer. Use for "start focus mode", "pomodoro 25 mins", "end focus", "focus stats", "deep work for 1 hour", "am I in focus mode?", "focus status".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original focus mode message' },
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status', 'stats'],
            description: 'start=begin session, stop=end session, status=check if in focus, stats=show focus history/report'
          },
          duration_minutes: { type: 'integer', description: 'Session duration in minutes (e.g. "25 mins" = 25, "1 hour" = 60, "2 hours" = 120)' },
          mode: {
            type: 'string',
            enum: ['pomodoro', 'deep_work', 'regular'],
            description: 'pomodoro=25 min cycles, deep_work=extended uninterrupted, regular=default focus'
          },
          label: { type: 'string', description: 'What to focus on (e.g. "focus on API design" → label="API design")' },
          period: {
            type: 'string',
            enum: ['today', 'week', 'month'],
            description: 'For stats: which period to show'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_habits',
      description: 'Track, log, view, or manage daily habits/routines. ALWAYS pick this when message contains "habit" word + create/track/add/log/delete/stats verb, e.g. "track habit: X" / "add habit: X" / "log habit: X" / "habit stats" / "my habits" / "delete habit X". Also: "done [habit]" / "completed [habit]" / "finished [habit]" / "did [habit]" → log action. Use for "track habit: drink water", "done meditation", "completed my run", "my habits", "habit streak", "delete habit reading", "habit stats". Hindi/Hinglish: "aaj running ho gayi" (completed running today), "meditation kar li" (did meditation), "paani pee liya" (drank water), "[habit] ho gaya/gayi/gaye" = log habit as done. ALWAYS extract `habit_name` from message text (the noun after "habit:" or "done"), and set `action` to one of create/log/list/delete/stats. NEVER leave habit_name empty when user named a specific habit.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original habit management message' },
          action: {
            type: 'string',
            enum: ['create', 'log', 'delete', 'list', 'stats'],
            description: 'create=new habit to track, log=mark habit done today ("done meditation", "completed run"), delete=remove habit, list=show all habits, stats=show streak/progress'
          },
          habit_name: { type: 'string', description: 'Name of the habit (e.g. "meditation", "drink water", "run", "reading")' },
          frequency: {
            type: 'string',
            enum: ['daily', 'weekly'],
            description: 'How often the habit should be done'
          },
          target_count: { type: 'integer', description: 'Target times per period (e.g. "3x per day" = 3)' },
          notes: { type: 'string', description: 'Optional notes when logging (e.g. "done meditation - 20 mins" → notes="20 mins")' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_expenses',
      description: 'Track, update, or review expenses and spending. ALWAYS pick this when message contains "expense"/"spent"/"spending"/"log [amount]" or amount-on-category pattern. "log expense: 500 for lunch" / "spent 500 on lunch" / "expenses this month" / "how much did I spend" / "log 1500 for dinner" / "update transport from 1500 to 2000" / "change food expense to 800" / "edit bills to 1200" / "delete expense #3" / "100 on coffee, 200 on uber, 500 on groceries". Set `action` to add/list/summary/delete/update_by_category. ALWAYS extract amount + category when message contains them — never leave amount blank if user said a number.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original expense tracking message' },
          action: {
            type: 'string',
            enum: ['log', 'update_by_category', 'update_by_id', 'delete', 'summary', 'list', 'multi_log'],
            description: 'log=add new expense, update_by_category=change amount for a category, update_by_id=change amount for expense #N, delete=remove expense #N, summary=spending report, list=show expenses for period, multi_log=multiple expenses in one message'
          },
          amount: { type: 'number', description: 'Expense amount (for log/update)' },
          new_amount: { type: 'number', description: 'New amount when updating an expense' },
          category: {
            type: 'string',
            enum: ['food', 'transport', 'shopping', 'bills', 'entertainment', 'health', 'education', 'travel', 'groceries', 'other'],
            description: 'Expense category. "coffee", "chai", "tea", "lunch", "dinner", "breakfast", "swiggy", "zomato" = food. "uber", "ola", "cab", "taxi", "auto", "petrol", "fuel", "parking" = transport.'
          },
          expense_id: { type: 'integer', description: 'Expense ID number (for update_by_id/delete), e.g. #3' },
          period: {
            type: 'string',
            enum: ['today', 'week', 'month', 'year', 'all'],
            description: 'Time period for summary/list'
          },
          currency: {
            type: 'string',
            enum: ['INR', 'USD', 'EUR', 'GBP'],
            description: 'Currency. Default INR unless $ (USD), € (EUR), £ (GBP) mentioned.'
          },
          description: { type: 'string', description: 'What the expense was for (e.g. "lunch with team", "uber to airport")' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: { type: 'number' },
                description: { type: 'string' },
                category: { type: 'string' }
              }
            },
            description: 'For multi_log: array of {amount, description, category} entries'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'track_time',
      description: 'Track work time, timesheets, or billable hours. Use for "start timer on client work", "stop timer", "time summary today", "hours this week", "time log", "what am I working on".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original time tracking message' },
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status', 'summary', 'log'],
            description: 'start=begin timer, stop=end timer, status=what am I tracking now, summary=hours report, log=show time entries'
          },
          task_description: { type: 'string', description: 'What is being tracked (e.g. "client work", "API development", "meeting prep")' },
          project: { type: 'string', description: 'Project name if specified (e.g. "for Project Alpha" → project="Project Alpha")' },
          period: {
            type: 'string',
            enum: ['today', 'yesterday', 'week', 'month'],
            description: 'For summary/log: which period'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_follow_ups',
      description: 'Set/view/complete follow-ups with people. Use for "follow up with Rahul about proposal on Friday", "my follow-ups", "complete follow-up #3", "delete follow-up #2".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original follow-up management message' },
          action: {
            type: 'string',
            enum: ['create', 'complete', 'delete', 'list'],
            description: 'create=new follow-up, complete=mark done, delete=remove, list=show pending'
          },
          follow_up_id: { type: 'integer', description: 'Follow-up ID number (for complete/delete)' },
          contact_name: { type: 'string', description: 'Person to follow up with' },
          subject: { type: 'string', description: 'What to follow up about' },
          due_time: { type: 'string', description: 'Optional follow-up due date/time as ISO-8601 or a clear local phrase such as "next Friday at 3pm".' },
          priority: {
            type: 'string',
            enum: ['high', 'normal', 'low'],
            description: 'Priority level. "urgent", "asap", "important", "critical" = high. "low priority", "whenever", "no rush" = low.'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_reading_list',
      description: 'Save/view bookmarks or reading list. Use when message contains a URL/link to save, or "my reading list", "show saved links", "reading stats", "mark read #3", "delete bookmark #2". If message has a URL, prefer this over manage_notes.',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original reading list message' },
          action: {
            type: 'string',
            enum: ['save', 'list', 'delete', 'mark_read', 'stats', 'search'],
            description: 'save=bookmark URL, list=show reading list, delete=remove bookmark, mark_read=mark as read, stats=reading statistics, search=find bookmark'
          },
          url: { type: 'string', description: 'URL to save (for save action)' },
          item_id: { type: 'integer', description: 'Bookmark/item ID number (for delete/mark_read)' },
          search_query: { type: 'string', description: 'Search term (for search action)' },
          show_all: { type: 'boolean', description: 'true=show all including read, false=unread only (for list action)' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quick_note_docs',
      description: 'Append notes to Google Docs. Use for "append to my notes doc: meeting went well", "add to doc: action items".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original quick note message' }
        },
        required: ['full_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'personal_standup',
      description: 'Log personal daily standup (NOT team standup). Use for "my standup", "log standup: done API, plan UI", "standup history", "weekly reflection", "today\'s standup", "past standups".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original personal standup message' },
          action: {
            type: 'string',
            enum: ['log', 'history', 'today', 'weekly_reflection'],
            description: 'log=submit standup update, history=past standups, today=show today\'s entry, weekly_reflection=week review/recap'
          },
          yesterday_done: { type: 'string', description: 'What was completed yesterday (for log)' },
          today_plan: { type: 'string', description: 'What is planned today (for log)' },
          blockers: { type: 'string', description: 'Any blockers or issues (for log)' },
          mood: {
            type: 'string',
            enum: ['great', 'good', 'okay', 'bad', 'awful'],
            description: 'How feeling today (for log)'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_shared_board',
      description: 'Team task/project board (kanban-style). Use for "create board: Project Alpha", "add task to board X: do Y", "board status", "assign task #3 to Rahul", "complete task #5", "move task #2 to done", "my boards", "delete board X", "start task #3".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original shared board message' },
          action: {
            type: 'string',
            enum: ['create_board', 'add_task', 'status', 'assign', 'complete', 'move', 'start', 'list_boards', 'delete_board', 'delete_task'],
            description: 'create_board=new board, add_task=add task to board, status=show board tasks, assign=assign task to person, complete=mark task done, move=move task to column, start=mark task in-progress, list_boards=show all boards, delete_board=remove board, delete_task=remove task'
          },
          board_name: { type: 'string', description: 'Board name (for create/add_task/status/delete_board)' },
          board_description: { type: 'string', description: 'Board description (for create_board, extracted from "Board Name - Description")' },
          task_title: { type: 'string', description: 'Task title/description (for add_task)' },
          task_id: { type: 'integer', description: 'Task ID number (for assign/complete/move/start/delete_task)' },
          assignee_name: { type: 'string', description: 'Person to assign to (for assign/add_task)' },
          priority: {
            type: 'string',
            enum: ['high', 'normal', 'low'],
            description: 'Task priority'
          },
          target_column: {
            type: 'string',
            enum: ['todo', 'in_progress', 'done'],
            description: 'Target status column (for move action). "wip", "doing", "working on" = in_progress.'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_knowledge_base',
      description: 'Team knowledge base/wiki/documentation. Use for "add to kb: how to deploy", "search kb: docker", "kb categories", "show kb article #3", "delete kb #5", "kb", "show kb".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original knowledge base message' },
          action: {
            type: 'string',
            enum: ['add', 'search', 'categories', 'show', 'delete', 'list'],
            description: 'add=new article, search=find articles, categories=list categories, show=view specific article, delete=remove article, list=show recent articles'
          },
          title: { type: 'string', description: 'Article title (for add/show)' },
          content: { type: 'string', description: 'Article content (for add)' },
          article_id: { type: 'integer', description: 'Article ID number (for show/delete)' },
          search_query: { type: 'string', description: 'Search term (for search action)' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_sprints',
      description: 'Agile sprint planning and tracking. Use for "create sprint: Q1 Launch", "add to sprint: build API - 5 pts @Rahul", "sprint status", "end sprint", "sprint velocity", "sprint history", "complete item #3".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original sprint management message' },
          action: {
            type: 'string',
            enum: ['create', 'add_item', 'status', 'end', 'history', 'velocity', 'complete_item'],
            description: 'create=new sprint, add_item=add work item, status=current sprint board, end=close sprint, history=past sprints, velocity=team velocity report, complete_item=mark item done'
          },
          sprint_name: { type: 'string', description: 'Sprint name (for create)' },
          sprint_goal: { type: 'string', description: 'Sprint goal (for create, from "Sprint Name - Goal")' },
          item_title: { type: 'string', description: 'Work item title (for add_item)' },
          story_points: { type: 'integer', description: 'Story points (for add_item, from "5 pts" or "5 points")' },
          item_id: { type: 'integer', description: 'Item ID number (for complete_item)' },
          assignee_name: { type: 'string', description: 'Person to assign to (for add_item, from "@Rahul")' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_incidents',
      description: 'Report/track/resolve incidents, outages, bugs. Use for "report incident: API is down - critical", "incident status", "resolve incident #3: fixed the memory leak", "assign incident #2 to Rahul", "escalate incident #4", "incident stats", "open incidents".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original incident management message' },
          action: {
            type: 'string',
            enum: ['report', 'resolve', 'assign', 'escalate', 'status', 'list', 'stats'],
            description: 'report=new incident, resolve=mark fixed, assign=assign to person, escalate=increase priority, status/list=show open incidents, stats=incident report'
          },
          title: { type: 'string', description: 'Incident title/description (for report)' },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Incident severity (for report). Default medium if not specified.'
          },
          incident_id: { type: 'integer', description: 'Incident ID number (for resolve/assign/escalate)' },
          assignee_name: { type: 'string', description: 'Person to assign to (for assign)' },
          resolution_notes: { type: 'string', description: 'How it was fixed (for resolve)' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'team_analytics',
      description: 'Team health, performance, and productivity reports. Use for "team analytics", "team report", "team stats", "how\'s the team doing", "this week vs last week", "weekly comparison", "who\'s working on what", "who\'s blocked", "team availability", "team health score".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original team analytics request' },
          action: {
            type: 'string',
            enum: ['overview', 'comparison', 'workload', 'blockers', 'availability', 'health'],
            description: 'overview=general team report, comparison=this week vs last week, workload=task distribution per member, blockers=who is blocked today, availability=who is on leave/in focus/available, health=team health score 0-100'
          }
        },
        required: ['full_text', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'meeting_minutes',
      description: 'Create/view meeting notes. Use for "meeting notes for standup: we discussed...", "meeting summary", "action items from meetings", "last meeting", "meeting history", "search meetings about X".',
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: 'Original meeting minutes message' },
          action: {
            type: 'string',
            enum: ['create', 'search', 'action_items', 'last', 'history'],
            description: 'create=new meeting notes, search=find meetings by keyword, action_items=pending action items, last=most recent meeting, history=all past meetings'
          },
          meeting_title: { type: 'string', description: 'Meeting title (for create)' },
          meeting_content: { type: 'string', description: 'Meeting notes content (for create)' },
          search_query: { type: 'string', description: 'Search term (for search action)' }
        },
        required: ['full_text', 'action']
      }
    }
  },
  // Apr 30 2026 — visa tools removed. The visa profile builder feature
  // moved to a separate dedicated bot. See git history for the original
  // 7 tool definitions (visa_find_opportunities, visa_apply, visa_status,
  // visa_evidence_packet, visa_upload_resume, visa_batch_send,
  // visa_dismiss_opportunity).

  {
    type: 'function',
    function: {
      name: 'update_reminder',
      description: 'Change the time of exactly one existing REMINDER, not a calendar event. Use reminder_id only for a stable ID Ari returned, position only for a one-based item in the most recently displayed reminder list, query for distinctive reminder text, or use_last_created=true when the user explicitly refers to the reminder Ari just created. Never guess another reminder when a selector does not resolve.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'integer', description: 'Stable reminder database ID previously shown by Ari; never a display-list position.' },
          position: { type: 'integer', description: 'One-based position from the most recently displayed reminder list; never a stable reminder ID.' },
          query: { type: 'string', description: 'Distinctive text from the reminder message.' },
          use_last_created: { type: 'boolean', description: 'True only when the user explicitly refers to the reminder Ari just created.' },
          new_time: { type: 'string', description: 'The user\'s natural-language new time — e.g. "5pm", "tomorrow at 9am", "2 hours later", "in 30 minutes". Copy the time phrase verbatim from the user\'s message.' },
          full_text: { type: 'string', description: 'Original message text' }
        },
        required: ['new_time']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'news_deep_dive',
      description: 'Pick this when the user asks to know more / read more / expand / tell me more about a specific numbered NEWS item (e.g. "know more about 3", "tell me more about story 1", "expand 5") AND the most recent numbered list in the conversation was a news briefing. If the most recent numbered list the assistant showed was something else (emails, reminders, images, tasks, calendar events), route the positional reference to THAT list\'s tool instead — do NOT default here just because the message contains a number. Do NOT use this for generic "give me news" requests (those go to the briefing or web search tool).',
      parameters: {
        type: 'object',
        properties: {
          position: { type: 'string', description: 'The 1-based position of the news headline the user referenced (e.g. "1", "3", "number 5")' },
          full_text: { type: 'string', description: 'Original message text' }
        },
        required: ['position']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'briefing_toggle',
      description: 'Pick this when the user wants to turn on, turn off, reschedule, or check the status of the automatic morning briefing — the daily auto-delivery of their tasks/meetings/reminders plus top 10 world news. Covers any phrasing expressing intent to enable, disable, pause, resume, or change the time of that auto-briefing. Do NOT confuse with the manual "daily briefing" command which runs on demand — this tool is specifically for toggling the scheduled auto-send.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['enable', 'disable', 'status'],
            description: 'What the user wants: enable to turn on auto-briefing, disable to turn it off, status to check current settings'
          },
          hour: { type: 'integer', description: 'Optional 0-23 hour in user\'s local time if they specified one (e.g. "at 7am" -> 7)' },
          full_text: { type: 'string', description: 'Original message text' }
        }
      }
    }
  },

  // ========== CLARIFICATION (escape hatch — always available) ==========
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description: 'Ask the user ONE short clarifying question instead of guessing. Use this when (a) the message is clearly a request for action but is ambiguous between two or more tools AND the action has side effects (sending a message/email, deleting, booking, assigning, paying), (b) the message is an incomplete fragment whose target cannot be resolved from conversation history (e.g. "kal 5 baje rahul" — event? reminder? message?), or (c) the user references an item ("that one", "the second one", a bare number) but no matching list or entity is visible in recent context. Do NOT use this for read-only requests (listing/viewing) — pick the closest tool instead. Do NOT use this when conversation history already resolves the ambiguity. Ask about the ONE thing that decides the routing, and offer 2-3 concrete options when possible.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One short, specific question in the user\'s language/register, e.g. "Kal 5 baje Rahul ke saath — meeting book karu ya reminder set karu?"' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional 2-3 short answer choices to show as a numbered list, e.g. ["Book a meeting", "Set a reminder", "Send him a message"]'
          },
          full_text: { type: 'string', description: 'Original message text' }
        },
        required: ['question']
      }
    }
  }
];

// These capabilities require Gmail history/modification scopes that are not
// part of the current OAuth plan. Keep their legacy handler mappings intact
// for compatibility, but do not expose them to the model or explicit router.
const DISABLED_GOOGLE_TOOLS = new Set([
  'check_inbox',
  'search_inbox',
  'email_query',
  'followup_email',
  'manage_labels',
  'manage_email_automation',
  'track_email_reply',
  'search_google_contacts',
]);

/**
 * Get all tool definitions.
 *
 * When TOOL_DEFS_VERSION=compact, overrides specific tools' descriptions
 * with compact equivalents (see tool-definitions-compact.js). Tools without
 * a compact override keep their full description, so partial rollout is safe.
 */
function getToolDefinitions() {
  let definitions = toolDefinitions;
  if (process.env.TOOL_DEFS_VERSION === 'compact') {
    const { applyCompactDescriptions } = require('./tool-definitions-compact');
    definitions = applyCompactDescriptions(toolDefinitions);
  }
  return definitions.filter(tool => !DISABLED_GOOGLE_TOOLS.has(tool.function?.name));
}

/**
 * Map from tool name back to the intent type used by handlers.
 * This bridges tool calling with the existing handler infrastructure.
 */
const toolToIntentMap = {
  // Reminders
  set_reminder: 'reminder',
  view_reminders: 'reminder_view',
  cancel_reminder: 'reminder_cancel',
  complete_reminder: 'reminder_complete',

  // Memory
  save_memory: 'memory_save',
  recall_memory: 'memory_recall',

  // Contacts
  save_contact: 'contact_save',
  bulk_save_contacts: 'contact_bulk_save',
  manage_contacts: 'contact_manage',

  // Dashboard
  view_dashboard: 'dashboard',
  delete_dashboard_item: 'dashboard_delete',

  // Images
  manage_images: 'image_manage',
  save_image: 'image_save',

  // Calendar
  create_calendar_event: 'calendar_create',
  cancel_calendar_event: 'calendar_cancel',
  reschedule_calendar_event: 'calendar_reschedule',
  view_calendar: 'calendar_view',
  email_calendar_attendees: 'calendar_email',
  remind_all_calendar: 'calendar_remind_all',
  list_calendars: 'calendar_list',
  handle_calendar_confirmation: 'calendar_confirm',

  // Email
  send_email: 'email_send',
  schedule_email: 'email_schedule',
  bulk_email: 'email_bulk',
  check_inbox: 'inbox_check',
  search_inbox: 'inbox_search',
  email_query: 'email_query',
  handle_email_confirmation: 'email_confirm',
  reuse_recent_email: 'email_reuse',
  followup_email: 'email_followup',

  // Tasks
  manage_tasks: 'task_manage',

  // Team
  manage_team: 'team_manage',
  manage_team_comms: 'team_comms',
  manage_leave: 'leave_manage',
  handle_leave_approval: 'leave_approval',
  manage_standup: 'standup_manage',
  handle_standup_setup: 'standup_setup',
  handle_standup_response: 'standup_response',
  manage_polls: 'poll_manage',
  handle_poll_vote: 'poll_vote',
  check_team_availability: 'team_availability',

  // Notes & Lists
  manage_notes: 'note_manage',
  manage_lists: 'list',

  // Briefing
  daily_briefing: 'briefing',
  thread_summary: 'thread_summary',

  // Delegation
  delegate_message: 'delegate',
  scheduled_message: 'scheduled_message',

  // Google
  connect_google: 'google_connect',
  disconnect_google: 'google_disconnect',
  search_drive: 'drive_search',
  create_drive_folder: 'drive_create_folder',
  share_drive_file: 'drive_share_file',
  manage_docs: 'docs_manage',
  manage_sheets: 'sheets_manage',
  manage_slides: 'slides_manage',
  upload_to_drive: 'drive_upload',
  manage_labels: 'labels_manage',
  manage_email_automation: 'email_automation',
  track_email_reply: 'reply_track',
  manage_google_tasks: 'google_tasks',
  search_google_contacts: 'google_contacts_search',

  // Microsoft
  connect_outlook: 'outlook_connect',
  disconnect_outlook: 'outlook_disconnect',

  // Apple
  connect_apple: 'apple_connect',
  disconnect_apple: 'apple_disconnect',

  // Sales
  manage_sales: 'sales_manage',
  manage_campaigns: 'campaigns_manage',
  manage_contact_groups: 'contact_group_manage',
  analyze_file: 'file_analyze',
  handle_sales_email_confirmation: 'sales_email_confirm',

  // Meetings
  get_meeting_recordings: 'meeting_recordings',

  // Web search
  web_search: 'web_search',

  // Timezone
  set_timezone: 'timezone_set',
  view_timezone: 'timezone_view',

  // Utility
  link_account: 'account_link',
  translate_text: 'translate_text',
  export_data: 'export_data',
  show_version: 'version_info',
  show_help: 'help',
  clear_chat_history: 'clear_history',

  // Handler registry features
  focus_mode: 'focus_mode',
  manage_habits: 'habit_manage',
  manage_expenses: 'expense_manage',
  track_time: 'time_track',
  manage_follow_ups: 'follow_up_manage',
  manage_reading_list: 'reading_list',
  quick_note_docs: 'quick_note_docs',
  personal_standup: 'self_standup',
  manage_shared_board: 'shared_board',
  manage_knowledge_base: 'knowledge_base',
  manage_sprints: 'sprint_manage',
  manage_incidents: 'incident_manage',
  team_analytics: 'team_analytics',
  meeting_minutes: 'meeting_minutes',

  news_deep_dive: 'news_deep_dive',
  briefing_toggle: 'briefing_toggle',
  update_reminder: 'update_reminder',
  request_clarification: 'clarify'
};

/**
 * Get the handler intent type for a tool name
 */
function getIntentForTool(toolName) {
  return toolToIntentMap[toolName] || toolName;
}

// ============================================================================
// Tool subsetting (Ari patch — Phase 1 "ChatGPT-level smart")
//
// Why: sending all ~78 tools to every LLM call costs ~12K tokens in tool
// schemas alone and degrades tool-pick accuracy. OpenAI and Anthropic both
// recommend ≤20 active tools per call. We classify the user's message into a
// category via instant keyword rules (no extra LLM call), then pass only the
// tools in that category + a few always-relevant essentials.
// ============================================================================

/**
 * Static map from tool name → category. Derived from the section headers in
 * this file. Kept here (not inside each tool def) so tool schemas stay untouched
 * and tool registration code doesn't have to know about categories.
 */
const TOOL_CATEGORY = {
  // Reminders
  // NOTE: update_reminder was previously missing here, which caused the bug
  // where "postpone the reminder by 1 hour" got routed to reschedule_calendar_event
  // — the pad algorithm padded the subset with calendar tools since update_reminder
  // lives deep in the tool-definitions file and never reached the padding cursor.
  set_reminder: 'reminder', view_reminders: 'reminder', cancel_reminder: 'reminder',
  update_reminder: 'reminder',
  // Memory
  save_memory: 'memory', recall_memory: 'memory',
  // Contacts
  save_contact: 'contact', bulk_save_contacts: 'contact', manage_contacts: 'contact',
  // These are explicitly Google-scoped tools. Keeping them in the generic
  // task/contact buckets meant the Google keyword classifier hid them from
  // the intent model for messages such as "add X to Google Tasks".
  search_google_contacts: 'google',
  // Dashboard
  view_dashboard: 'dashboard', delete_dashboard_item: 'dashboard',
  // Images
  manage_images: 'image', save_image: 'image',
  // Calendar
  create_calendar_event: 'calendar', cancel_calendar_event: 'calendar',
  reschedule_calendar_event: 'calendar', view_calendar: 'calendar',
  email_calendar_attendees: 'calendar', remind_all_calendar: 'calendar',
  list_calendars: 'calendar', handle_calendar_confirmation: 'calendar',
  // Email
  send_email: 'email', schedule_email: 'email', bulk_email: 'email',
  check_inbox: 'email', search_inbox: 'email', followup_email: 'email',
  email_query: 'email', handle_email_confirmation: 'email',
  reuse_recent_email: 'email', manage_labels: 'email',
  manage_email_automation: 'email', track_email_reply: 'email',
  // Tasks
  manage_tasks: 'task', manage_google_tasks: 'google',
  // Team
  manage_team: 'team', manage_leave: 'team', handle_leave_approval: 'team',
  manage_standup: 'team', handle_standup_setup: 'team',
  handle_standup_response: 'team', manage_polls: 'team', handle_poll_vote: 'team',
  check_team_availability: 'team', team_analytics: 'team',
  manage_team_comms: 'team',
  // Notes & Lists
  manage_notes: 'notes', manage_lists: 'notes', manage_reading_list: 'notes',
  quick_note_docs: 'notes', manage_knowledge_base: 'notes',
  // Briefing & Summaries
  daily_briefing: 'briefing', thread_summary: 'briefing',
  meeting_minutes: 'briefing', get_meeting_recordings: 'briefing',
  // Delegation
  delegate_message: 'delegation', scheduled_message: 'delegation',
  // Google Workspace
  connect_google: 'google', disconnect_google: 'google', search_drive: 'google',
  create_drive_folder: 'google', share_drive_file: 'google', upload_to_drive: 'google',
  manage_docs: 'google', manage_sheets: 'google', manage_slides: 'google',
  // Microsoft
  connect_outlook: 'microsoft', disconnect_outlook: 'microsoft',
  // Apple
  connect_apple: 'apple', disconnect_apple: 'apple',
  // Sales
  manage_sales: 'sales', handle_sales_email_confirmation: 'sales',
  manage_contact_groups: 'sales', manage_campaigns: 'sales',
  analyze_file: 'sales',
  // Search
  web_search: 'search', news_deep_dive: 'search',
  // Account & Utility
  set_timezone: 'account', view_timezone: 'account', link_account: 'account',
  translate_text: 'account', export_data: 'account',
  show_version: 'account', show_help: 'account',
  clear_chat_history: 'account', briefing_toggle: 'briefing',
  // Productivity
  focus_mode: 'productivity', manage_habits: 'productivity',
  manage_expenses: 'productivity', track_time: 'productivity',
  manage_follow_ups: 'productivity', personal_standup: 'productivity',
  manage_shared_board: 'productivity', manage_sprints: 'productivity',
  manage_incidents: 'productivity',
};

/**
 * Always-relevant tools that get included even when we subset by category.
 * These are the "escape hatches" — if the user's intent doesn't match the
 * category keywords but is actually a web search / help / memory recall, the
 * LLM can still pick these.
 */
const ESSENTIAL_TOOLS = [
  'web_search', 'show_help', 'daily_briefing',
  'save_memory', 'recall_memory', 'view_dashboard',
  // The clarification escape hatch must survive EVERY subsetting path —
  // it is what lets the LLM ask instead of guessing when the subset is wrong.
  'request_clarification',
];

/**
 * High-traffic tools that should win the padding slots when a category subset
 * is built. Previously padding used file-definition order (others.shift()),
 * so whether the correct tool survived a category misclassification was an
 * accident of its position in this file — that exact failure shipped once
 * already (see the update_reminder note above TOOL_CATEGORY). These are the
 * tools most casual messages actually need; padding them first means a wrong
 * keyword-category guess usually still leaves the right tool on the menu.
 */
const CORE_PAD_TOOLS = [
  'set_reminder', 'update_reminder', 'cancel_reminder', 'view_reminders',
  'create_calendar_event', 'view_calendar', 'reschedule_calendar_event',
  'send_email',
  'manage_tasks', 'manage_notes', 'news_deep_dive',
  'delegate_message', 'save_contact', 'manage_contacts',
  'manage_lists',
];

/**
 * Instant keyword-based category classifier. No LLM call.
 * Returns null if no keyword matches (caller should use full tool set).
 *
 * Multilingual: English + Hindi/Hinglish keywords for each category.
 */
function classifyCategoryFromKeywords(message) {
  if (!message || typeof message !== 'string') return null;
  const text = message.toLowerCase();

  // Order matters: more specific categories first.
  // Reminder pattern must come BEFORE calendar because Hinglish time-words
  // like "baje" appear in both reminder-style ("subah 6 baje gym") and
  // calendar-style ("meeting 3 baje") phrasings — we want reminder to win
  // unless the user explicitly says meeting/appointment/etc.
  // Order matters: SPECIFIC patterns first (URL signals, named tools, exact
  // phrases) → MEDIUM specificity (delegation, briefing, account, dashboard,
  // image, google) → GENERAL (calendar, email, reminder, memory) →
  // last-resort (productivity, search, sales, contact, task, notes, team).
  // Patterns expanded 2026-04-25 to cover all 21 tool categories.
  const patterns = [
    // 1. Existing meeting-minutes history and search
    ['meeting',     /\b(meeting\s+(minutes|summary|history|notes|action\s+items)|search\s+meetings|last\s+meeting)/i],
    // 2. (Visa pattern removed Apr 30 2026 — visa feature moved to a separate bot)
    // 3. Delegation — must beat calendar/email since "tell rahul" + "meeting" would otherwise route to calendar.
    // Hindi/Devanagari patterns are NOT wrapped in \b because Devanagari chars aren't "word" chars in regex.
    ['delegation',  /(?:\b(?:tell\s+(?:\w+|the\s+team|him|her|them)|let\s+(?:\w+|the\s+team)\s+know|message\s+(?:\w+|the\s+team|mom|dad)|notify\s+(?:\w+|the\s+team|everyone)|inform\s+(?:\w+|the\s+team)|ping\s+\w+\s+(?:saying|that|about)|send\s+\w+\s+(?:a\s+)?message|message\s+\w+\s+at\s+\d)|को\s+मैसेज|मैसेज\s+(?:भेजो|भेज\s+दो)|को\s+message\s+karo)/i],
    // 4. Briefing — must beat calendar (since "schedule" appears in both)
    ['briefing',    /\b(briefing|brief\s*me|daily\s+brief|what.*today|what.*plate|today.?s\s+(schedule|plan|agenda)|what.*going\s+on\s+today|summary\s+of.*day|aaj\s*(ka|kya)\s*(hai|plan|schedule|kaam)|aaj\s+ka\s+schedule|आज\s*क्या|आज\s*का|news\s+(today|update)|deep.dive|tell\s+me\s+more\s+about\s+(story|news)\s*\d?|recap)/i],
    // 5. Account — utility (timezone, dashboard, help) — must beat memory's "what's my X"
    ['account',     /\b(timezone|time\s*zone|what.?s\s+my\s+(timezone|time\s+zone)|set.*tz|set\s+my\s+timezone|export.*data|help\b|version\b|clear\s+chat|link\s+account)/i],
    // 6. Dashboard — stats overview
    ['dashboard',   /\b(dashboard|my\s+(stats|metrics)|show\s+(my\s+)?stats|view\s+dashboard)/i],
    // 7. Image — generate / save image
    ['image',       /\b(generate\s+(an?\s+)?image|create\s+(an?\s+)?image|draw\s+(me|a)|image\s+of\s+|picture\s+of\s+|save\s+(this|that)\s+(image|pic|photo)|set.*as\s+(profile|avatar)|edit\s+this\s+image)/i],
    // 8. Google Workspace — must come before "spreadsheet" hits productivity expense
    ['google',      /\b(google\s*(drive|docs|doc|sheet|sheets|workspace|tasks|contacts)|gmail\s+contacts|spreadsheet|create\s+(a\s+)?(google\s+)?(doc|sheet|spreadsheet)|make\s+a\s+spreadsheet|search\s+(my\s+)?drive|connect\s+(my\s+)?google|gmail.*account)/i],
    // 9. Sales — leads, pitches, CRM. Keep before generic email matching
    // because CRM prompts often include an email address.
    ['sales',       /\b(sales\s+(lead|pipeline)|add\s+lead|new\s+lead|lead\s+[\w\s]+from|prospect|pitch|crm|deal\s+(close|won|lost)|follow\s+up\s+with\s+client|show\s+my\s+(leads|pipeline|deals)|qualified?\s+lead|contact\s+groups?|group\s+(of|for)\s+(leads|contacts))/i],
    // 10. Email — must come before calendar's "schedule" pattern
    ['email',       /\b(send\s+(an?\s+)?email|schedule\s+email|email|mail|e-?mail|inbox|gmail|outlook|reply\s+to|forward|cc:|bcc:|label.*email|archive.*email|unsubscribe|email\s+karo|mail\s+karo|inbox\s+check|kal.*email\s+(bhej|send)|drafted?\s+(an?\s+)?email)/i],
    // 10. Reminder — multilingual + Hinglish + implicit time
    ['reminder',    /\b(remind|reminder|alarm|yaad\s*dila|yaad\s*dilana|reminder\s*bhej|ping\s*me|notif|erinnere|rappel{1,2}e|recu[eé]rda|av[ií]same|lembre|ذكرن|リマインド|提醒|আমাকে.*মনে|நினைவூட்டு|wake\s*me|karna\s*hai|jaana\s*hai|lena\s*hai|(subah|shaam|sham|raat|dopahr|dopeher)\s*\d|\d\s*baje\s*(ka|ko|pe|pr|ko\s*ka)|snooze|postpone\s*the\s*reminder|move\s*(that|the)\s*reminder|please\s+remind)/i],
    // 11. Calendar — last to match generic "meeting"/"schedule"/"event" since others above are more specific
    ['calendar',    /\b(calendar|appointment|book.*slot|free.*at|am\s*i\s*free|my\s*(calendar|meetings|events|schedule)|busy\s*at|when\s*is\s*my|meeting.*(tomorrow|today|at|baje|with|moved)|move\s*my\s*(meeting|appointment)|cancel\s*my\s*(meeting|appointment|event|call)|reschedule|event\s+(at|with|tomorrow|today)|lunch\s*(at|with)|dinner\s*(at|with)|coffee\s*(at|with)|book\s+(a\s+)?(meeting|lunch|dinner|coffee)|kal.*meeting\s+(set|hai))/i],
    // 12. Memory — facts and recall (after account so timezone doesn't fall here)
    ['memory',      /\b(remember(\s|$)|recall|forgot|save.*fact|yaad\s*hai|yaad\s*rakh|my\s+(wifi|password|doctor|landlord|tenant|insurance|passport)|i\s+(work\s+at|live\s+in|am\s+allergic\s+to))/i],
    // 13. Contact — names + phone numbers
    ['contact',     /\b(contact|phone\s+number|save\s+(\w+'s\s+)?(number|contact|phone)|delete.*contact|(\w+)'s\s+(number|phone|mobile|cell)|what.?s\s+(mom|dad|\w+)'s\s+(number|phone)|add\s+\w+\s+to\s+(my\s+)?contacts)/i],
    // 14. Notes & lists — must come before productivity (which has "log" matching habits)
    ['notes',       /\b(save\s+a?\s*note|take\s+(a\s+)?note|jot\s+(this|that)|notes?\s+about|checklist|reading\s+list|knowledge\s+base|shopping\s+list|to.?do\s+list|create\s+a\s+(shopping|grocery|todo|reading)\s+list|add.*to\s+(my\s+)?(reading|shopping|grocery)\s+list|quick\s+note)/i],
    // 15. Productivity — focus, habits, expenses, time
    ['productivity',/\b(focus\s+(mode|session)|start\s+(a\s+)?(focus|pomodoro)|\d+\s*minute\s+focus|habit|log\s+my\s+(workout|meditation|water|run|walk|reading)|done\s+(workout|meditation|gym|run)|expense|spent\s+[₹$€£]?\d|how\s+much\s+(did|have)\s+i\s+spent?|track\s+time(?!zone)|timer|time\s+track|start\s+time\s+tracking|incident|sprint|standup\s+for\s+myself|personal\s+standup|follow.up\s+with\s+\w+\s+(next|on|in)\s+\w+\s+about)/i],
    // 16. Team — standup, polls, leave (other people's, not yours)
    ['team',        /\b(set\s+up.*standup|standup\s+for\s+(the\s+)?(eng|team|engineering|product)|create\s+(a\s+)?poll|poll:\s*|leave\s+request|request\s+leave|approve\s+leave|team\s+avail|teammate|manage\s+team|when\s+is\s+the\s+team\s+free)/i],
    // 17. Task — adding/listing/completing
    ['task',        /\b(task|todo|to-do|to\s+do|assign.*task|pending\s*tasks?|complete.*task|done\s+(task|work)|mark\s+(task|item)\s*\#?\d|task\s+(add|create|delete|list|complete)\s*(karo|kar\s+do)?)/i],
    // 18. Search — web/news
    ['search',      /\b(search\s+(for|the\s+web|online)|google\s+it|look\s+up|latest\s+news|weather|price\s+of|rate\s+of|what.?s\s+(the\s+)?(weather|price|rate|cost)|how\s+much\s+is\s+(\w+|the))/i],
    // 19. Sales — leads, pitches, CRM
    ['sales',       /\b(sales\s+(lead|pipeline)|add\s+lead|prospect|pitch|crm|deal\s+(close|won|lost)|follow\s+up\s+with\s+client|show\s+my\s+(leads|pipeline|deals)|qualified?\s+lead|contact\s+groups?|group\s+(of|for)\s+(leads|contacts))/i],
  ];

  for (const [cat, re] of patterns) {
    if (re.test(text)) return cat;
  }
  return null;
}

/**
 * Get a subset of tools for a given category, padded with essentials.
 *
 * @param {string|null} category - e.g. 'email'. If null/unknown → returns all tools.
 * @param {number} [limit=20] - Hard cap on returned tool count.
 * @returns {Array} OpenAI-format tool definitions.
 */
function getToolsForCategory(category, limit = 20) {
  // Use getToolDefinitions() so compact-description override (when
  // TOOL_DEFS_VERSION=compact) flows through here too. Otherwise the
  // subset path would always use the full descriptions.
  const all = getToolDefinitions();
  if (!category) return all; // no classification → fall back to full set

  const inCat = [];
  const essentials = [];
  const corePad = [];
  const others = [];

  for (const tool of all) {
    const name = tool.function?.name;
    if (!name) continue;
    if (TOOL_CATEGORY[name] === category) inCat.push(tool);
    else if (ESSENTIAL_TOOLS.includes(name)) essentials.push(tool);
    else if (CORE_PAD_TOOLS.includes(name)) corePad.push(tool);
    else others.push(tool);
  }

  // Pad with high-traffic CORE_PAD_TOOLS first (sorted by their priority
  // order in that list, not file order), THEN whatever else fits. This is
  // the safety net for keyword-category misclassification: the correct tool
  // for a mis-bucketed casual message is very likely a core tool.
  corePad.sort((a, b) =>
    CORE_PAD_TOOLS.indexOf(a.function.name) - CORE_PAD_TOOLS.indexOf(b.function.name)
  );

  const result = [...inCat, ...essentials];
  const padPool = [...corePad, ...others];
  while (result.length < limit && padPool.length > 0) {
    result.push(padPool.shift());
  }
  return result.slice(0, limit);
}

/**
 * Return a tool only when the user's wording is explicit and unambiguous.
 * The LLM still extracts arguments; this hint only prevents an obvious action
 * from being hidden by category pruning or downgraded to general chat.
 */
function getExplicitToolHintRaw(message, contextHints = {}) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return null;

  if (/\b(prepare|prep|brief)\b.*\b(meeting|call|appointment)\b/.test(text)) return 'view_calendar';

  // Active workflows are stronger than message keywords for short follow-ups.
  if (contextHints.activeCalendarConfirmation) return 'handle_calendar_confirmation';
  if (contextHints.activeEmailDraftConfirmation || contextHints.activeScheduledEmail || contextHints.activeBulkEmail) {
    return 'handle_email_confirmation';
  }
  if (contextHints.activeLeaveApproval) return 'handle_leave_approval';
  if (contextHints.activeStandupSetup) return 'handle_standup_setup';
  if (contextHints.activeStandupResponse) return 'handle_standup_response';
  if (contextHints.activePollVote) return 'handle_poll_vote';
  if (contextHints.imageWaitingForSaveConfirm && /\b(save|keep|store|discard|don'?t save)\b/.test(text)) return 'save_image';
  if (contextHints.lastBotAction?.action === 'sales_email_confirm') return 'handle_sales_email_confirmation';
  if (contextHints.hasRecentEmailContext && /\b(same|again|previous|earlier|reuse|reschedule)\b.*\b(email|mail)\b|\b(email|mail)\b.*\b(same|again|previous|earlier)\b/.test(text)) {
    return 'reuse_recent_email';
  }

  if (/\bdelete\b.*\bdashboard\b.*\b(reminder|image|item)\b|\bdelete\b.*\b(reminder|image|item)\b.*\bdashboard\b/.test(text)) return 'delete_dashboard_item';
  if (/\b(meeting\s+minutes|meeting\s+notes|action\s+items\s+from|meeting\s+history)\b/.test(text)) return 'meeting_minutes';
  if (/\b(when|is|are|show|check)\b.*\b(team|rahul|priya|alice|bob|members?|everyone)\b.*\b(free|available|availability)\b|\bteam\s+availability\b/.test(text)) {
    return 'check_team_availability';
  }

  // Provider/account connections.
  if (/\b(disconnect|unlink|remove)\b.*\bgoogle\b|\bgoogle\b.*\b(disconnect|unlink)\b/.test(text)) return 'disconnect_google';
  if (/\b(connect|link)\b.*\bgoogle\b|\bgoogle\b.*\b(connect|link)\b/.test(text)) return 'connect_google';
  if (/\b(disconnect|unlink|remove)\b.*\b(outlook|microsoft)\b|\b(outlook|microsoft)\b.*\b(disconnect|unlink)\b/.test(text)) return 'disconnect_outlook';
  if (/\b(connect|link)\b.*\b(outlook|microsoft)\b|\b(outlook|microsoft)\b.*\b(connect|link)\b/.test(text)) return 'connect_outlook';
  if (/\b(disconnect|unlink|remove)\b.*\b(apple|icloud)\b|\b(apple|icloud)\b.*\b(disconnect|unlink)\b/.test(text)) return 'disconnect_apple';
  if (/\b(connect|link)\b.*\b(apple|icloud)\b|\b(apple|icloud)\b.*\b(connect|link)\b/.test(text)) return 'connect_apple';

  // Google Workspace tools that overlap generic task/contact/email categories.
  if (/\bgoogle\s+tasks?\b/.test(text)) return 'manage_google_tasks';
  if (/\b(google|gmail)\s+contacts?\b/.test(text)) return 'search_google_contacts';
  if (/\b(create|make|new)\b.*\bgoogle\s+drive\s+folder\b|\bcreate\b.*\bdrive\s+folder\b/.test(text)) return 'create_drive_folder';
  if (/\bshare\b.*\b(drive|folder|file|document|proposal)\b.*\bwith\b/.test(text)) return 'share_drive_file';
  if (/\b(search|find|show|list)\b.*\b(?:my\s+)?(?:google\s+)?drive\b/.test(text)) return 'search_drive';
  if (/\bquick\s+note\b.*\bgoogle\s+docs?\b/.test(text)) return 'quick_note_docs';
  if (/\b(create|make|read|summarize|search)\b.*\bgoogle\s+docs?\b|\bappend\b.*\bnotes?\s+doc\b/.test(text)) {
    return /\bappend\b/.test(text) ? 'quick_note_docs' : 'manage_docs';
  }
  if (contextHints.hasDocumentAttachment
      && /\b(crm|contacts?|leads?)\b/.test(text)
      && /\b(groups?|buckets?|segments?)\b/.test(text)
      && /\b(sheet|spreadsheet|excel|xlsx|csv|file|attachment|tabs?)\b/.test(text)) {
    return 'manage_contact_groups';
  }
  if (/\b(create|make|read|summarize|search|add|append|update|write)\b.*\bgoogle\s+sheets?\b|\bspreadsheet\b/.test(text)) return 'manage_sheets';
  if (/\b(create|make|read|summarize|search)\b.*\bgoogle\s+slides?\b|\bpresentation\b/.test(text)) return 'manage_slides';
  if (contextHints.hasDocumentAttachment && /\b(upload|save|put)\b.*\bdrive\b/.test(text)) return 'upload_to_drive';
  // A recent attachment + an "act on the file's contents" verb → force the
  // file reader. Without this, "analyze this sheet" routed to chat because
  // no tool could see inside the file.
  if (contextHints.hasDocumentAttachment) {
    const startsWithFileAction = /^(?:please\s+)?(?:analy[sz]e|read|extract|summari[sz]e|go\s+through|check|review|inspect)\b/i.test(text);
    const namesAFile = /\b(sheet|spreadsheet|excel|xlsx|csv|file|doc(ument)?|pdf|attach(ment|ed)?|tabs?)\b/i.test(text);
    const refersToAttachedItem = /\b(this|that|it)\b|\bwhat\s+(?:do\s+)?you\s+see\b|\bwhat(?:'s|\s+is)\s+inside\b/i.test(text);
    if (startsWithFileAction && (namesAFile || refersToAttachedItem)) return 'analyze_file';
  }

  // Contact lookup is distinct from saving a new contact.
  if (/\b(what\s+is|what's|show|find|lookup|look\s+up)\b.*\b(number|phone|contact)\b/.test(text)
      || /\b(list|show)\b.*\bmy\s+contacts?\b/.test(text)) return 'manage_contacts';

  // Explicit reminders must be resolved before email rules. Phrases such as
  // "send reminder to Akash at 8 pm" otherwise resemble a scheduled email.
  if (/\b(move|change|postpone|snooze|reschedule)\b.*\breminder\b/.test(text)) return 'update_reminder';
  if (/\b(cancel|delete|remove|stop)\b.*\breminder\b|\bstop\s+reminding\b/.test(text)) return 'cancel_reminder';
  if (/\b(show|view|list|what|which|pending|active)\b.*\breminders?\b/.test(text)) return 'view_reminders';
  if (/\b(remind|notify|alert)\b.*\b(all|every)\b.*\bcalendar\b/.test(text)) return 'remind_all_calendar';
  if (/\b(remind|reminder|alarm|yaad\s*dila|ping\s+me)\b/.test(text)) return 'set_reminder';

  // Email operations: most specific before generic send/draft.
  const emailCount = (text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []).length;
  if (emailCount >= 2 && /\b(email|mail|send)\b/.test(text)) return 'bulk_email';
  if (/\bemail\b.*\b(attendees?|everyone\s+attending)\b|\bemail\s+everyone\b.*\bmeeting\b/.test(text)) return 'email_calendar_attendees';
  if (/\b(track|notify|alert)\b.*\b(reply|respond|response)\b|\bno\s+reply\b/.test(text)) return 'track_email_reply';
  if (/\b(enable|disable|turn\s+(?:on|off)|settings?)\b.*\b(auto(?:matic)?\s*label|email\s+automation|reply\s+tracking)\b/.test(text)) return 'manage_email_automation';
  if (/\b(mark|label|archive|unarchive)\b.*\b(email|mail|inbox)\b/.test(text)) return 'manage_labels';
  if (/\b(follow[ -]?up)\b.*\b(email|mail|previous|earlier|message)\b/.test(text)) return 'followup_email';
  if (/^(?:please\s+)?(?:search|find)\b.*\b(inbox|emails?|mail)\b/.test(text)) return 'search_inbox';
  if (/\b(did|has|have|any|check|find|search|show)\b.*\b(reply|replied|responded|sent|email|mail|inbox)\b/.test(text)) return 'email_query';
  if (/^(?:please\s+)?schedule\s+(?:an?\s+)?(?:email|mail)\b/.test(text)) return 'schedule_email';
  if (/^(?:please\s+)?(?:send|email|mail)\b.*\b(at|on)\s+(?:\d|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(text)
      && !/\b(about|regarding|saying|that)\b/.test(text)) return 'schedule_email';
  if (/^(?:please\s+)?(?:send|email|mail|write|draft|compose|reply|forward)\b.*(?:@|\bemail\b|\bmail\b)/.test(text)) return 'send_email';
  if (/\b(check|show|open|read|search|find)\b.*\b(inbox|emails?|mail)\b|\b(any|new|unread)\s+(emails?|mail)\b/.test(text)) return 'check_inbox';

  // Reminders, tasks, and saved data.
  if (/\b(google\s+tasks?)\b/.test(text)) return 'manage_google_tasks';
  if (/\b(task|tasks|todo|to-do)\b/.test(text)) return 'manage_tasks';
  if (/\bknowledge\s*base\b|\b(?:add|search|show|delete)\s+(?:to\s+)?(?:the\s+)?kb\b/.test(text)) return 'manage_knowledge_base';
  if (/\b(reading\s+list|saved\s+links?|bookmarks?)\b/.test(text)) return 'manage_reading_list';
  if (/\b(note|notes)\b/.test(text) && /\b(save|show|view|search|find|delete|add|take)\b/.test(text)) return 'manage_notes';
  if (/\b(list|grocery|shopping|checklist)\b/.test(text) && /\b(create|add|show|view|remove|delete|clear|done)\b/.test(text)) return 'manage_lists';

  // Calendar and scheduled briefing controls.
  if (/\b(show|list|view)\b.*\bscheduled\s+messages?\b/.test(text)) return 'scheduled_message';
  if (/\b(turn\s+(?:on|off)|enable|disable|pause|resume|reschedule|change)\b.*\b(?:automatic\s+|morning\s+)?briefing\b/.test(text)) return 'briefing_toggle';
  if (/\b(cancel|delete)\b.*\b(meeting|appointment|calendar\s+event)\b/.test(text)) return 'cancel_calendar_event';
  if (/\b(reschedule|move|shift|postpone)\b.*\b(meeting|appointment|calendar\s+event|call)\b/.test(text)) return 'reschedule_calendar_event';
  if (/\b(schedule|book|arrange|set\s+up)\b.*\b(meeting|appointment|event|call|interview|sync)\b/.test(text)) return 'create_calendar_event';
  if (/\b(show|view|what|when|which|am\s+i)\b.*\b(calendar|meetings?|schedule|free|busy)\b/.test(text)) return 'view_calendar';
  if (/\b(which|list|show)\b.*\bcalendars?\b.*\b(connected|accounts?)\b/.test(text)) return 'list_calendars';

  // Explicit productivity feature names.
  if (/\b(focus|pomodoro|deep\s+work)\b/.test(text)) return 'focus_mode';
  if (/\bhabit|streak\b/.test(text)) return 'manage_habits';
  if (/\b(expense|expenses|spent|spending)\b/.test(text)) return 'manage_expenses';
  if (/\b(track(?:ing)?\s+time|start\s+timer|stop\s+timer|time\s+summary|timesheet)\b/.test(text)) return 'track_time';
  if (/\bfollow[ -]?up\b/.test(text)) return 'manage_follow_ups';
  if (/\b(shared\s+board|project\s+board|board\s+(?:called|status|task))\b/.test(text)) return 'manage_shared_board';
  if (/\bsprint\b/.test(text)) return 'manage_sprints';
  if (/\bincident\b|\boutage\b/.test(text)) return 'manage_incidents';
  if (/\bteam\b.*\b(analytics|performance|report|stats|health)\b/.test(text)) return 'team_analytics';
  if (/\b(deep\s+dive|deep-dive|in[-\s]?depth)\b.*\b(news|story|topic|analysis)\b/.test(text)) return 'news_deep_dive';
  return null;
}

function getExplicitToolHint(message, contextHints = {}) {
  const hint = getExplicitToolHintRaw(message, contextHints);
  return DISABLED_GOOGLE_TOOLS.has(hint) ? null : hint;
}

/**
 * Convenience: classify + fetch subset in one call.
 */
function getToolsForMessage(message, limit = 20) {
  const category = classifyCategoryFromKeywords(message);
  return { category, tools: getToolsForCategory(category, limit) };
}

module.exports = {
  getToolDefinitions,
  getIntentForTool,
  toolToIntentMap,
  // New exports for Phase 1 subsetting:
  TOOL_CATEGORY,
  ESSENTIAL_TOOLS, // exposed for Phase 4 RAG-MCP retriever (always-include safety net)
  CORE_PAD_TOOLS,
  classifyCategoryFromKeywords,
  getExplicitToolHint,
  getToolsForCategory,
  getToolsForMessage,
};
