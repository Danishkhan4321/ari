const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { ServiceController } = require('../src/service-controller');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('reuses a ready service and never marks it managed', async () => {
  let spawnCalls = 0;
  let expectedIdentity = null;
  const controller = new ServiceController({
    spawnProcess: () => { spawnCalls += 1; return fakeChild(); },
    probe: async (_url, expectedText) => { expectedIdentity = expectedText; return true; },
    killTree: (_pid, _signal, done) => done()
  });

  const service = await controller.ensure({
    name: 'dashboard',
    url: 'http://127.0.0.1:43101',
    expectedText: 'Ari Dashboard'
  });
  assert.equal(service.managed, false);
  assert.equal(spawnCalls, 0);
  assert.equal(expectedIdentity, 'Ari Dashboard');
});

test('starts an unavailable service and marks it managed', async () => {
  const child = fakeChild();
  let probes = 0;
  const controller = new ServiceController({
    spawnProcess: () => child,
    probe: async () => ++probes > 1,
    killTree: (_pid, _signal, done) => done(),
    sleep: async () => {}
  });

  const service = await controller.ensure({
    name: 'backend',
    url: 'http://127.0.0.1:43100/health',
    command: 'node',
    args: ['src/index.js'],
    cwd: 'D:/example/ari',
    env: {}
  });
  assert.equal(service.managed, true);
  assert.equal(service.child, child);
});

test('reports an early child-process exit', async () => {
  const child = fakeChild();
  child.exitCode = 1;
  const controller = new ServiceController({
    spawnProcess: () => child,
    probe: async () => false,
    killTree: (_pid, _signal, done) => done(),
    sleep: async () => {}
  });

  await assert.rejects(
    controller.ensure({ name: 'backend', url: 'http://127.0.0.1:43100', command: 'node', args: [], env: {} }),
    /backend exited before it became ready/
  );
});

test('redacts database URLs before recording service output', async () => {
  const child = fakeChild();
  let probes = 0;
  const written = [];
  const controller = new ServiceController({
    spawnProcess: () => child,
    probe: async () => ++probes > 1,
    killTree: (_pid, _signal, done) => done(),
    sleep: async () => {},
    onLog: (_name, line) => written.push(line)
  });

  const promise = controller.ensure({ name: 'backend', url: 'http://127.0.0.1:43100', command: 'node', args: [], env: {} });
  await Promise.resolve();
  child.stderr.emit('data', 'failed postgres://user:password@db.example/app');
  await promise;
  assert.deepEqual(written, ['failed [database-url]']);
});

test('stopAll terminates only managed child processes', async () => {
  const killed = [];
  const controller = new ServiceController({
    spawnProcess: () => fakeChild(),
    probe: async () => true,
    killTree: (pid, signal, done) => { killed.push([pid, signal]); done(); }
  });
  controller.services.push({ managed: false, child: { pid: 100 } });
  controller.services.push({ managed: true, child: { pid: 200 } });
  await controller.stopAll();
  assert.deepEqual(killed, [[200, 'SIGTERM']]);
});
