'use strict';

const { getIntentForTool } = require('../services/tool-definitions');
const {
  listAgentToolContracts,
  prepareAgentToolInvocation,
  renderConfirmationPreview,
} = require('../services/agent-tool-contracts.service');
const { normalizeToolResult } = require('../services/tool-result.service');
const timezoneService = require('../services/timezone.service');
const { currentChatSession } = require('../services/chat-session-context');

function cancellationError(message, code = 'agent_cancelled') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfCancelled(signal, message = 'The Ari tool call was cancelled before execution.') {
  if (signal?.aborted) throw cancellationError(message);
}

function fieldDescription(name) {
  if (name === 'full_text') return 'The complete original user request, unchanged, for Ari to interpret with its existing business handler.';
  return `Value for the ${String(name).replace(/_/g, ' ')} field.`;
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((item) => normalizeInputSchema(item));

  const normalized = { ...schema };
  if (normalized.type === 'object' || normalized.properties) {
    normalized.type = normalized.type || 'object';
    normalized.additionalProperties = false;
    normalized.properties = Object.fromEntries(Object.entries(normalized.properties || {}).map(([name, value]) => {
      const property = normalizeInputSchema(value) || {};
      return [name, property.description ? property : { ...property, description: fieldDescription(name) }];
    }));
  }
  if (normalized.items) normalized.items = normalizeInputSchema(normalized.items);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(normalized[keyword])) {
      normalized[keyword] = normalized[keyword].map((item) => normalizeInputSchema(item));
    }
  }
  return normalized;
}

function listTools() {
  return listAgentToolContracts().map(({ name, description, inputSchema }) => ({
    name,
    description: name === 'view_calendar'
      ? `${description} Use this first for meeting preparation when no event has been identified.`
      : description,
    inputSchema: normalizeInputSchema(inputSchema),
  }));
}

function recoveryFor(result) {
  if (result.status === 'waiting_approval') {
    return ['Ask the user to approve or reject the pending action. Do not repeat the tool call.'];
  }
  if (result.status === 'waiting_input') {
    return ['Ask the pending clarification question and wait for the user to answer. Do not repeat the tool call yet.'];
  }
  if (result.status === 'failure') {
    const retryable = result.error?.retryable === true;
    return retryable
      ? ['Explain the failure briefly, correct the inputs if possible, and retry once.', 'Stop after the second failure and ask the user for help.']
      : ['Explain what blocked the action and ask for the missing information or a different action. Do not blindly retry.'];
  }
  return ['Use the result to continue the current plan or give the user a concise completion summary.'];
}

function readControllerContext(controller, mapName, userPhone) {
  try {
    const contextMap = controller?.[mapName];
    return typeof contextMap?.get === 'function'
      ? contextMap.get(userPhone)
      : undefined;
  } catch (_) {
    // Clarification detection must never make an otherwise valid CRM tool
    // fail merely because a controller implementation lacks this optional
    // state surface.
    return undefined;
  }
}

