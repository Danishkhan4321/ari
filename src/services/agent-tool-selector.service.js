'use strict';

const { listTools } = require('../mcp/desktop-tool-registry');

// When a bare-number reply was deterministically resolved against the last
// shown list (positional-resolver.service), the matching list's tools must be
// in the model's visible set — a bare "2" carries no lexical signal of its own.
const POSITIONAL_LIST_TOOLS = {
  reminders: ['cancel_reminder', 'complete_reminder', 'update_reminder', 'view_reminders'],
  tasks: ['manage_tasks'],
  google_tasks: ['manage_google_tasks'],
  images: ['manage_images'],
  incidents: ['manage_incidents'],
  leads: ['manage_sales'],
  sales: ['manage_sales'],
  contacts: ['manage_contacts'],
  groups: ['manage_contact_groups'],
  notes: ['manage_notes'],
  meetings: ['get_meeting_recordings', 'view_calendar', 'meeting_minutes'],
  campaigns: ['manage_campaigns'],
};

const GENERAL_TOOLS = [
  'request_clarification', 'daily_briefing', 'view_dashboard',
  'manage_tasks', 'view_calendar', 'view_reminders',
  'manage_sales', 'manage_contacts', 'manage_follow_ups',
  'manage_team', 'check_team_availability',
  'meeting_minutes', 'personal_standup', 'manage_notes',
  'recall_memory', 'show_help', 'web_search', 'analyze_file',
];

// A bounded, balanced safety net for scripts not covered by the deterministic
// multilingual hints below. The model still has to choose a tool and every
// resulting call passes canonical validation/confirmation policy.
const NON_LATIN_FALLBACK_TOOLS = [
  'translate_text', 'set_reminder', 'create_calendar_event', 'send_email',
  'manage_tasks', 'manage_leave', 'save_memory', 'recall_memory',
  'manage_contacts', 'web_search', 'request_clarification',
];

// These are routing hints, not argument parsers. They keep the correct typed
// tool visible for common natural requests when embeddings are unavailable.
// Agno/OpenRouter still extracts and validates the actual arguments.
const MULTILINGUAL_TOOL_PATTERNS = [
  ['manage_leave', /(?:छुट्टी|अवकाश|إجازة|اجازة|permiso|vacaciones)/iu],
  ['translate_text', /(?:अनुवाद|ترجم|ترجمة|traduc(?:e|ir|ción|irlo))/iu],
  ['save_memory', /(?:याद\s+रख|याद\s+रखना|تذك[ّ]?ر|احفظ|recuerda\s+que|memoriza|guarda\s+que)/iu],
  ['recall_memory', /(?:क्या\s+याद|ماذا\s+تتذكر|qué\s+(?:recuerdas|sabes)\s+de\s+m[ií])/iu],
  ['set_reminder', /(?:याद\s+दिला|تذكير|ذكّرني|recuérdame|recordatorio)/iu],
  ['bulk_email', /\b(?:email|mail|send)\s+(?:all|every)\s+(?:these\s+)?(?:customers?|contacts?|clients?|people)\b/iu],
  ['bulk_email', /(?:सभी|सबको|todos)\b.{0,32}(?:ईमेल|correo|email)/iu],
  ['send_email', /(?:ईमेल\s+भेज|मेल\s+भेज|أرسل\s+(?:بريد|رسالة)|env[ií]a\s+(?:un\s+)?correo)/iu],
  ['create_calendar_event', /(?:बैठक|मुलाकात|اجتماع|موعد|reuni[oó]n|cita)/iu],
  ['manage_tasks', /(?:कार्य|काम|مهمة|مهام|tarea|tareas)/iu],
  ['manage_notes', /(?:नोट|ملاحظة|ملاحظات|nota|notas)/iu],
  ['manage_contacts', /(?:संपर्क|جهات?\s+الاتصال|contacto|contactos)/iu],
  ['web_search', /(?:वेब\s+पर\s+खोज|ابحث|buscar\s+en\s+(?:la\s+)?web)/iu],
  ['analyze_file', /(?:फ़ाइल|फाइल|ملف|archivo).{0,32}(?:पढ़|विश्लेष|حلل|اقرأ|analiza|lee)/iu],
];

