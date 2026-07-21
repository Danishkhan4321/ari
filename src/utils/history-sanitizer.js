'use strict';

/**
 * Strip "Example: …" / "Try: …" / "Like: …" / "For example: …" lines from
 * a single content string.
 *
 * These lines are produced by the assistant as UX hints to the *user* —
 * useful in the moment but actively harmful when fed back to the LLM as
 * conversation history. The LLM then splices fragments from those prior
 * Example lines into fresh clarification responses, producing the
 * `Remind Sneha: kainsl vn en too at 2:00 pm` hallucination class.
 *
 * The sanitizer is line-anchored (`^`) so it only strips lines that
 * START with the Example/Try/Like prefix — narrative mentions of
 * "example.com" or "for example, …" mid-sentence are preserved.
 *
 * @param {string} content
 * @returns {string}
 */
function stripExampleLines(content) {
  if (typeof content !== 'string' || content.length === 0) return content;

  // Line-anchored prefix match: leading whitespace + (Example|Try|Like|
  // For example) + ":" + rest of the line.
  // \s* allows leading indentation; case-insensitive; the trailing .*$ in
  // multi-line mode eats the rest of that line only.
  const stripped = content
    .split('\n')
    .filter(line => !/^\s*(?:example|try|like|for\s+example)\s*:/i.test(line))
    .join('\n');

  // Collapse any 3+ consecutive newlines that may result from a stripped
  // line sandwiched between blanks.
  return stripped.replace(/\n{3,}/g, '\n\n');
}

/**
 * Sanitize the conversation history that's about to be handed to the LLM.
 *
 * Rule: only `assistant` turns are modified — and only their Example/Try
 * lines are removed. User turns are NEVER altered (corrupting user
 * content would defeat the purpose of having history). System turns are
 * passed through unchanged so summarization still works.
 *
 * Pure function — returns a new array of new message objects; the input
 * array and its objects are not mutated.
 *
 * @param {Array<{role: string, content: string}>|null|undefined} messages
 * @returns {Array<{role: string, content: string}>}
 */
function sanitizeAssistantHistoryForLLM(messages) {
  if (!Array.isArray(messages)) return [];

  return messages.map(m => {
    if (!m || m.role !== 'assistant') return m;
    if (typeof m.content !== 'string' || m.content.length === 0) return m;
    return { ...m, content: stripExampleLines(m.content) };
  });
}

module.exports = {
  stripExampleLines,
  sanitizeAssistantHistoryForLLM,
};
