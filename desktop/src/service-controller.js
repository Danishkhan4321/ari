const { spawn } = require('node:child_process');
const treeKill = require('tree-kill');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function defaultProbe(url, expectedText) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1500),
      redirect: 'follow'
    });
    if (response.status >= 500) return false;
    if (!expectedText) return true;
    return (await response.text()).includes(expectedText);
  } catch {
    return false;
  }
}

class ServiceController {
  constructor({
    spawnProcess = spawn,
    probe = defaultProbe,
    killTree = treeKill,
    sleep = delay,
    onLog = () => {}
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.probe = probe;
    this.killTree = killTree;
    this.sleep = sleep;
    this.onLog = onLog;
    this.services = [];
  }

  async ensure(spec) {
    if (await this.probe(spec.url, spec.expectedText)) {
      const existing = { ...spec, managed: false, child: null, logs: [] };
      this.services.push(existing);
      return existing;
    }

    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const service = { ...spec, managed: true, child, logs: [] };
    this.services.push(service);
    this.capture(service, child.stdout);
    this.capture(service, child.stderr);

    const deadline = Date.now() + (spec.timeoutMs || 90000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error(`${spec.name} exited before it became ready. ${service.logs.slice(-8).join(' ')}`);
      }
      if (await this.probe(spec.url, spec.expectedText)) return service;
      await this.sleep(500);
    }
    throw new Error(`${spec.name} did not become ready in time. ${service.logs.slice(-8).join(' ')}`);
  }

  capture(service, stream) {
    if (!stream?.on) return;
    stream.on('data', (chunk) => {
      const safe = String(chunk).replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/gi, '[database-url]').trim();
      if (!safe) return;
      service.logs.push(safe);
      this.onLog(service.name, safe);
      if (service.logs.length > 50) service.logs.shift();
    });
  }

  stop(service, signal = 'SIGTERM') {
    if (!service?.managed || !service.child?.pid) return Promise.resolve();
    return new Promise((resolve) => this.killTree(service.child.pid, signal, () => resolve()));
  }

  async stopAll() {
    const managed = this.services.filter((service) => service.managed).reverse();
    await Promise.all(managed.map((service) => this.stop(service)));
    this.services = [];
  }
}

module.exports = { ServiceController, defaultProbe };
