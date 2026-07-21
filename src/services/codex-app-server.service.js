'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const preferencesService = require('./desktop-ai-preferences.service');
const llm = require('./llm-provider');
const { AriResponsesGateway } = require('./ari-responses-gateway.service');
const {
  BASE_INSTRUCTIONS,
  DEVELOPER_INSTRUCTIONS,
  buildRuntimeContext,
  isolationConfig,
} = require('./ari-agent-policy.service');
const { callTool, listTools } = require('../mcp/desktop-tool-registry');
const { currentChatSession, runWithChatSession } = require('./chat-session-context');
const { normalizeToolResult } = require('./tool-result.service');

// check_inbox is intentionally NOT listed: it is in DISABLED_GOOGLE_TOOLS
// (tool-definitions.js) and filtered out of getToolDefinitions(), so listing
// it here would advertise a capability no runtime can execute.
const CORE_TOOLS = new Set([
  'view_reminders',
  'set_reminder',
  'manage_tasks',
  'manage_sales',
  'manage_contacts',
  'manage_contact_groups',
  'analyze_file',
  'view_calendar',
  'create_calendar_event',
  'manage_team',
  'daily_briefing',
  'view_dashboard',
  'delegate_message',
  'request_clarification',
]);

const GENERAL_ARI_TOOLS = [
  'request_clarification', 'daily_briefing', 'view_dashboard',
  'manage_tasks', 'view_calendar', 'view_reminders',
  'manage_sales', 'manage_contacts', 'manage_contact_groups',
  'manage_follow_ups', 'analyze_file',
  'manage_team', 'check_team_availability',
  'meeting_minutes', 'personal_standup', 'manage_notes',
  'recall_memory', 'show_help', 'web_search',
];

const MODEL_OPTIONS = {
  auto: {},
  sol: { model: 'gpt-5.6-sol', effort: 'medium' },
  terra: { model: 'gpt-5.6-terra', effort: 'medium' },
  luna: { model: 'gpt-5.6-luna', effort: 'low' },
};

function targetTriple(platform = process.platform, arch = process.arch) {
  return {
    'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
    'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
    'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex'],
    'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'],
  }[`${platform}:${arch}`] || null;
}

function resolveBundledCodex(repoRoot = path.resolve(__dirname, '..', '..'), options = {}) {
  const target = targetTriple(options.platform, options.arch);
  if (!target) throw new Error(`Codex App Server is not available for ${options.platform || process.platform}/${options.arch || process.arch}.`);
  const [packageName, triple, executable] = target;
  const packageJson = require.resolve(`${packageName}/package.json`, { paths: [repoRoot] });
  const binary = path.join(path.dirname(packageJson), 'vendor', triple, 'bin', executable);
  if (!fs.existsSync(binary)) throw new Error('The bundled Codex App Server runtime is missing.');
  return binary;
}

function childEnvironment() {
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'ComSpec', 'HOME', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  ];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = String(process.env[key]);
  env.CODEX_HOME = process.env.ARI_CODEX_HOME || process.env.CODEX_HOME || '';
  return env;
}

function dynamicToolSpecs(options = {}) {
  const tools = Array.isArray(options.tools) ? options.tools : listTools();
  const deferExtended = options.deferExtended !== false;
  if (!deferExtended) {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      deferLoading: false,
    }));
  }
  // Tools named by the current turn's context (an attachment hint, an explicit
  // router hint) must be immediately visible: the system prompt orders the
  // model to call them, so hiding them behind the deferred namespace makes the
  // model conclude the capability does not exist (the attached-Excel failure).
  const promoted = new Set(CORE_TOOLS);
  for (const name of options.promoteNames || []) if (name) promoted.add(name);
  const core = tools.filter((tool) => promoted.has(tool.name)).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    deferLoading: false,
  }));
  const extended = tools.filter((tool) => !promoted.has(tool.name)).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    deferLoading: true,
  }));
  return [
    ...core,
    {
      type: 'namespace',
      name: 'ari_extended',
      description: 'Additional Ari business actions for CRM, team operations, meetings, inbox, productivity, research, documents, and connected services. Search this namespace when the common Ari tools do not cover the request.',
      tools: extended,
    },
  ];
}