const DOMAIN_PATTERNS = [
  ['sales', /\b(lead|pipeline|deal|opportunit|prospect|sales|crm)\b/i],
  ['calendar', /(?:\b(calendar|meeting|appointment|schedule|reschedule|event|invite|reuni[oó]n|cita)\b|बैठक|मुलाकात|اجتماع|موعد)/iu],
  ['email', /(?:\b(email|mail|inbox|reply|forward|recipient|correo)\b|ईमेल|بريد)/iu],
  ['team', /(?:\b(team|teammate|standup|poll|leave|member|delegate|equipo|permiso|vacaciones)\b|छुट्टी|अवकाश|فريق|إجازة|اجازة)/iu],
  ['task', /(?:\b(task|todo|to-do|assignment|sprint|project|tarea|tareas)\b|कार्य|काम|مهمة|مهام)/iu],
  ['reminder', /(?:\b(reminder|remind|alarm|notify me|recordatorio)\b|याद\s+दिला|تذكير|ذكّرني)/iu],
  ['contact', /(?:\b(contact|phone number|address book|customer|contacto|contactos)\b|संपर्क|جهات?\s+الاتصال)/iu],
  ['notes', /(?:\b(note|notes|checklist|knowledge base|reading list|nota|notas)\b|नोट|ملاحظة|ملاحظات)/iu],
  ['memory', /(?:\b(remember|memory|recall|memoriza)\b|याद\s+रख|تذك[ّ]?ر|احفظ|recuerda\s+que)/iu],
  ['google', /\b(drive|google doc|google sheet|folder)\b/i],
];

// Short natural-language aliases complement, rather than replace, the model.
// Their job is only to keep a likely atomic tool in the model's visible set
// when a user types informally, misspells a word, or mixes English/Hinglish.
const TOOL_ALIASES = {
  set_reminder: ['remind', 'reminder', 'alarm', 'alert', 'ping me', 'yaad dila'],
  update_reminder: ['move reminder', 'change reminder', 'snooze reminder'],
  cancel_reminder: ['cancel reminder', 'delete reminder', 'stop reminding'],
  complete_reminder: ['done', 'finished', 'completed', 'mark done', 'already did'],
  create_calendar_event: ['book meeting', 'arrange meeting', 'set up meeting', 'meeting rakh'],
  view_calendar: ['my calendar', 'my schedule', 'am i free', 'meetings today'],
  send_email: ['send email', 'write email', 'draft email', 'mail bhej'],
  bulk_email: ['email all', 'mail everyone', 'send to all customers', 'email these customers'],
  // "mark the report one as done" reached complete_reminder but not
  // manage_tasks, so the single most common write in the product was
  // unreachable from its most common phrasing. Completion words belong to BOTH
  // tools — offer both and let the model disambiguate from context.
  manage_tasks: ['task', 'todo', 'to do', 'kaam', 'mark done', 'tick off', 'get done', 'finish'],
  manage_sales: ['lead', 'deal', 'pipeline', 'crm', 'prospect'],
  manage_team_comms: ['broadcast', 'read receipt', '1:1', 'one on one', 'onboarding', 'invite link', 'team chat'],
  manage_contacts: ['contact', 'phone number', 'address book'],
  // "the investors list" is a contact GROUP, not a checklist. Without these
  // the message only matched manage_lists and the right tool never reached
  // the model's visible set.
  manage_contact_groups: ['group', 'add to group', 'remove from group', 'segment', 'audience', 'mailing list'],
  web_search: ['search web', 'look online', 'latest information', 'current news'],
  analyze_file: ['analyze file', 'read attachment', 'inspect document', 'review spreadsheet'],
  manage_leave: ['request leave', 'apply for leave', 'leave balance', 'chhutti'],
  translate_text: ['translate', 'say this in', 'convert language', 'अनुवाद', 'ترجمة'],
  save_memory: ['remember that', 'save this fact', 'recuerda que', 'याद रख'],
  recall_memory: ['what do you remember', 'recall my', 'क्या याद', 'qué recuerdas'],
};

