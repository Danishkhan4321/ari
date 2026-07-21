'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const PROTOCOL_VERSION = 1;
const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_LINE_BYTES = 256 * 1024;
const DEFAULT_WORKER = path.resolve(__dirname, '../../agno_runtime/worker.py');

function defaultPythonExecutable() {
  if (process.env.ARI_AGNO_PYTHON) return process.env.ARI_AGNO_PYTHON;
  if (process.env.PYTHON) return process.env.PYTHON;
  const root = path.resolve(__dirname, '../..');
  const candidates = process.platform === 'win32'
    ? [path.join(root, '.venv-agno', 'Scripts', 'python.exe')]
    : [path.join(root, '.venv-agno', 'bin', 'python')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'python';
}

function bridgeError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function workerPipeError(streamName, error) {
  const detail = String(error?.message || 'pipe closed').slice(0, 300);
  return bridgeError(
    `The Agno worker ${streamName} pipe failed: ${detail}`,
    'agno_worker_pipe_error',
    error,
  );
}

function createAgnoProcessBridge(options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const pythonExecutable = options.pythonExecutable || defaultPythonExecutable();
  const configuredWorkerPath = options.workerPath || process.env.ARI_AGNO_WORKER || DEFAULT_WORKER;
  const workerPath = path.resolve(configuredWorkerPath);
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const maxProtocolLineBytes = positiveInteger(
    options.maxProtocolLineBytes,
    MAX_PROTOCOL_LINE_BYTES,
  );
  const maxStderrLineBytes = positiveInteger(
    options.maxStderrLineBytes,
    MAX_STDERR_LINE_BYTES,
  );

  async function run(request, runOptions = {}) {
    if (!request?.request_id || !request?.message) {
      throw bridgeError('Agno bridge requires request_id and message.', 'agno_invalid_request');
    }
    if (typeof runOptions.onToolCall !== 'function') {
      throw bridgeError('Agno bridge requires an onToolCall handler.', 'agno_invalid_request');
    }

    const child = spawnFn(pythonExecutable, ['-u', workerPath], {
      cwd: path.dirname(workerPath),
      env: {
        ...process.env,
        AGNO_TELEMETRY: 'false',
        // Windows otherwise inherits a legacy console code page (for example
        // cp1252), which crashes when Agno logs normal Unicode such as arrows.
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        ...(options.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let childClosed = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let messageTail = Promise.resolve();
      const timeoutMs = Math.max(1_000, Number(runOptions.timeoutMs || 300_000));

      const removeListeners = () => {
        clearTimeout(timer);
        runOptions.signal?.removeEventListener('abort', onAbort);
      };
      const closeInput = () => {
        if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
        try { child.stdin.end(); } catch (_) {}
      };
      const terminate = () => {
        closeInput();
        if (!childClosed && !child.killed && typeof child.kill === 'function') {
          try { child.kill('SIGTERM'); } catch (_) {}
        }
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        removeListeners();
        terminate();
        reject(error);
      };
      const succeed = (message) => {
        if (settled) return;
        settled = true;
        removeListeners();
        // The Python worker is one-shot. Closing stdin and requesting termination
        // here prevents a malformed worker from surviving after a valid final.
        terminate();
        resolve(message);
      };
      const send = (message) => {
        if (settled) return;
        if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
          fail(workerPipeError('stdin', bridgeError('stdin is closed', 'EPIPE')));
          return;
        }
        const encoded = `${JSON.stringify({
          protocol_version: PROTOCOL_VERSION,
          request_id: request.request_id,
          ...message,
        })}\n`;
        try {
          child.stdin.write(encoded, (error) => {
            if (error) fail(workerPipeError('stdin', error));
          });
        } catch (error) {
          fail(workerPipeError('stdin', error));
        }
      };

      const handleMessage = async (message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw bridgeError('Agno worker emitted a non-object message.', 'agno_protocol_error');
        }
        if (message.protocol_version !== PROTOCOL_VERSION) {
          throw bridgeError(
            `Agno worker used unsupported protocol version ${String(message.protocol_version ?? '<missing>')}.`,
            'agno_protocol_error',
          );
        }
        if (message.request_id !== request.request_id) {
          // A one-shot worker can emit request_id="unknown" only when it
          // could not finish parsing the initial envelope. Preserve that real
          // startup failure instead of masking it as an unrelated ID error.
          if (message.type === 'error' && message.request_id === 'unknown') {
            throw bridgeError(
              String(message.message || 'Agno could not parse the run request.'),
              String(message.code || 'agno_worker_error'),
            );
          }
          throw bridgeError(
            `Agno worker response request_id did not match the active run (expected ${request.request_id}, received ${String(message.request_id || '<missing>')}).`,
            'agno_protocol_error',
          );
        }
        if (message.type === 'tool_call') {
          if (!message.call_id || !message.name || typeof message.arguments !== 'object' || Array.isArray(message.arguments)) {
            throw bridgeError('Agno worker emitted an invalid tool_call message.', 'agno_protocol_error');
          }
          let result;
          try {
            result = await runOptions.onToolCall({
              callId: String(message.call_id),
              name: String(message.name),
              arguments: message.arguments || {},
            });
          } catch (error) {
            result = {
              status: 'failure',
              error: {
                code: error.code || 'tool_execution_error',
                category: 'execution',
                retryable: false,
                message: String(error.message || 'Tool execution failed.').slice(0, 800),
              },
              user_summary: `${message.name} failed before returning a result.`,
            };
          }
          send({ type: 'tool_result', call_id: String(message.call_id), result });
          return;
        }
        if (message.type === 'event') {
          await runOptions.onEvent?.(message.event || {});
          return;
        }
        if (message.type === 'final') {
          succeed(message);
          return;
        }
        if (message.type === 'error') {
          throw bridgeError(
            String(message.message || 'Agno worker failed.'),
            String(message.code || 'agno_worker_error'),
          );
        }
        throw bridgeError(`Unknown Agno protocol message: ${message.type || '<missing type>'}`, 'agno_protocol_error');
      };

      const consumeStdout = (chunk) => {
        if (settled) return;
        stdoutBuffer += stdoutDecoder.write(chunk);
        while (stdoutBuffer.includes('\n')) {
          const index = stdoutBuffer.indexOf('\n');
          const rawLine = stdoutBuffer.slice(0, index);
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (Buffer.byteLength(rawLine, 'utf8') > maxProtocolLineBytes) {
            fail(bridgeError(
              `Agno worker stdout message exceeded the ${maxProtocolLineBytes}-byte protocol limit.`,
              'agno_protocol_error',
            ));
            return;
          }
          const line = rawLine.trim();
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            fail(bridgeError(`Agno worker emitted invalid JSON: ${line.slice(0, 200)}`, 'agno_protocol_error', error));
            return;
          }
          messageTail = messageTail.then(() => handleMessage(message)).catch(fail);
        }
        if (Buffer.byteLength(stdoutBuffer, 'utf8') > maxProtocolLineBytes) {
          fail(bridgeError(
            `Agno worker stdout message exceeded the ${maxProtocolLineBytes}-byte protocol limit.`,
            'agno_protocol_error',
          ));
        }
      };
      const consumeStderr = (chunk) => {
        if (settled) return;
        stderrBuffer += stderrDecoder.write(chunk);
        while (stderrBuffer.includes('\n')) {
          const index = stderrBuffer.indexOf('\n');
          const rawLine = stderrBuffer.slice(0, index);
          stderrBuffer = stderrBuffer.slice(index + 1);
          if (Buffer.byteLength(rawLine, 'utf8') > maxStderrLineBytes) {
            fail(bridgeError(
              `Agno worker stderr line exceeded the ${maxStderrLineBytes}-byte limit.`,
              'agno_worker_output_too_large',
            ));
            return;
          }
          const line = rawLine.trim();
          if (line) onLog(line);
        }
        if (Buffer.byteLength(stderrBuffer, 'utf8') > maxStderrLineBytes) {
          fail(bridgeError(
            `Agno worker stderr line exceeded the ${maxStderrLineBytes}-byte limit.`,
            'agno_worker_output_too_large',
          ));
        }
      };
      const onAbort = () => fail(bridgeError(
        'The Agno run was cancelled.',
        'agent_cancelled',
        runOptions.signal?.reason,
      ));
      const timer = setTimeout(() => fail(bridgeError(
        `The Agno worker exceeded its ${timeoutMs}ms run timeout.`,
        'agno_run_timeout',
      )), timeoutMs);

      child.stdout.on('data', consumeStdout);
      child.stderr.on('data', consumeStderr);
      child.stdin.on('error', (error) => fail(workerPipeError('stdin', error)));
      child.stdout.on('error', (error) => fail(workerPipeError('stdout', error)));
      child.stderr.on('error', (error) => fail(workerPipeError('stderr', error)));
      child.on('error', (error) => fail(bridgeError(
        `Unable to start the Agno worker: ${error.message}`,
        error.code === 'ENOENT' ? 'agno_python_not_found' : 'agno_worker_start_failed',
        error,
      )));
      child.on('close', (code, signal) => {
        childClosed = true;
        stderrBuffer += stderrDecoder.end();
        if (stderrBuffer.trim()) onLog(stderrBuffer.trim());
        // stdout data and close can be delivered in the same event-loop turn.
        // Let the queued final message settle before declaring an early exit.
        messageTail.finally(() => {
          if (!settled) fail(bridgeError(
            `Agno worker exited before a final response (code=${code}, signal=${signal || 'none'}).`,
            'agno_worker_exited',
          ));
        });
      });

      if (runOptions.signal?.aborted) {
        onAbort();
        return;
      }
      runOptions.signal?.addEventListener('abort', onAbort, { once: true });
      send({ type: 'run', ...request });
    });
  }

  return { run };
}

module.exports = {
  DEFAULT_WORKER,
  PROTOCOL_VERSION,
  createAgnoProcessBridge,
  defaultPythonExecutable,
};