function safeJson(value, maxLength = 60_000) {
  let serialized;
  try {
    serialized = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
  } catch {
    serialized = JSON.stringify({
      status: 'failure',
      summary: 'Ari could not serialize this tool result.',
      next_actions: ['Stop and explain that the result could not be read.'],
      artifacts: [],
      data: null,
      error: { code: 'result_serialization_error', retryable: false },
    });
  }
  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength)}\n[Result truncated by Ari]`
    : serialized;
}

function normalizeUsage(tokenUsage) {
  const source = tokenUsage?.last || tokenUsage;
  if (!source || typeof source !== 'object') return null;
  const read = (key) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  };
  const inputTokens = read('inputTokens');
  const cachedInputTokens = read('cachedInputTokens');
  const outputTokens = read('outputTokens');
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningOutputTokens: read('reasoningOutputTokens'),
    totalTokens: read('totalTokens') || inputTokens + outputTokens,
    scope: 'turn',
  };
}

function applicationToolCallLimit(value = process.env.ARI_AGENT_MAX_TOOL_CALLS) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : 12;
}

function codexTurnTimeoutMs(value = process.env.ARI_CODEX_TURN_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 30_000 && parsed <= 900_000
    ? parsed
    : 300_000;
}

function capacityContinuationLimit(value = process.env.ARI_AGENT_MAX_CONTINUATIONS) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10 ? parsed : 3;
}

function isRecoverableCapacityOutcome(outcome) {
  if (outcome?.status !== 'partial' || !Array.isArray(outcome.toolResults)) return false;
  const unsuccessful = outcome.toolResults.filter((result) => result?.status !== 'success');
  const codes = unsuccessful.map((result) => String(result?.error?.code || ''));
  return codes.includes('agent_tool_limit_reached')
    && codes.every((code) => code === 'agent_tool_limit_reached' || code === 'tool_blocked_capacity');
}

function continuationPrompt(segment, continuationNumber) {
  const completed = (segment?.toolResults || []).filter((result) => result?.status === 'success').length;
  return [
    `Continue the same request from the verified checkpoint after capacity segment ${continuationNumber}.`,
    `${completed} business-tool call(s) completed successfully in the immediately preceding segment.`,
    'Their results are already present in this thread. Do not repeat completed work.',
    'Inspect the prior tool results, continue only the unfinished items, and finish with an exact success/partial/failure report.',
  ].join(' ');
}

function aggregateCapacitySegments(segments) {
  const list = Array.isArray(segments) ? segments.filter(Boolean) : [];
  const final = list[list.length - 1] || {};
  const toolsUsed = [];
  for (const segment of list) {
    for (const tool of segment.toolsUsed || []) {
      if (!toolsUsed.includes(tool)) toolsUsed.push(tool);
    }
  }
  const usageKeys = [
    'inputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'outputTokens',
    'reasoningOutputTokens', 'totalTokens',
  ];
  const usage = list.some((segment) => segment.usage)
    ? Object.fromEntries(usageKeys.map((key) => [
      key,
      list.reduce((total, segment) => total + Number(segment.usage?.[key] || 0), 0),
    ]))
    : null;
  if (usage) usage.scope = 'capacity_continuation';
  return {
    ...final,
    steps: list.reduce((total, segment) => total + Number(segment.steps || 0), 0),
    latencyMs: list.reduce((total, segment) => total + Number(segment.latencyMs || 0), 0),
    toolsUsed,
    toolResults: list.flatMap((segment) => segment.toolResults || []),
    ...(usage ? { usage } : {}),
    meta: {
      ...(final.meta || {}),
      continuationCount: Math.max(0, list.length - 1),
      segmentCount: list.length,
    },
  };
}

async function runCapacityContinuationLoop({
  initialInput,
  runSegment,
  maxContinuations = capacityContinuationLimit(),
  onContinue = async () => {},
}) {
  if (typeof runSegment !== 'function') throw new TypeError('runSegment must be a function.');
  const segments = [];
  let input = initialInput;
  while (true) {
    const segment = await runSegment(input, { segmentIndex: segments.length });
    segments.push(segment);
    if (!isRecoverableCapacityOutcome(segment) || segments.length > maxContinuations) break;
    const nextInput = continuationPrompt(segment, segments.length);
    await onContinue({
      continuationCount: segments.length,
      maxContinuations,
      segment,
      nextInput,
    });
    input = nextInput;
  }
  return aggregateCapacitySegments(segments);
}

function normalizeApplicationToolResult(value, toolName) {
  let source = value;
  if (value && typeof value === 'object') {
    if (value.status === 'waiting_for_user') source = { ...value, status: 'waiting_input' };
    if (value.status === 'unknown') {
      source = {
        ...value,
        status: 'partial',
        error: {
          code: value.error?.code || 'tool_outcome_unknown',
          category: 'unknown_outcome',
          retryable: false,
          message: value.error?.message || value.summary || 'The tool outcome could not be verified.',
        },
      };
    }
    source = {
      ...source,
      user_summary: source.user_summary || source.summary || source.result || '',
      evidence: source.evidence || source.artifacts || [],
    };
  }
  return normalizeToolResult(source, { toolName });
}

function isWaitingToolResult(result) {
  return ['waiting_approval', 'waiting_input', 'waiting_for_user'].includes(result?.status);
}

function isUnknownToolOutcome(result) {
  const code = String(result?.error?.code || '');
  return result?.error?.category === 'unknown_outcome'
    || /(?:unknown[_-]outcome|outcome[_-]unknown)/i.test(code);
}

function deriveAppServerOutcome(toolResults, modelText = '') {
  const results = Array.isArray(toolResults) ? toolResults : [];
  const waiting = [...results].reverse().find(isWaitingToolResult);
  const succeeded = results.filter((result) => result.status === 'success');
  const failed = results.filter((result) => result.status === 'failure');
  const partial = results.filter((result) => result.status === 'partial' || isUnknownToolOutcome(result));

  let status = 'completed';
  if (waiting) status = waiting.status === 'waiting_approval' ? 'waiting_for_approval' : 'waiting_for_user';
  else if (partial.length > 0 || (succeeded.length > 0 && failed.length > 0)) status = 'partial';
  else if (failed.length > 0) status = 'failed';

  if (status === 'completed') return { status, text: String(modelText || ''), waiting: null };
  if (status === 'waiting_for_approval' || status === 'waiting_for_user') {
    return {
      status,
      text: waiting.user_summary || 'I need your approval or one more detail before I can continue.',
      waiting,
    };
  }

  const completedSummaries = succeeded.map((result) => result.user_summary).filter(Boolean);
  const blockedSummaries = [...new Set(
    [...partial, ...failed].map((result) => result.user_summary || result.error?.message).filter(Boolean),
  )];
  if (status === 'partial') {
    const completedText = completedSummaries.length > 0
      ? ` Completed: ${completedSummaries.join(' ')}`
      : '';
    const blockedText = blockedSummaries.length > 0
      ? ` Not completed or not verified: ${blockedSummaries.join(' ')}`
      : '';
    return {
      status,
      text: `I could only complete part of this request.${completedText}${blockedText}`.trim(),
      waiting: null,
    };
  }
  return {
    status,
    text: `I could not complete this request.${blockedSummaries.length > 0 ? ` ${blockedSummaries.join(' ')}` : ''}`.trim(),
    waiting: null,
  };
}

function interruptedRunCheckpoint(state, error) {
  const completed = Array.isArray(state?.toolResults) ? state.toolResults : [];
  if (completed.length === 0) return null;
  const unknownInFlight = Boolean(state.activeToolCalls > 0 || state.abortDuringTool)
    || completed.some(isUnknownToolOutcome);
  const interruption = normalizeApplicationToolResult({
    status: unknownInFlight ? 'partial' : 'failure',
    error: {
      code: unknownInFlight
        ? 'agent_interrupted_unknown_outcome'
        : 'agent_interrupted_after_checkpoint',
      category: unknownInFlight ? 'unknown_outcome' : 'interruption',
      retryable: !unknownInFlight,
      message: unknownInFlight
        ? 'The provider stopped while an Ari action was in progress, so its final effect is unknown.'
        : 'The provider stopped after the recorded Ari actions completed.',
    },
    summary: unknownInFlight
      ? 'An in-flight Ari action may have an unknown outcome; it was not replayed.'
      : 'The remaining work was interrupted after the recorded checkpoint and was not replayed.',
  }, 'agent_runtime');
  const toolResults = [...completed, interruption];
  const derived = deriveAppServerOutcome(toolResults, state.response);
  return {
    status: 'partial',
    errorCode: String(error?.code || 'codex_app_server_interrupted'),
    text: derived.text,
    steps: state.steps,
    toolsUsed: [...(state.toolsUsed || [])],
    toolResults,
    usage: state.usage,
    contextUsage: state.contextUsage,
    finalModel: state.finalModel,
    latencyMs: Date.now() - state.startedAt,
    engine: state.engine,
    meta: {
      safeToResumeAfterInterruption: !unknownInFlight,
      interruptionCode: String(error?.code || 'codex_app_server_interrupted'),
    },
  };
}

function blockedToolResult(toolName, terminalResult) {
  const waiting = isWaitingToolResult(terminalResult);
  const capacity = terminalResult?.error?.code === 'agent_tool_limit_reached'
    || terminalResult?.error?.code === 'tool_blocked_capacity';
  return normalizeApplicationToolResult({
    status: 'failure',
    error: {
      code: waiting
        ? 'tool_blocked_pending_user'
        : (capacity ? 'tool_blocked_capacity' : 'tool_blocked_terminal_outcome'),
      category: capacity ? 'limit' : 'safety',
      retryable: capacity,
      message: waiting
        ? 'A previous action is waiting for the user, so this queued tool was not executed.'
        : (capacity
          ? 'The previous action reached this turn\'s tool capacity, so this queued tool will continue in the next segment.'
          : 'A previous action has an unknown outcome, so this queued tool was not executed.'),
    },
    summary: waiting
      ? `${toolName} was not executed because an earlier action is waiting for you.`
      : (capacity
        ? `${toolName} was queued for the next segment after this turn reached its tool safety limit.`
        : `${toolName} was not executed because an earlier action has an unknown outcome.`),
  }, toolName);
}

function toolLimitResult(toolName, limit) {
  return normalizeApplicationToolResult({
    status: 'failure',
    error: {
      code: 'agent_tool_limit_reached',
      category: 'limit',
      retryable: false,
      message: `The turn reached its limit of ${limit} Ari tool calls.`,
    },
    summary: `${toolName} was not executed because this turn reached its ${limit}-tool safety limit.`,
  }, toolName);
}

function itemActivity(method, item, step) {
  if (!item) return null;
  const started = method === 'item/started';
  if (item.type === 'dynamicToolCall' || item.type === 'mcpToolCall') {
    const failed = !started && item.status === 'failed';
    return {
      type: started ? 'tool.started' : (failed ? 'tool.failed' : 'tool.succeeded'),
      step,
      toolName: item.tool,
      summary: started ? `Using ${item.tool}` : (failed ? `${item.tool} failed` : `${item.tool} completed`),
      payload: failed ? { retryable: false } : {},
    };
  }
  if (!started && item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.join(' ') : '';
    if (summary) return { type: 'run.progress', step, summary: summary.slice(0, 300) };
  }
  if (!started && item.type === 'plan' && item.text) {
    return { type: 'run.progress', step, summary: String(item.text).slice(0, 300) };
  }
  if (item.type === 'webSearch') {
    return {
      type: started ? 'tool.started' : 'tool.succeeded',
      step,
      toolName: 'web_search',
      summary: started ? 'Researching the request' : 'Research completed',
      payload: {},
    };
  }
  return null;
}

class CodexAppServerError extends Error {
  constructor(message, toolCallsAttempted = 0, code = 'codex_app_server_error') {
    super(message);
    this.name = 'CodexRunError';
    this.toolCallsAttempted = toolCallsAttempted;
    this.code = code;
  }
}

class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binary = options.binary || resolveBundledCodex(options.repoRoot);
    this.cwd = options.cwd || process.env.ARI_CODEX_WORKSPACE || path.join(process.cwd(), '.ari-codex-workspace');
    this.env = options.env || childEnvironment();
    this.spawnFn = options.spawnFn || spawn;
    this.requestTimeoutMs = options.requestTimeoutMs || 30_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? codexTurnTimeoutMs();
    this.maxToolCalls = applicationToolCallLimit(options.maxToolCalls);
    this.toolExecutor = options.toolExecutor || callTool;
    this.child = null;
    this.reader = null;
    this.ready = false;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.runs = new Map();
  }

  async start() {
    if (this.ready && this.child && !this.child.killed) return this;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    fs.mkdirSync(this.cwd, { recursive: true });
    const child = this.spawnFn(this.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this._handleLine(line));
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message && !/token|credential|auth\.json/i.test(message)) this.emit('diagnostic', message.slice(0, 500));
    });
    child.once('error', (error) => this._handleExit(error));
    child.once('exit', (code) => this._handleExit(new Error(`Codex App Server exited with code ${code}.`)));
    await this._requestRaw('initialize', {
      clientInfo: { name: 'ari-desktop', title: 'Ari', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    }, 20_000);
    this.ready = true;
    return this;
  }

  _handleExit(error) {
    if (!this.child && !this.ready) return;
    this.ready = false;
    this.child = null;
    this.reader?.close();
    this.reader = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const state of this.runs.values()) this._rejectRun(state, error);
    this.runs.clear();
    this.emit('exit', error);
  }

  _write(message) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server is not writable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _requestRaw(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params, timeoutMs) {
    await this.start();
    return this._requestRaw(method, params, timeoutMs);
  }

  _handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method} failed: ${message.error.message || 'unknown error'}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this._handleServerRequest(message);
      return;
    }
    if (message.method) this._handleNotification(message);
  }

  async _handleServerRequest(message) {
    try {
      const { method, params } = message;
      let result;
      if (method === 'item/tool/call') {
        const state = this.runs.get(params.threadId);
        if (!state) throw new Error('No active Ari turn owns this tool call.');
        if (state.cancelled || state.signal?.aborted) {
          throw new CodexAppServerError(
            'The Ari turn was cancelled before this tool could start.',
            state.toolCallsAttempted,
            'agent_cancelled',
          );
        }
        state.toolExecutionTail ||= Promise.resolve();
        state.toolResults ||= [];
        state.acceptedToolCalls ||= 0;
        state.maxToolCalls ||= this.maxToolCalls;
        const execution = state.toolExecutionTail.then(async () => {
          if (state.cancelled || state.signal?.aborted) {
            throw new CodexAppServerError(
              'The Ari turn was cancelled before this tool could start.',
              state.toolCallsAttempted,
              'agent_cancelled',
            );
          }

          let normalized;
          if (state.terminalToolResult) {
            normalized = blockedToolResult(params.tool, state.terminalToolResult);
          } else if (state.acceptedToolCalls >= state.maxToolCalls) {
            normalized = toolLimitResult(params.tool, state.maxToolCalls);
            state.terminalToolResult = normalized;
          } else {
            state.acceptedToolCalls += 1;
            state.toolCallsAttempted = state.acceptedToolCalls;
            if (!state.toolsUsed.includes(params.tool)) state.toolsUsed.push(params.tool);
            state.activeToolCalls += 1;
            let raw;
            try {
              raw = await runWithChatSession(state.chatSession, () =>
                this.toolExecutor(state.userPhone, params.tool, params.arguments || {}, { signal: state.signal }));
            } catch (error) {
              if (error?.code === 'agent_cancelled' || error?.code === 'agent_cancelled_partial') throw error;
              raw = {
                status: 'failure',
                summary: `${params.tool} stopped: ${String(error?.message || 'unknown error').slice(0, 300)}`,
                error: {
                  code: error?.code || 'tool_execution_error',
                  category: error?.category || 'execution',
                  retryable: error?.retryable === true,
                  message: String(error?.message || 'Tool execution failed.'),
                },
              };
            } finally {
              state.activeToolCalls = Math.max(0, state.activeToolCalls - 1);
              this._settleCancelledRun(state);
            }
            normalized = normalizeApplicationToolResult(raw, params.tool);
            if (isWaitingToolResult(normalized) || isUnknownToolOutcome(normalized)) {
              state.terminalToolResult = normalized;
            }
          }

          state.toolResults.push(normalized);
          if (isWaitingToolResult(normalized)) {
            state.waitingStatus = normalized.status === 'waiting_approval'
              ? 'waiting_for_approval' : 'waiting_for_user';
            this._queueEvent(state, {
              type: 'run.progress',
              step: state.steps,
              summary: String(normalized.user_summary || 'Waiting for your response').slice(0, 300),
              payload: { status: state.waitingStatus, tool: params.tool },
            });
          }
          return {
            contentItems: [{ type: 'inputText', text: safeJson(normalized) }],
            success: normalized.status === 'success',
          };
        });
        state.toolExecutionTail = execution.catch(() => {});
        result = await execution;
      } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        result = { decision: 'decline' };
      } else if (method === 'item/permissions/requestApproval') {
        result = { permissions: {}, scope: 'turn', strictAutoReview: true };
      } else if (method === 'item/tool/requestUserInput') {
        result = { answers: {} };
      } else if (method === 'currentTime/read') {
        result = { currentTimeAt: Math.floor(Date.now() / 1000) };
      } else {
        throw new Error(`Ari does not support the Codex request ${method}.`);
      }
      this._write({ id: message.id, result });
    } catch (error) {
      this._write({ id: message.id, error: { code: -32000, message: String(error.message || error).slice(0, 300) } });
    }
  }

  _handleNotification(message) {
    this.emit('notification', message);
    const params = message.params || {};
    const state = params.threadId ? this.runs.get(params.threadId) : null;
    if (!state) return;
    if (params.turnId && state.turnId && params.turnId !== state.turnId) return;
    if (state.cancelled && (message.method === 'turn/completed' || message.method === 'error')) {
      this._settleCancelledRun(state);
      return;
    }
    if (message.method === 'turn/started') state.turnId = params.turn?.id || state.turnId;
    if (message.method === 'thread/tokenUsage/updated') {
      state.usage = normalizeUsage(params.tokenUsage);
      state.contextUsage = params.tokenUsage;
      return;
    }
    if (message.method === 'model/rerouted') {
      state.finalModel = params.toModel ? `codex:${params.toModel}` : state.finalModel;
      this._queueEvent(state, {
        type: 'run.progress', step: state.steps,
        summary: `Codex selected ${state.finalModel} for this request`,
        payload: { fromModel: params.fromModel, toModel: params.toModel },
      });
      return;
    }
    if (message.method === 'turn/plan/updated') {
      const active = Array.isArray(params.plan) ? params.plan.find((item) => item.status === 'inProgress') : null;
      const summary = active?.step || params.explanation;
      if (summary) this._queueEvent(state, { type: 'run.progress', step: state.steps, summary: String(summary).slice(0, 300) });
      return;
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item;
      if (message.method === 'item/started') state.steps += 1;
      if (message.method === 'item/started' && (item?.type === 'dynamicToolCall' || item?.type === 'mcpToolCall')) {
        if (!state.toolsUsed.includes(item.tool)) state.toolsUsed.push(item.tool);
      }
      if (message.method === 'item/completed' && item?.type === 'agentMessage') state.response = item.text || state.response;
      const activity = itemActivity(message.method, item, state.steps);
      if (activity) this._queueEvent(state, activity);
      return;
    }
    if (message.method === 'error' && params.willRetry !== true) {
      this._rejectRun(state, new Error(params.error?.message || 'Codex App Server turn failed.'));
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = params.turn || {};
      if (turn.status === 'failed') {
        this._rejectRun(state, new Error(turn.error?.message || 'Codex App Server turn failed.'));
      } else if (turn.status === 'interrupted') {
        this._rejectRun(state, new Error('Codex App Server turn was interrupted.'));
      } else {
        this._resolveRun(state);
      }
    }
  }

  _queueEvent(state, event) {
    state.eventQueue = state.eventQueue.then(() => state.onEvent(event)).catch(() => {});
  }

  async _resolveRun(state) {
    if (state.settled || state.resolving) return;
    state.resolving = true;
    await state.toolExecutionTail.catch(() => {});
    if (state.settled) return;
    if (state.cancelled) {
      this._settleCancelledRun(state);
      return;
    }
    state.settled = true;
    clearTimeout(state.timer);
    await state.eventQueue;
    const outcome = deriveAppServerOutcome(state.toolResults, state.response);
    const { status } = outcome;
    const eventType = status === 'completed' ? 'run.completed'
      : status === 'partial' ? 'run.partial'
        : status === 'failed' ? 'run.failed'
          : status === 'waiting_for_approval' ? 'run.waiting_for_approval' : 'run.waiting_for_user';
    await state.onEvent({
      type: eventType,
      step: state.steps,
      summary: status === 'completed' ? 'Ari completed the request' : outcome.text.slice(0, 300),
      payload: { status },
    }).catch(() => {});
    state.resolve({
      text: outcome.text,
      status,
      steps: state.steps,
      toolsUsed: state.toolsUsed,
      toolResults: state.toolResults,
      usage: state.usage,
      contextUsage: state.contextUsage,
      finalModel: state.finalModel,
      latencyMs: Date.now() - state.startedAt,
      engine: state.engine,
    });
  }

  _rejectRun(state, error) {
    if (state.settled) return;
    state.settled = true;
    clearTimeout(state.timer);
    const wrapped = new CodexAppServerError(
      error?.message || 'Codex App Server stopped unexpectedly.',
      state.toolCallsAttempted,
      error?.code || 'codex_app_server_error',
    );
    const checkpoint = interruptedRunCheckpoint(state, wrapped);
    if (checkpoint) wrapped.partialOutcome = checkpoint;
    state.reject(wrapped);
  }

  _settleCancelledRun(state) {
    if (!state.cancelled || state.settled || state.activeToolCalls > 0) return;
    clearTimeout(state.cancelDrainTimer);
    const partial = state.abortDuringTool === true;
    this._rejectRun(state, new CodexAppServerError(
      partial
        ? 'The Codex turn was interrupted while a business tool was running; its outcome may be partial or unknown.'
        : 'The Codex App Server turn was cancelled.',
      state.toolCallsAttempted,
      partial ? 'agent_cancelled_partial' : 'agent_cancelled',
    ));
  }

  async runTurn({ threadId, input, userPhone, chatSession = null, onEvent, finalModel, engine = 'app-server:codex', turnOptions = {}, signal = null }) {
    await this.start();
    if (signal?.aborted) {
      throw new CodexAppServerError('The Codex App Server turn was cancelled.', 0, 'agent_cancelled');
    }
    if (this.runs.has(threadId)) throw new CodexAppServerError('This Ari conversation already has an active Codex turn.');
    let resolveRun;
    let rejectRun;
    const promise = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    const state = {
      threadId,
      turnId: null,
      userPhone: String(userPhone),
      chatSession: chatSession?.sessionId ? {
        sessionId: String(chatSession.sessionId),
        clientMessageId: chatSession.clientMessageId ? String(chatSession.clientMessageId) : null,
        runId: chatSession.runId ? String(chatSession.runId) : null,
        userPhone: String(userPhone),
        signal,
      } : null,
      onEvent: onEvent || (async () => {}),
      eventQueue: Promise.resolve(),
      response: '',
      steps: 0,
      toolsUsed: [],
      toolResults: [],
      toolCallsAttempted: 0,
      acceptedToolCalls: 0,
      maxToolCalls: this.maxToolCalls,
      terminalToolResult: null,
      toolExecutionTail: Promise.resolve(),
      usage: null,
      contextUsage: null,
      finalModel,
      engine,
      startedAt: Date.now(),
      settled: false,
      resolving: false,
      resolve: resolveRun,
      reject: rejectRun,
      timer: null,
      signal,
      cancelled: false,
      abortCleanup: null,
      activeToolCalls: 0,
      abortDuringTool: false,
      cancelDrainTimer: null,
    };
    const interrupt = () => {
      if (!state.turnId) return;
      void this._requestRaw('turn/interrupt', { threadId, turnId: state.turnId }).catch(() => {});
    };
    const onAbort = () => {
      state.cancelled = true;
      state.abortDuringTool = state.abortDuringTool || state.activeToolCalls > 0;
      clearTimeout(state.timer);
      interrupt();
      if (state.activeToolCalls > 0 && !state.cancelDrainTimer) {
        const drainMs = Math.max(250, Number(process.env.ARI_CODEX_CANCEL_DRAIN_MS || 2000));
        state.cancelDrainTimer = setTimeout(() => {
          if (!state.settled) this._rejectRun(state, new CodexAppServerError(
            'The Codex turn was interrupted while a business tool was still running; its outcome is unknown.',
            state.toolCallsAttempted,
            'agent_cancelled_partial',
          ));
        }, drainMs);
      }
      this._settleCancelledRun(state);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      state.abortCleanup = () => signal.removeEventListener('abort', onAbort);
    }
    state.timer = setTimeout(() => {
      void this.request('turn/interrupt', { threadId, turnId: state.turnId }).catch(() => {});
      this._rejectRun(state, new Error('Codex App Server turn timed out.'));
    }, this.turnTimeoutMs);
    this.runs.set(threadId, state);
    try {
      if (signal?.aborted) onAbort();
      if (state.cancelled) return await promise;
      const started = await this._requestRaw('turn/start', {
        threadId,
        input: [{ type: 'text', text: input }],
        ...turnOptions,
      });
      state.turnId = started?.turn?.id || state.turnId;
      if (state.cancelled) interrupt();
      const outcome = await promise;
      if (!outcome.text) throw new CodexAppServerError('Codex completed without a response.', state.toolCallsAttempted);
      return outcome;
    } catch (error) {
      if (error instanceof CodexAppServerError) throw error;
      throw new CodexAppServerError(error.message || 'Codex App Server stopped unexpectedly.', state.toolCallsAttempted);
    } finally {
      clearTimeout(state.timer);
      clearTimeout(state.cancelDrainTimer);
      state.abortCleanup?.();
      this.runs.delete(threadId);
    }
  }

  stop() {
    try { this.reader?.close(); } catch {}
    try { this.child?.kill(); } catch {}
    this.child = null;
    this.ready = false;
  }
}

let clientSingleton = null;
let gatewaySingleton = null;
let disabledSkillPaths = null;

function getClient() {
  if (!clientSingleton) {
    clientSingleton = new CodexAppServerClient();
    process.once('exit', () => clientSingleton?.stop());
  }
  return clientSingleton;
}

async function getGateway() {
  if (!gatewaySingleton) {
    gatewaySingleton = new AriResponsesGateway();
    process.once('exit', () => { void gatewaySingleton?.stop(); });
  }
  return gatewaySingleton.start();
}

async function getDisabledSkillPaths(client, workspace) {
  if (disabledSkillPaths) return disabledSkillPaths;
  try {
    const response = await client.request('skills/list', { cwds: [workspace], forceReload: false });
    disabledSkillPaths = (response?.data || [])
      .flatMap((entry) => entry.skills || [])
      .filter((skill) => skill.enabled !== false && skill.path)
      .map((skill) => skill.path);
  } catch {
    disabledSkillPaths = [];
  }
  return disabledSkillPaths;
}

function inferredDomain(message) {
  const text = String(message || '').toLowerCase();
  const domains = [
    ['sales', /\b(sales|pipeline|deal|lead|prospect|client|customer|crm)\b/],
    ['calendar', /\b(meeting|calendar|appointment|schedule|agenda|call)\b/],
    ['email', /\b(email|mail|inbox|reply|message)\b/],
    ['team', /\b(team|teammate|standup|poll|leave|member)\b/],
    ['task', /\b(task|todo|work item|assignment)\b/],
    ['reminder', /\b(reminder|remind|alarm)\b/],
    ['contact', /\b(contact|phone number|address book)\b/],
    ['notes', /\b(note|notes|list|checklist)\b/],
  ];
  return domains.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function lexicalToolNames(message, tools) {
  const stopWords = new Set(['about', 'after', 'again', 'could', 'from', 'have', 'help', 'into', 'just', 'like', 'need', 'please', 'that', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);
  const tokens = [...new Set(String(message || '').toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((token) => token.length > 2 && !stopWords.has(token));
  return tools.map((tool) => {
    const name = tool.name.toLowerCase().replace(/_/g, ' ');
    const description = String(tool.description || '').toLowerCase().slice(0, 1000);
    const score = tokens.reduce((total, token) => total
      + (name.includes(token) ? 8 : 0)
      + (description.includes(token) ? 1 : 0), 0);
    return { name: tool.name, score };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.name);
}

async function ariProviderTools(userMessage, contextHints = {}, recentMessages = [], options = {}) {
  const allTools = listTools();
  const limit = Math.max(10, Math.min(24, Number(process.env.ARI_GATEWAY_TOOL_LIMIT || 18)));
  try {
    const {
      classifyCategoryFromKeywords,
      getExplicitToolHint,
      getToolsForCategory,
    } = require('./tool-definitions');
    const recentText = Array.isArray(recentMessages)
      ? recentMessages.slice(-4).map((message) => message?.content || message?.text || '').filter(Boolean).join('\n')
      : '';
    const selectionText = `${recentText}\n${userMessage}`.trim();
    const explicit = getExplicitToolHint(userMessage, contextHints);
    const keywordCategory = classifyCategoryFromKeywords(userMessage);
    const domain = inferredDomain(userMessage);
    const category = keywordCategory === 'account' && domain ? domain : (keywordCategory || domain);
    const orderedNames = [];
    const addNames = (names) => {
      for (const name of names || []) if (name && !orderedNames.includes(name)) orderedNames.push(name);
    };

    addNames([explicit]);
    if (options.skipSemantic !== true) {
      try {
        const retrieved = await require('./tool-retriever.service').retrieve(selectionText, { topK: 10 });
        addNames(retrieved?.tools?.map((tool) => tool.function?.name));
      } catch {}
    }
    if (category) {
      addNames(getToolsForCategory(category, limit).map((tool) => tool.function?.name));
    }
    addNames(lexicalToolNames(selectionText, allTools));
    addNames(GENERAL_ARI_TOOLS);

    const names = new Set(orderedNames.slice(0, limit));
    if (!names.has('request_clarification')) {
      const last = [...names].at(-1);
      if (last) names.delete(last);
      names.add('request_clarification');
    }
    return allTools.filter((tool) => names.has(tool.name));
  } catch {
    const fallback = new Set(GENERAL_ARI_TOOLS.slice(0, limit));
    return allTools.filter((tool) => fallback.has(tool.name));
  }
}

async function providerRuntime(client, preferences, workspace, userMessage, options = {}) {
  const skillPaths = await getDisabledSkillPaths(client, workspace);
  const commonConfig = isolationConfig(skillPaths);
  const selectedProvider = options.providerOverride || preferences.provider;
  const connectedCodex = selectedProvider === 'codex' && preferences.codexConnected === true;
  if (options.providerOverride === 'codex' && !connectedCodex) {
    throw new CodexAppServerError('Codex must be connected before it can be selected for this run.', 0, 'codex_not_connected');
  }
  if (connectedCodex) {
    const modelPreference = MODEL_OPTIONS[preferences.model] ? preferences.model : 'auto';
    const selected = MODEL_OPTIONS[modelPreference] || MODEL_OPTIONS.auto;
    const promoteNames = [];
    try {
      const { getExplicitToolHint } = require('./tool-definitions');
      const explicit = getExplicitToolHint(userMessage, options.contextHints || {});
      if (explicit) promoteNames.push(explicit);
    } catch {}
    if (options.contextHints?.hasDocumentAttachment) {
      promoteNames.push('analyze_file', 'manage_contact_groups');
    }
    return {
      kind: 'codex',
      persistThread: options.forceEphemeral !== true,
      modelPreference,
      model: selected.model || null,
      effort: selected.effort || null,
      modelProvider: null,
      config: commonConfig,
      tools: dynamicToolSpecs({ promoteNames }),
    };
  }
  const gateway = await getGateway();
  let model = llm.modelFor('agent_primary') || llm.defaultModel();
  try {
    const { classifyComplexity } = require('./agent-loop.service');
    if (classifyComplexity(userMessage) === 'complex') {
      model = llm.modelFor('agent_escalate') || llm.complexModel() || model;
    }
  } catch {}
  return {
    kind: 'ari',
    persistThread: false,
    modelPreference: model,
    model,
    effort: null,
    modelProvider: 'ari_gateway',
    config: {
      ...commonConfig,
      model_provider: 'ari_gateway',
      model_providers: {
        ari_gateway: {
          name: 'Ari AI',
          base_url: gateway.baseUrl,
          wire_api: 'responses',
          experimental_bearer_token: gateway.token,
          request_max_retries: 1,
          stream_max_retries: 1,
          stream_idle_timeout_ms: 90_000,
        },
      },
    },
    tools: dynamicToolSpecs({
      tools: await ariProviderTools(userMessage, options.contextHints, options.recentMessages),
      deferExtended: false,
    }),
  };
}

function promptForTurn({
  userMessage,
  recentMessages,
  userTimezone,
  includeHistory,
  contextHints,
  backgroundBlock,
  nowIso,
  toolHint,
}) {
  const history = includeHistory && Array.isArray(recentMessages)
    ? recentMessages.slice(-8).map((message) => `${message.role || message.sender || 'message'}: ${message.content || message.text || ''}`).join('\n')
    : '';
  return [
    buildRuntimeContext({ userTimezone, contextHints, backgroundBlock, nowIso }),
    toolHint ? `Routing hint: start with the ${toolHint} Ari tool if it still matches the current request. This hint is not permission to guess missing consequential details.` : '',
    history ? `Recent Ari conversation:\n${history}` : '',
    `Current request:\n${userMessage}`,
  ].filter(Boolean).join('\n\n');
}

function threadPreferenceKey(userPhone, runtime, sessionId = null) {
  const scope = sessionId ? `session:${sessionId}` : 'global';
  return `${String(userPhone)}:${scope}:${runtime.kind}:${runtime.modelPreference}:app-server-v3`;
}

function clearPersistedThread({
  userPhone,
  runtime,
  sessionId = null,
  expectedThreadId = null,
  store = preferencesService,
}) {
  if (!runtime?.persistThread) return false;
  const key = threadPreferenceKey(userPhone, runtime, sessionId);
  const latest = store.readPreferences();
  const threads = latest.codexAppServerThreads && typeof latest.codexAppServerThreads === 'object'
    ? latest.codexAppServerThreads : {};
  if (!threads[key] || (expectedThreadId && threads[key] !== expectedThreadId)) return false;
  const next = { ...threads };
  delete next[key];
  store.writePreferences({ codexAppServerThreads: next });
  return true;
}

function reconcilePersistedThreadOutcome({
  userPhone,
  runtime,
  sessionId = null,
  threadId,
  status,
  outcome = null,
  store = preferencesService,
}) {
  if (!runtime?.persistThread
    || status === 'completed'
    || status === 'waiting_for_user'
    || status === 'waiting_for_approval'
    || isRecoverableCapacityOutcome(outcome)
    || outcome?.meta?.safeToResumeAfterInterruption === true) return true;
  clearPersistedThread({ userPhone, runtime, sessionId, expectedThreadId: threadId, store });
  return false;
}

async function prepareThread(client, { userPhone, runtime, sessionId = null }) {
  const preferences = preferencesService.readPreferences();
  const key = threadPreferenceKey(userPhone, runtime, sessionId);
  const threads = preferences.codexAppServerThreads && typeof preferences.codexAppServerThreads === 'object'
    ? preferences.codexAppServerThreads : {};
  const storedId = threads[key] || null;
  const workspace = process.env.ARI_CODEX_WORKSPACE || path.join(process.cwd(), '.ari-codex-workspace');
  const threadModel = runtime.model ? { model: runtime.model } : {};
  const providerModel = runtime.modelProvider ? { modelProvider: runtime.modelProvider } : {};
  if (runtime.persistThread && storedId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId: storedId,
        cwd: workspace,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: BASE_INSTRUCTIONS,
        developerInstructions: DEVELOPER_INSTRUCTIONS,
        config: runtime.config,
        excludeTurns: true,
        ...threadModel,
        ...providerModel,
      });
      return { threadId: resumed.thread.id, model: resumed.model, isNew: false };
    } catch {
      const latest = preferencesService.readPreferences();
      const next = { ...(latest.codexAppServerThreads || {}) };
      delete next[key];
      preferencesService.writePreferences({ codexAppServerThreads: next });
    }
  }
  const started = await client.request('thread/start', {
    cwd: workspace,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: BASE_INSTRUCTIONS,
    developerInstructions: DEVELOPER_INSTRUCTIONS,
    serviceName: 'ari_desktop',
    ephemeral: !runtime.persistThread,
    selectedCapabilityRoots: [],
    environments: [],
    config: runtime.config,
    dynamicTools: runtime.tools,
    ...threadModel,
    ...providerModel,
  });
  if (runtime.persistThread) {
    const latest = preferencesService.readPreferences();
    preferencesService.writePreferences({
      codexAppServerThreads: {
        ...(latest.codexAppServerThreads || {}),
        [key]: started.thread.id,
      },
    });
  }
  return { threadId: started.thread.id, model: started.model, isNew: true };
}

async function runCodexAppServerAgent({
  userMessage,
  userPhone,
  sessionId = null,
  userTimezone,
  recentMessages,
  contextHints = null,
  backgroundBlock: providedBackground,
  nowIso = new Date().toISOString(),
  providerOverride = null,
  forceEphemeral = false,
  onEvent = async () => {},
  signal = null,
}) {
  if (signal?.aborted) throw new CodexAppServerError('The Codex App Server turn was cancelled.', 0, 'agent_cancelled');
  const preferences = preferencesService.readPreferences();
  const client = getClient();
  const workspace = process.env.ARI_CODEX_WORKSPACE || path.join(process.cwd(), '.ari-codex-workspace');
  let backgroundBlock = providedBackground;
  if (backgroundBlock === undefined) {
    try {
      backgroundBlock = await require('./context-builder.service').build(userPhone, userMessage);
    } catch {
      backgroundBlock = '';
    }
  }
  let toolHint = null;
  try {
    toolHint = require('./tool-definitions').getExplicitToolHint(userMessage, contextHints || {});
  } catch {}
  const runtime = await providerRuntime(client, preferences, workspace, userMessage, {
    contextHints,
    recentMessages,
    providerOverride,
    forceEphemeral,
  });
  if (signal?.aborted) throw new CodexAppServerError('The Codex App Server turn was cancelled.', 0, 'agent_cancelled');
  const prepared = await prepareThread(client, { userPhone, runtime, sessionId });
  if (signal?.aborted) throw new CodexAppServerError('The Codex App Server turn was cancelled.', 0, 'agent_cancelled');
  const chatSession = currentChatSession() || (sessionId ? { sessionId, userPhone } : null);
  const initialInput = promptForTurn({
    userMessage,
    recentMessages,
    userTimezone,
    contextHints,
    backgroundBlock,
    nowIso,
    toolHint,
    includeHistory: prepared.isNew || !runtime.persistThread,
  });
  const turnOptions = {
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.effort ? { effort: runtime.effort } : {}),
    summary: 'concise',
  };
  let outcome;
  try {
    outcome = await runCapacityContinuationLoop({
      initialInput,
      runSegment: (input) => client.runTurn({
        threadId: prepared.threadId,
        userPhone,
        chatSession,
        onEvent,
        finalModel: `${runtime.kind}:${prepared.model || runtime.modelPreference}`,
        engine: `app-server:${runtime.kind}`,
        signal,
        input,
        turnOptions,
      }),
      onContinue: async ({ continuationCount, maxContinuations }) => {
        await onEvent({
          type: 'run.continuing',
          step: null,
          summary: `Continuing verified progress (${continuationCount}/${maxContinuations})`,
          payload: { continuationCount, maxContinuations, reason: 'application_tool_capacity' },
        });
      },
    });
  } catch (error) {
    // Interrupted/failed provider-owned history cannot be rewritten safely.
    // Force the next turn onto a fresh thread seeded from Ari's canonical
    // conversation history instead of resuming uncertain model state.
    const checkpoint = error?.partialOutcome || null;
    reconcilePersistedThreadOutcome({
      userPhone,
      runtime,
      sessionId,
      threadId: prepared.threadId,
      status: checkpoint?.status || 'failed',
      outcome: checkpoint,
    });
    throw error;
  }
  reconcilePersistedThreadOutcome({
    userPhone,
    runtime,
    sessionId,
    threadId: prepared.threadId,
    status: outcome.status,
    outcome,
  });
  const total = outcome.contextUsage?.total;
  const window = Number(outcome.contextUsage?.modelContextWindow || 0);
  if (runtime.persistThread && total && window && Number(total.totalTokens || 0) > window * 0.7) {
    void client.request('thread/compact/start', { threadId: prepared.threadId }).catch(() => {});
  }
  return outcome;
}

module.exports = {
  CORE_TOOLS,
  GENERAL_ARI_TOOLS,
  BASE_INSTRUCTIONS,
  CodexAppServerClient,
  CodexAppServerError,
  DEVELOPER_INSTRUCTIONS,
  MODEL_OPTIONS,
  aggregateCapacitySegments,
  clearPersistedThread,
  reconcilePersistedThreadOutcome,
  applicationToolCallLimit,
  capacityContinuationLimit,
  codexTurnTimeoutMs,
  ariProviderTools,
  deriveAppServerOutcome,
  dynamicToolSpecs,
  inferredDomain,
  isRecoverableCapacityOutcome,
  itemActivity,
  lexicalToolNames,
  normalizeUsage,
  providerRuntime,
  promptForTurn,
  resolveBundledCodex,
  runCapacityContinuationLoop,
  runCodexAppServerAgent,
  safeJson,
  targetTriple,
  threadPreferenceKey,
};