async function callTool(userPhone, name, args = {}, options = {}) {
  const signal = options.signal
    || currentChatSession()?.signal
    || null;
  throwIfCancelled(signal);
  const definition = listTools().find((tool) => tool.name === name);
  if (!definition) {
    return {
      status: 'failure',
      summary: `Ari does not expose a tool named ${name}.`,
      next_actions: ['Choose a tool from tools/list. Stop if none matches the user request.'],
      artifacts: [],
      data: null,
      error: { code: 'unknown_tool', retryable: false },
    };
  }

  const invocation = prepareAgentToolInvocation(name, args, {
    originalText: options.originalText || '',
  });
  if (!invocation.validation.success) {
    return {
      status: 'failure',
      summary: `${name} received invalid arguments: ${String(invocation.validation.error.message).slice(0, 500)}`,
      next_actions: ['Correct only the invalid or missing fields, then retry once.'],
      artifacts: [],
      data: null,
      error: { code: 'invalid_tool_arguments', category: 'validation', retryable: true },
    };
  }

  try {
    // Required lazily to avoid a startup cycle between the webhook controller
    // and the MCP route. The same handlers power Ari AI and Codex.
    const webhookController = require('../controllers/webhook.controller');
    const timezone = await timezoneService.getUserTimezone(userPhone);
    throwIfCancelled(signal);
    const text = invocation.messageText;
    if (!text) {
      // Handlers that re-parse text used to receive the literal tool NAME as
      // the user's message here, producing nonsense "results". Only guard
      // tools whose schema actually requires full_text: zero-argument tools
      // (daily_briefing, view_dashboard, connect_apple, …) are validly called
      // with {} and must not be rejected.
      const requiresText = Array.isArray(definition.inputSchema?.required)
        && definition.inputSchema.required.includes('full_text');
      const hasStructuredArgs = Object.entries(args || {}).some(([key, value]) =>
        !['full_text', 'question', 'query'].includes(key)
        && value !== null && value !== undefined && value !== '');
      if (requiresText && !hasStructuredArgs) {
        return {
          status: 'failure',
          summary: `${name} was called without full_text or any structured parameters, so nothing was executed.`,
          next_actions: [`Re-call ${name} with full_text set to the user's request (and structured parameters when the schema defines them).`],
          artifacts: [],
          data: null,
          error: { code: 'missing_tool_arguments', category: 'validation', retryable: true },
        };
      }
    }
    const message = {
      from: String(userPhone),
      text,
      type: 'text',
      source: 'dashboard',
      platform: 'whatsapp',
      lang: webhookController.detectLanguage(text),
      signal,
      // The controller uses this marker to enforce agent-only attachment
      // rules (explicit owned artifact IDs, never recent-document fallback).
      agentToolCallId: String(options.callId
        || `desktop:${name}:${currentChatSession()?.clientMessageId || Date.now().toString(36)}`),
    };
    const context = await webhookController.getContext(userPhone, timezone);
    throwIfCancelled(signal);
    context.userTimezone = context.userTimezone || timezone;
    context.agentExecution = {
      runtime: 'codex', signal, toolName: name,
      toolEffect: invocation.effect,
      confirmationMode: invocation.confirmationMode,
      requiresConfirmation: invocation.requiresConfirmation,
      confirmedByPolicy: false,
    };
    let confirmationGate = null;
    try { confirmationGate = require('../services/confirmation-gate.service'); } catch (_) {}

    if (invocation.confirmationMode === 'central') {
      if (!confirmationGate?.pend) {
        return {
          status: 'failure',
          summary: `${name} was blocked because its confirmation gate is unavailable.`,
          next_actions: ['Restore the confirmation service before retrying this action.'],
          artifacts: [], data: null,
          error: { code: 'confirmation_unavailable', category: 'safety', retryable: true },
        };
      }
      const preview = renderConfirmationPreview(name, invocation.validation.data);
      const prompt = await confirmationGate.pend(userPhone, {
        actionType: `agent_tool:${name}`,
        summary: preview,
        ctx: { toolName: name, effect: invocation.effect, runtime: 'codex' },
        execute: () => webhookController.executeIntent(
          getIntentForTool(name),
          invocation.handlerArgs,
          { ...message, signal: null },
          {
            ...context,
            agentExecution: {
              ...context.agentExecution,
              signal: null,
              confirmedByPolicy: true,
            },
          },
        ),
      });
      const waiting = normalizeToolResult({
        status: 'waiting_approval',
        user_summary: prompt,
        data: { pending: true, preview },
      }, { toolName: name });
      return {
        status: waiting.status,
        summary: waiting.user_summary,
        next_actions: recoveryFor(waiting),
        artifacts: [],
        data: waiting.data,
        error: waiting.error,
      };
    }

    const beforeApproval = confirmationGate?.pendingIdentity?.(userPhone)
      ?? (confirmationGate?.hasPending?.(userPhone) === true ? 'pending' : null);
    const beforeWorkflowApproval = webhookController.snapshotAgentApprovalState?.(userPhone) || null;
    // Snapshot the actual state objects, not just map membership. A user can
    // already have an older pending question when this tool starts; only an
    // entry created or replaced by THIS execution may change its outcome to
    // waiting_input.
    const beforePendingClarification = readControllerContext(
      webhookController,
      'pendingClarificationContext',
      userPhone,
    );
    const beforeIntentClarification = readControllerContext(
      webhookController,
      'lastClarificationContext',
      userPhone,
    );
    throwIfCancelled(signal);
    const raw = await webhookController.executeIntent(
      getIntentForTool(name),
      invocation.handlerArgs,
      message,
      context
    );
    if (signal?.aborted) {
      throw cancellationError(
        'The Ari tool was interrupted after execution started; its outcome may be partial or unknown.',
        'agent_cancelled_partial',
      );
    }
    const afterApproval = confirmationGate?.pendingIdentity?.(userPhone)
      ?? (confirmationGate?.hasPending?.(userPhone) === true ? 'pending' : null);
    const afterWorkflowApproval = webhookController.snapshotAgentApprovalState?.(userPhone) || null;
    const afterPendingClarification = readControllerContext(
      webhookController,
      'pendingClarificationContext',
      userPhone,
    );
    const afterIntentClarification = readControllerContext(
      webhookController,
      'lastClarificationContext',
      userPhone,
    );
    const createdClarification = name === 'request_clarification'
      || (afterPendingClarification !== undefined
        && afterPendingClarification !== beforePendingClarification)
      || (afterIntentClarification !== undefined
        && afterIntentClarification !== beforeIntentClarification);
    const createdWorkflowApproval = webhookController.didAgentCreateApproval?.(
      beforeWorkflowApproval,
      afterWorkflowApproval,
    ) === true;
    const normalized = (Boolean(afterApproval) && afterApproval !== beforeApproval)
      || createdWorkflowApproval
      ? normalizeToolResult({
        status: 'waiting_approval',
        user_summary: typeof raw === 'string' ? raw : 'This action is waiting for your approval.',
        data: { pending: true },
      }, { toolName: name })
      : createdClarification
        ? normalizeToolResult({
          status: 'waiting_input',
          user_summary: typeof raw === 'string' ? raw : 'I need one more detail before I can continue.',
          data: { pending: true },
        }, { toolName: name })
      : normalizeToolResult(raw, { toolName: name });
    if (normalized.status === 'success'
      && ['reversible_write', 'external_write', 'destructive', 'mixed'].includes(invocation.effect)) {
      // Codex-path mutations must refresh open dashboard pages too (C-2).
      require('../services/entity-events.service')
        .record({ userPhone, toolName: name, runId: currentChatSession()?.runId || null })
        .catch(() => {});
    }
    return {
      status: normalized.status,
      summary: normalized.user_summary || (normalized.ok ? `${name} completed.` : `${name} did not complete.`),
      next_actions: recoveryFor(normalized),
      artifacts: normalized.evidence || [],
      data: normalized.data,
      error: normalized.error,
    };
  } catch (error) {
    if (error?.code === 'agent_cancelled' || error?.code === 'agent_cancelled_partial') throw error;
    return {
      status: 'failure',
      summary: `${name} stopped: ${String(error.message || 'unknown error').slice(0, 300)}`,
      next_actions: [
        'Check whether the inputs are complete and retry once only if the action is safe to repeat.',
        'If it fails again, stop and tell the user exactly what is blocking progress.',
      ],
      artifacts: [],
      data: null,
      error: { code: 'tool_execution_error', category: 'execution', retryable: true },
    };
  }
}

module.exports = { callTool, listTools, normalizeInputSchema };