const DOMAIN_ALIASES = {
  sales: ['lead', 'pipeline', 'deal', 'opportunity', 'prospect', 'sales', 'crm', 'campaign'],
  calendar: ['calendar', 'meeting', 'appointment', 'schedule', 'event', 'invite', 'mulaqat'],
  email: ['email', 'mail', 'inbox', 'reply', 'forward', 'recipient'],
  team: ['team', 'teammate', 'standup', 'poll', 'leave', 'member', 'delegate'],
  task: ['task', 'todo', 'assignment', 'sprint', 'project', 'kaam'],
  reminder: ['remind', 'reminder', 'alarm', 'notify', 'alert', 'yaad'],
  contact: ['contact', 'phone', 'address book', 'customer'],
  notes: ['note', 'checklist', 'knowledge base', 'reading list'],
  google: ['drive', 'google doc', 'google sheet', 'folder'],
  memory: ['remember', 'memory', 'recall', 'memoriza', 'yaad'],
};

function editDistance(left, right) {
  const a = Array.from(String(left || ''));
  const b = Array.from(String(right || ''));
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function tokenSimilarity(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (a === b) return 1;
  const leftLength = Array.from(a).length;
  const rightLength = Array.from(b).length;
  if (Math.min(leftLength, rightLength) < 4) return 0;
  return 1 - (editDistance(a, b) / Math.max(leftLength, rightLength));
}

function words(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
}

function multilingualToolNames(text) {
  const value = String(text || '');
  return MULTILINGUAL_TOOL_PATTERNS
    .filter(([, pattern]) => pattern.test(value))
    .map(([name]) => name);
}

function approximatelyMentions(text, aliases) {
  const lower = String(text || '').toLowerCase();
  const inputWords = words(lower);
  return (aliases || []).some((alias) => {
    const normalizedAlias = String(alias).toLowerCase();
    if (lower.includes(normalizedAlias)) return true;
    const aliasWords = words(normalizedAlias);
    return aliasWords.length === 1
      && inputWords.some((token) => tokenSimilarity(token, aliasWords[0]) >= 0.8);
  });
}

function inferredDomains(text) {
  const exact = DOMAIN_PATTERNS.filter(([, pattern]) => pattern.test(String(text || ''))).map(([domain]) => domain);
  for (const [domain, aliases] of Object.entries(DOMAIN_ALIASES)) {
    if (!exact.includes(domain) && approximatelyMentions(text, aliases)) exact.push(domain);
  }
  return exact;
}

function lexicalToolNames(message, tools) {
  const stopWords = new Set([
    'about', 'after', 'again', 'could', 'from', 'have', 'help', 'into', 'just',
    'like', 'need', 'please', 'that', 'this', 'what', 'when', 'where', 'which',
    'with', 'would', 'your', 'then', 'also',
  ]);
  const tokens = [...new Set(words(message))]
    .filter((token) => token.length > 2 && !stopWords.has(token));
  return tools.map((tool) => {
    const name = tool.name.toLowerCase().replace(/_/g, ' ');
    const description = String(tool.description || '').toLowerCase().slice(0, 1200);
    const searchableWords = [...new Set([
      ...words(name),
      ...words(description),
      ...words((TOOL_ALIASES[tool.name] || []).join(' ')),
    ])];
    let score = tokens.reduce((total, token) => total
      + (name.includes(token) ? 10 : 0)
      + (description.includes(token) ? 1 : 0), 0);
    for (const token of tokens) {
      const closest = searchableWords.reduce((best, candidate) => Math.max(best, tokenSimilarity(token, candidate)), 0);
      if (closest >= 0.8 && !name.includes(token)) score += 8;
    }
    if (approximatelyMentions(message, TOOL_ALIASES[tool.name])) score += 14;
    return { name: tool.name, score };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.name);
}

async function selectAriTools(userMessage, options = {}) {
  const allTools = options.allTools || listTools();
  const limit = Math.max(10, Math.min(40, Number(options.limit || process.env.ARI_AGENT_TOOL_LIMIT || 24)));
  const currentText = String(userMessage || '').trim();
  const recentText = Array.isArray(options.recentMessages)
    ? options.recentMessages.slice(-8).map((message) => message?.content || '').filter(Boolean).join('\n')
    : '';
  const selectionText = `${recentText}\n${currentText}`.trim();
  const ordered = [];
  const add = (names) => {
    for (const name of names || []) {
      if (name && !ordered.includes(name)) ordered.push(name);
    }
  };

  try {
    const {
      getExplicitToolHint,
      getToolsForCategory,
    } = require('./tool-definitions');
    const explicitHint = getExplicitToolHint(currentText, options.contextHints || {});
    const currentDomains = inferredDomains(currentText);
    const currentLexical = lexicalToolNames(currentText, allTools);
    const positional = options.contextHints?.positionalSelection;
    if (positional) add(POSITIONAL_LIST_TOOLS[positional.listType] || []);
    add([explicitHint]);
    add(multilingualToolNames(currentText));

    // Reserve one category-native tool for every domain explicitly requested
    // in this turn before expanding any single domain. This prevents a long
    // category (email/calendar) from consuming the cap ahead of a later one.
    for (const domain of currentDomains) {
      add(getToolsForCategory(domain, 1).map((entry) => entry.function?.name));
    }
    add(currentLexical);

    if (options.skipSemantic !== true) {
      try {
        const retrievalText = (explicitHint || currentDomains.length || currentLexical.length || !recentText)
          ? currentText
          : selectionText;
        const retrieved = await require('./tool-retriever.service').retrieve(retrievalText, { topK: 12 });
        add(retrieved?.tools?.map((entry) => entry.function?.name));
      } catch (_) {}
    }

    for (const domain of currentDomains) {
      add(getToolsForCategory(domain, 6).map((entry) => entry.function?.name));
    }

    if (/[^\u0000-\u007f]/.test(currentText)) add(NON_LATIN_FALLBACK_TOOLS);

    // Conversation history is useful for terse follow-ups, but it must never
    // crowd out a concrete signal from the fresh user turn.
    const historyDomains = inferredDomains(recentText).filter((domain) => !currentDomains.includes(domain));
    for (const domain of historyDomains) {
      add(getToolsForCategory(domain, 1).map((entry) => entry.function?.name));
    }
    add(lexicalToolNames(recentText, allTools));
    for (const domain of historyDomains) {
      add(getToolsForCategory(domain, 6).map((entry) => entry.function?.name));
    }
  } catch (_) {}

  // Preserve a useful lexical fallback even if the legacy definitions module
  // is unavailable, while retaining current-turn-before-history ordering.
  add(lexicalToolNames(currentText, allTools));
  if (/[^\u0000-\u007f]/.test(currentText)) add(NON_LATIN_FALLBACK_TOOLS);
  add(lexicalToolNames(recentText, allTools));
  add(GENERAL_TOOLS);

  const available = new Map(allTools.map((tool) => [tool.name, tool]));
  let selectedNames = ordered.filter((name) => available.has(name)).slice(0, limit);
  if (!selectedNames.includes('request_clarification')) {
    if (selectedNames.length >= limit) selectedNames = selectedNames.slice(0, -1);
    selectedNames.push('request_clarification');
  }
  return selectedNames.map((name) => available.get(name));
}

module.exports = {
  GENERAL_TOOLS,
  NON_LATIN_FALLBACK_TOOLS,
  approximatelyMentions,
  inferredDomains,
  lexicalToolNames,
  multilingualToolNames,
  selectAriTools,
};
