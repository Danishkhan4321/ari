'use strict';

// Shared per-run tool executor for Ari's agent runtimes (agno, native).
//
// Extracted from agno-agent.service.js so every runtime provably shares the
// same semantics for: contract validation, effect classification, idempotency
// journal claim/finish, confirmation-gate transition detection, tool timeout +
// abort handling, event emission, and terminal-result latching. A runtime that
// drifts from these rules is how "Ari said it did X but didn't" bugs happen.

const crypto = require('node:crypto');
const logger = require('../utils/logger');
const {
  effectForArgs,
  getAgentToolContract,
  validateAgentToolArguments,
} = require('./agent-tool-contracts.service');
const { normalizeToolResult, serializeToolResult } = require('./tool-result.service');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function emitAgentEvent(onEvent, runId, event) {
  if (typeof onEvent !== 'function') return Promise.resolve();
  return Promise.resolve(onEvent({
    runId: runId || null,
    timestamp: new Date().toISOString(),
    ...event,
  })).catch((error) => {
    logger.warn({ eventType: event?.type, err: error.message }, 'Agent lifecycle event failed');
  });
}

function isMutation(effect) {
  return ['reversible_write', 'external_write', 'destructive', 'mixed'].includes(effect);
}

function stopsFollowingTools(result, journalStatus = 'completed') {
  return journalStatus === 'unknown'
    || ['waiting_approval', 'waiting_input'].includes(result?.status)
    || result?.error?.category === 'unknown_outcome';
}

function boundedToolResult(result, maxChars = 12_000) {
  return JSON.parse(serializeToolResult(result, maxChars));
}

// Race the business operation against both the tool timeout and the run's
// abort signal. IMPORTANT SEMANTICS: rejecting here does NOT stop the
// underlying operation — a mutation that already reached its service keeps
// running, which is why the rejection code marks the outcome UNKNOWN rather
// than pretending the action stopped. The forwarded controller signal gives
// well-behaved services a chance to stop before their first write.
function withToolTimeout(work, timeoutMs, signal, toolName, effect) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  let rejectForAbort = null;
  const onInterruptAbort = () => {
    const error = new Error(`${toolName} was cancelled.`);
    error.code = isMutation(effect) ? 'tool_aborted_unknown_outcome' : 'agent_cancelled';
    rejectForAbort?.(error);
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  const operation = Promise.resolve().then(() => work(controller.signal));
  const interruption = new Promise((_, reject) => {
    rejectForAbort = reject;
    timer = setTimeout(() => {
      controller.abort(new Error(`${toolName} timed out`));
      const error = new Error(`${toolName} exceeded its ${timeoutMs}ms timeout.`);
      error.code = isMutation(effect) ? 'tool_timeout_unknown_outcome' : 'tool_timeout';
      reject(error);
    }, timeoutMs);
    if (signal?.aborted) onInterruptAbort();
    else signal?.addEventListener('abort', onInterruptAbort, { once: true });
  });
  return Promise.race([operation, interruption]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', onInterruptAbort);
    operation.catch(() => {});
  });
}

/**
 * Create a per-run tool executor.
 *
 * @param {object} deps
 * @param {string} deps.userPhone
 * @param {string} deps.requestId          stable run/request ID for call IDs
 * @param {string} deps.conversationKey    idempotency-journal scope
 * @param {object} deps.persistence        openRouterAgentPersistence-compatible
 * @param {Function} deps.queryFn          lock-owned query function
 * @param {Function} deps.executeFn        (name, args, executionContext) => result
 * @param {AbortSignal} [deps.signal]      run-level abort signal
 * @param {object} deps.config             { maxToolCalls, toolTimeoutMs }
 * @param {string} deps.runtimeLabel       e.g. 'agno-gemini', 'native-gemini'
 * @param {Function} [deps.onEvent]
 * @param {string}  [deps.runId]
 * @param {object}  [deps.confirmationGate]  injectable for tests
 * @param {string}  [deps.userMessage]       current user request (narration context)
 * @param {Function} [deps.onMutationSuccess] hook: (toolName, result) after a
 *                                            successful mutating tool commit
 */
