'use strict';

const { z } = require('zod');
const defaultLlm = require('../llm-provider');

const speakerIdSchema = z.string()
  .regex(/^[A-Z]+$/, 'Unknown speaker ID; expected a canonical uppercase ID')
  .nullable();
const reportSchema = z.object({
  summary: z.string().trim().min(1).max(12_000),
  decisions: z.array(z.string().trim().min(1).max(2_000)).max(100),
  actionItems: z.array(z.object({
    text: z.string().trim().min(1).max(2_000),
    assigneeSpeakerId: speakerIdSchema,
    deadline: z.string().trim().min(1).max(300).nullable(),
  }).strict()).max(100),
  suggestedTasks: z.array(z.object({
    title: z.string().trim().min(1).max(500),
    suggestedAssigneeSpeakerId: speakerIdSchema,
    reason: z.string().trim().min(1).max(2_000),
  }).strict()).max(100),
  topics: z.array(z.string().trim().min(1).max(300)).max(100),
  openQuestions: z.array(z.string().trim().min(1).max(2_000)).max(100),
  reportMarkdown: z.string().trim().min(1).max(100_000).superRefine((markdown, context) => {
    const requiredSections = [
      ['overview', /(^|\n)#{1,6}\s+overview\b/i],
      ['decisions', /(^|\n)#{1,6}\s+decisions\b/i],
      ['action items', /(^|\n)#{1,6}\s+action items\b/i],
      ['suggested tasks and assignees', /(^|\n)#{1,6}\s+suggested tasks(?: and|\s*&)? assignees\b/i],
      ['open questions', /(^|\n)#{1,6}\s+open questions\b/i],
      ['transcript notes', /(^|\n)#{1,6}\s+transcript notes\b/i],
    ];
    for (const [name, pattern] of requiredSections) {
      if (!pattern.test(markdown)) {
        context.addIssue({ code: 'custom', message: `reportMarkdown is missing the ${name} section` });
      }
    }
  }),
}).strict();

function parseJsonObject(content) {
  const source = String(content || '').trim();
  const unfenced = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch (_) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Model did not return a JSON object');
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

function responseContent(response) {
  if (typeof response === 'string') return response;
  return response?.data?.choices?.[0]?.message?.content
    || response?.choices?.[0]?.message?.content
    || response?.content
    || '';
}

function validateSpeakerReferences(report, allowedSpeakerIds) {
  const allowed = new Set(allowedSpeakerIds);
  const references = [
    ...report.actionItems.map((item) => item.assigneeSpeakerId),
    ...report.suggestedTasks.map((task) => task.suggestedAssigneeSpeakerId),
  ].filter(Boolean);
  for (const speakerId of references) {
    if (!allowed.has(speakerId)) throw new Error(`Unknown speaker ID in report: ${speakerId}`);
  }

  const canonicalTokens = JSON.stringify(report).match(/Speaker\s+([A-Z]+)/g) || [];
  for (const token of canonicalTokens) {
    const id = token.replace(/^Speaker\s+/, '');
    if (!allowed.has(id)) throw new Error(`Unknown speaker ID in report: ${id}`);
  }
}

function createReportGenerator({ llm = defaultLlm } = {}) {
  if (!llm || typeof llm.chatCompletion !== 'function') {
    throw new TypeError('llm.chatCompletion is required');
  }

  async function generate({ title, transcriptSegments }) {
    const segments = Array.isArray(transcriptSegments) ? transcriptSegments : [];
    if (!segments.length) throw new TypeError('At least one transcript segment is required');
    const allowedSpeakerIds = [...new Set(segments.map((segment) => String(segment.speakerId || '').trim()))];
    if (allowedSpeakerIds.some((id) => !/^[A-Z]+$/.test(id))) {
      throw new TypeError('Transcript contains an invalid speaker ID');
    }
    const transcript = segments.map((segment) => `Speaker ${segment.speakerId}: ${segment.text}`).join('\n');
    const schemaDescription = {
      summary: 'string',
      decisions: ['string'],
      actionItems: [{ text: 'string', assigneeSpeakerId: 'A or null', deadline: 'string or null' }],
      suggestedTasks: [{ title: 'string', suggestedAssigneeSpeakerId: 'A or null', reason: 'string' }],
      topics: ['string'],
      openQuestions: ['string'],
      reportMarkdown: 'complete Markdown report',
    };
    const system = [
      'Generate a complete, evidence-based meeting report as one JSON object.',
      `Use only these speaker tokens: ${allowedSpeakerIds.map((id) => `Speaker ${id}`).join(', ')}.`,
      'Never infer or invent personal names. Preserve canonical speaker IDs in assignee fields.',
      'Suggested tasks are proposals only; do not claim they were created or assigned.',
      'The Markdown report must contain headings for Overview, Decisions, Action items, Suggested tasks and assignees, Open questions, and Transcript notes.',
      `Return exactly this JSON shape with no extra keys: ${JSON.stringify(schemaDescription)}`,
    ].join(' ');
    let feedback = '';
    let finalError;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await llm.chatCompletion({
        model: typeof llm.fastModel === 'function' ? llm.fastModel() : undefined,
        temperature: 0,
        max_tokens: 8_000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${feedback}${feedback ? '\n\n' : ''}Meeting title: ${String(title || 'Untitled Meeting').slice(0, 500)}\n\nTranscript:\n${transcript}` },
        ],
      }, { task: 'meeting_report', timeout: 60_000 });
      try {
        const parsed = reportSchema.parse(parseJsonObject(responseContent(response)));
        validateSpeakerReferences(parsed, allowedSpeakerIds);
        return parsed;
      } catch (error) {
        finalError = error;
        const details = error?.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
          || error.message;
        feedback = `Your previous JSON failed validation: ${details}. Return a corrected complete JSON object.`;
      }
    }
    throw finalError;
  }

  return { generate };
}

module.exports = { createReportGenerator, reportSchema, parseJsonObject };
