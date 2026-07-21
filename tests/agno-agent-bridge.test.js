'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createAgnoProcessBridge } = require('../src/services/agno-agent-bridge.service');

function fakeChild(onInput) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('close', 1, 'SIGTERM'));
    return true;
  };
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onInput(JSON.parse(line), child);
    }
  });
  return child;
}

test('Agno bridge exchanges typed tool calls and structured results over NDJSON', async () => {
  const sent = [];
  const child = fakeChild((message, process) => {
    sent.push(message);
    if (message.type === 'run') {
      queueMicrotask(() => process.stdout.write(`${JSON.stringify({
        protocol_version: 1, type: 'tool_call', request_id: message.request_id, call_id: 'call-1',
        name: 'view_calendar', arguments: { limit: 5 },
      })}\n`));
    } else if (message.type === 'tool_result') {
      assert.equal(message.result.status, 'success');
      queueMicrotask(() => {
        process.stdout.write(`${JSON.stringify({
          protocol_version: 1, type: 'final', request_id: message.request_id, status: 'completed',
          content: 'You have two meetings.', run_id: 'agno-run-1', metrics: { input_tokens: 40 },
        })}\n`);
        process.emit('close', 0, null);
      });
    }
  });
  const bridge = createAgnoProcessBridge({
    spawnFn: (_python, args, spawnOptions) => {
      assert.equal(require('node:path').isAbsolute(args[1]), true);
      assert.equal(require('node:path').basename(args[1]), 'worker-test.py');
      assert.equal(spawnOptions.cwd, require('node:path').dirname(args[1]));
      assert.equal(spawnOptions.env.PYTHONIOENCODING, 'utf-8');
      assert.equal(spawnOptions.env.PYTHONUTF8, '1');
      return child;
    },
    pythonExecutable: 'python-test',
    workerPath: 'worker-test.py',
  });

  const final = await bridge.run({
    request_id: 'request-1', user_id: 'tenant:user', session_id: 'session-1',
    message: 'What is on my calendar?', tools: [], config: {},
  }, {
    timeoutMs: 2_000,
    onToolCall: async (call) => {
      assert.equal(call.name, 'view_calendar');
      assert.deepEqual(call.arguments, { limit: 5 });
      return { status: 'success', data: { events: 2 }, user_summary: 'Two meetings.' };
    },
  });

  assert.equal(final.content, 'You have two meetings.');
  assert.equal(final.run_id, 'agno-run-1');
  assert.deepEqual(sent.map((message) => message.type), ['run', 'tool_result']);
  assert.equal(sent[0].protocol_version, 1);
});

test('Agno bridge rejects malformed worker output as a protocol error', async () => {
  const child = fakeChild((message, process) => {
    if (message.type === 'run') queueMicrotask(() => process.stdout.write('not-json\n'));
  });
  const bridge = createAgnoProcessBridge({ spawnFn: () => child });

  await assert.rejects(
    bridge.run({ request_id: 'bad-1', message: 'hello', tools: [], config: {} }, {
      timeoutMs: 2_000,
      onToolCall: async () => ({}),
    }),
    (error) => error.code === 'agno_protocol_error',
  );
  assert.equal(child.killed, true);
});

test('Agno bridge preserves an early worker startup error with an unknown request id', async () => {
  const child = fakeChild((message, process) => {
    if (message.type !== 'run') return;
    queueMicrotask(() => process.stdout.write(`${JSON.stringify({
      protocol_version: 1,
      type: 'error',
      request_id: 'unknown',
      code: 'agno_worker_error',
      message: 'Run request exceeded the 2MB limit',
    })}\n`));
  });
  const bridge = createAgnoProcessBridge({ spawnFn: () => child });

  await assert.rejects(
    bridge.run({ request_id: 'real-run-id', message: 'hello', tools: [], config: {} }, {
      timeoutMs: 2_000,
      onToolCall: async () => ({}),
    }),
    (error) => error.code === 'agno_worker_error' && /2MB limit/i.test(error.message),
  );
  assert.equal(child.killed, true);
});

test('Agno bridge cancellation terminates the sidecar before returning', async () => {
  const child = fakeChild(() => {});
  const bridge = createAgnoProcessBridge({ spawnFn: () => child });
  const abortController = new AbortController();
  const running = bridge.run({ request_id: 'cancel-1', message: 'wait', tools: [], config: {} }, {
    timeoutMs: 2_000,
    signal: abortController.signal,
    onToolCall: async () => ({}),
  });
  abortController.abort(new Error('user stopped'));

  await assert.rejects(running, (error) => error.code === 'agent_cancelled');
  assert.equal(child.killed, true);
});