function createAgentToolExecutor(deps) {
  const {
    userPhone, requestId, conversationKey,
    persistence, queryFn, executeFn, signal,
    config, runtimeLabel, onEvent, runId,
    onMutationSuccess,
  } = deps;

  const toolResults = [];
  const toolsUsed = [];
  const activeToolPromises = new Set();
  let acceptedCalls = 0;
  let terminalToolResult = null;
  let clearConversationAfterTurn = false;

  const emit = (event) => emitAgentEvent(onEvent, runId, event);

  async function executeTool({ callId, name, arguments: args }) {
    if (terminalToolResult) return terminalToolResult;
    if (acceptedCalls >= config.maxToolCalls) {
      terminalToolResult = normalizeToolResult({
        status: 'failure',
        error: {
          code: 'agent_tool_limit_reached', category: 'limit', retryable: false,
          message: `This run reached its limit of ${config.maxToolCalls} Ari tool calls.`,
        },
        user_summary: `${name} was not started because the tool-call safety limit was reached.`,
      }, { toolName: name });
      toolResults.push(terminalToolResult);
      return terminalToolResult;
    }

    const contract = getAgentToolContract(name);
    const validation = validateAgentToolArguments(name, args);
    if (!contract || !validation.success) {
      const invalid = normalizeToolResult({
        status: 'failure',
        error: {
          code: contract ? 'invalid_tool_arguments' : 'unknown_tool',
          category: 'validation', retryable: Boolean(contract),
          message: String(validation.error.message).slice(0, 800),
        },
        user_summary: contract ? `${name} needs corrected inputs.` : `Ari does not expose ${name}.`,
      }, { toolName: name });
      toolResults.push(invalid);
      return invalid;
    }
    const toolEffect = effectForArgs(name, validation.data);
    acceptedCalls++;
    const stableCallId = String(callId || `${requestId}:${name}:${sha256(JSON.stringify(validation.data)).slice(0, 16)}`);
    const claim = await persistence.claimToolExecution({
      conversationKey, callId: stableCallId, toolName: name, args: validation.data, queryFn,
    });
    if (!claim.claimed) {
      if (!claim.conflict && claim.existing?.status === 'completed' && claim.existing.result) {
        const replayed = boundedToolResult(normalizeToolResult({
          ...claim.existing.result,
          meta: { ...(claim.existing.result.meta || {}), replayed: true, call_id: stableCallId },
        }, { toolName: name }));
        toolsUsed.push(name);
        toolResults.push(replayed);
        if (stopsFollowingTools(replayed, claim.existing.status)) terminalToolResult = replayed;
        await emit({
          type: 'tool.replayed', step: acceptedCalls, toolName: name,
          summary: `${name.replace(/_/g, ' ')} reused its recorded result`, payload: { callId: stableCallId },
        });
        return replayed;
      }
      const blocked = normalizeToolResult({
        status: 'failure',
        error: {
          code: claim.conflict || 'tool_outcome_unknown', category: 'idempotency', retryable: false,
          message: 'This tool call already started and cannot be safely replayed.',
        },
        user_summary: `${name} was not repeated because an earlier attempt may have taken effect.`,
      }, { toolName: name });
      toolsUsed.push(name);
      toolResults.push(blocked);
      terminalToolResult = blocked;
      return blocked;
    }

    toolsUsed.push(name);
    await emit({
      type: 'tool.started', step: acceptedCalls, toolName: name,
      summary: `Running ${name.replace(/_/g, ' ')}`, payload: { callId: stableCallId },
    });
    // Fire-and-forget: replace the generic line above with a task-specific
    // one as soon as the narrator produces it. Never blocks the tool.
    try {
      require('./status-narrator.service')
        .narrateToolStart({
          toolName: name,
          argNames: Object.keys(validation.data || {}),
          userMessage: deps.userMessage || '',
        })
        .then((line) => {
          if (!line) return;
          return emit({
            type: 'status.narration', step: acceptedCalls, toolName: name,
            summary: line, payload: { callId: stableCallId },
          });
        })
        .catch(() => {});
    } catch (_) { /* narration is best-effort */ }
    let result;
    let journalStatus = 'completed';
    try {
      let gate = deps.confirmationGate || null;
      try { gate ||= require('./confirmation-gate.service'); } catch (_) {}
      const beforeApproval = gate?.pendingIdentity?.(userPhone)
        ?? (gate?.hasPending?.(userPhone) === true ? 'pending' : null);
      const raw = await withToolTimeout(
        (toolSignal) => executeFn(name, validation.data, {
          callId: stableCallId,
          signal: toolSignal,
          runtime: runtimeLabel,
          toolEffect,
        }),
        config.toolTimeoutMs,
        signal,
        name,
        toolEffect,
      );
      const afterApproval = gate?.pendingIdentity?.(userPhone)
        ?? (gate?.hasPending?.(userPhone) === true ? 'pending' : null);
      // Attribution guard for parallel branches: when the new pend clearly
      // names a DIFFERENT agent tool, it belongs to a concurrently running
      // branch — this tool's own result must not be rewritten as pending.
      const gateChanged = Boolean(afterApproval) && afterApproval !== beforeApproval;
      const identity = String(afterApproval || '');
      const belongsToOtherTool = /:agent_tool:/.test(identity)
        && !identity.includes(`:agent_tool:${name}`);
      result = gateChanged && !belongsToOtherTool
        ? normalizeToolResult({
          status: 'waiting_approval', data: { pending: true },
          user_summary: typeof raw === 'string' ? raw : 'This action is waiting for approval.',
        }, { toolName: name })
        : normalizeToolResult(raw, { toolName: name });
    } catch (error) {
      const unknown = ['tool_timeout_unknown_outcome', 'tool_aborted_unknown_outcome'].includes(error.code);
      journalStatus = unknown ? 'unknown' : 'failed';
      result = normalizeToolResult({
        status: 'failure',
        error: {
          code: error.code || 'tool_execution_error',
          category: unknown ? 'unknown_outcome' : 'execution',
          retryable: !unknown && !isMutation(toolEffect),
          message: String(error.message || 'Tool execution failed.').slice(0, 800),
        },
        user_summary: unknown
          ? `${name} stopped without a confirmed outcome; I will not replay it.`
          : `${name} failed: ${String(error.message || 'unknown error').slice(0, 300)}`,
      }, { toolName: name });
    }
    result = boundedToolResult(result);
    if (result.status === 'waiting_approval') journalStatus = 'pending_approval';
    else if (result.status === 'waiting_input') journalStatus = 'waiting_input';
    if (name === 'clear_chat_history' && result.status === 'success') {
      clearConversationAfterTurn = true;
    }
    if (stopsFollowingTools(result, journalStatus)) terminalToolResult = result;
    let journalPersisted = true;
    try {
      await persistence.finishToolExecution({
        conversationKey, callId: stableCallId, status: journalStatus, result, queryFn,
      });
    } catch (error) {
      // The business tool has already returned a verified outcome. A
      // bookkeeping failure must not rewrite that outcome as though the
      // user action failed. Leave the claimed row in its conservative
      // running state so the same provider call ID cannot be replayed.
      journalPersisted = false;
      result = boundedToolResult({
        ...result,
        meta: {
          ...(result.meta || {}),
          journal_persisted: false,
          journal_error_code: String(error.code || 'journal_write_failed').slice(0, 100),
        },
      });
      logger.error({
        err: error.message,
        code: error.code,
        toolName: name,
        callId: stableCallId,
      }, 'Agent tool completed but its idempotency journal could not be finalized');
    }
    toolResults.push(result);
    if (result.status === 'success' && isMutation(toolEffect)) {
      // Product-data invalidation (C-2): open dashboard pages refetch when
      // this lands. Fire-and-forget by design.
      require('./entity-events.service')
        .record({ userPhone, toolName: name, runId: runId || null })
        .catch(() => {});
      if (typeof onMutationSuccess === 'function') {
        try { await onMutationSuccess(name, result); } catch (hookError) {
          logger.warn({ toolName: name, err: hookError.message }, 'onMutationSuccess hook failed');
        }
      }
    }
    await emit({
      type: result.status === 'success' ? 'tool.succeeded'
        : result.status === 'waiting_approval' ? 'tool.waiting_approval'
          : result.status === 'waiting_input' ? 'tool.waiting_input' : 'tool.failed',
      step: acceptedCalls, toolName: name,
      summary: result.user_summary || `${name.replace(/_/g, ' ')} ${result.status}`,
      payload: {
        status: result.status,
        code: result.error?.code || null,
        callId: stableCallId,
        journalPersisted,
      },
    });
    return result;
  }

  function execute(call) {
    const pending = Promise.resolve().then(() => executeTool(call));
    activeToolPromises.add(pending);
    pending.finally(() => activeToolPromises.delete(pending)).catch(() => {});
    return pending;
  }

  return {
    execute,
    // Wait for every in-flight tool to settle (used when the run aborts so an
    // unknown outcome is journaled before the conversation lock is released).
    drain: () => Promise.allSettled([...activeToolPromises]),
    state: {
      get toolResults() { return toolResults; },
      get toolsUsed() { return toolsUsed; },
      get acceptedCalls() { return acceptedCalls; },
      get terminalToolResult() { return terminalToolResult; },
      get clearConversationAfterTurn() { return clearConversationAfterTurn; },
    },
  };
}

module.exports = {
  createAgentToolExecutor,
  emitAgentEvent,
  isMutation,
  stopsFollowingTools,
  boundedToolResult,
  withToolTimeout,
};