test('Agno logs on stderr do not corrupt protocol messages', async () => {
  const child = fakeChild((message, process) => {
    if (message.type !== 'run') return;
    queueMicrotask(() => {
      process.stderr.write('agno diagnostic log\n');
      process.stdout.write(`${JSON.stringify({
        protocol_version: 1, type: 'final', request_id: message.request_id, status: 'completed', content: 'Hello.',
      })}\n`);
      process.emit('close', 0, null);
    });
  });
  const logs = [];
  const bridge = createAgnoProcessBridge({ spawnFn: () => child, onLog: (line) => logs.push(line) });
  const final = await bridge.run({ request_id: 'log-1', message: 'hello', tools: [], config: {} }, {
    timeoutMs: 2_000,
    onToolCall: async () => ({}),
  });

  assert.equal(final.content, 'Hello.');
  assert.deepEqual(logs, ['agno diagnostic log']);
});

test('Agno bridge rejects worker messages from an unsupported protocol version', async () => {
  const child = fakeChild((message, process) => {
    if (message.type !== 'run') return;
    queueMicrotask(() => process.stdout.write(`${JSON.stringify({
      protocol_version: 2,
      type: 'final',
      request_id: message.request_id,
      status: 'completed',
      content: 'This must not be accepted.',
    })}\n`));
  });
  const bridge = createAgnoProcessBridge({ spawnFn: () => child });

  await assert.rejects(
    bridge.run({ request_id: 'version-1', message: 'hello', tools: [], config: {} }, {
      timeoutMs: 2_000,
      onToolCall: async () => ({}),
    }),
    (error) => error.code === 'agno_protocol_error' && /protocol version/i.test(error.message),
  );
  assert.equal(child.killed, true);
});

test('Agno bridge terminates a worker with an oversized unterminated stdout message', async () => {
  const child = fakeChild((message, process) => {
    if (message.type === 'run') queueMicrotask(() => process.stdout.write('x'.repeat(65)));
  });
  const bridge = createAgnoProcessBridge({
    spawnFn: () => child,
    maxProtocolLineBytes: 64,
  });

  await assert.rejects(
    bridge.run({ request_id: 'stdout-limit-1', message: 'hello', tools: [], config: {} }, {
      timeoutMs: 2_000,
      onToolCall: async () => ({}),
    }),
    (error) => error.code === 'agno_protocol_error' && /limit/i.test(error.message),
  );
  assert.equal(child.killed, true);
});

test('Agno bridge terminates a worker with an oversized unterminated stderr message', async () => {
  const child = fakeChild((message, process) => {
    if (message.type === 'run') queueMicrotask(() => process.stderr.write('x'.repeat(65)));
  });
  const bridge = createAgnoProcessBridge({
    spawnFn: () => child,
    maxStderrLineBytes: 64,
  });

  await assert.rejects(
    bridge.run({ request_id: 'stderr-limit-1', message: 'hello', tools: [], config: {} }, {
      timeoutMs: 2_000,
      onToolCall: async () => ({}),
    }),
    (error) => error.code === 'agno_worker_output_too_large' && /stderr/i.test(error.message),
  );
  assert.equal(child.killed, true);
});

test('Agno bridge rejects promptly when the worker stdin pipe breaks', async () => {
  const child = fakeChild((message, process) => {
    if (message.type !== 'run') return;
    queueMicrotask(() => {
      const error = new Error('broken pipe');
      error.code = 'EPIPE';
      process.stdin.emit('error', error);
    });
  });
  const bridge = createAgnoProcessBridge({ spawnFn: () => child });

  await assert.rejects(
    bridge.run({ request_id: 'epipe-1', message: 'hello', tools: [], config: {} }, {
      timeoutMs: 2_000,
      onToolCall: async () => ({}),
    }),
    (error) => error.code === 'agno_worker_pipe_error' && error.cause?.code === 'EPIPE',
  );
  assert.equal(child.killed, true);
});

test('Agno bridge closes stdin and terminates the one-shot worker after final', async () => {
  const child = fakeChild((message, process) => {
    if (message.type !== 'run') return;
    queueMicrotask(() => process.stdout.write(`${JSON.stringify({
      protocol_version: 1,
      type: 'final',
      request_id: message.request_id,
      status: 'completed',
      content: 'Finished.',
    })}\n`));
  });
  const bridge = createAgnoProcessBridge({ spawnFn: () => child });

  const final = await bridge.run({ request_id: 'final-cleanup-1', message: 'hello', tools: [], config: {} }, {
    timeoutMs: 2_000,
    onToolCall: async () => ({}),
  });

  assert.equal(final.content, 'Finished.');
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.killed, true);
});
