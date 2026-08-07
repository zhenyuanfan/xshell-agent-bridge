import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(temporary, path);
}

export class FileBridgeTransport {
  constructor({ core, ipcDir, pollIntervalMs = 100, staleSessionMs = 5_000, onError = () => {} }) {
    this.core = core;
    this.ipcDir = ipcDir;
    this.pollIntervalMs = pollIntervalMs;
    this.staleSessionMs = staleSessionMs;
    this.onError = onError;
    this.timer = null;
    this.scanning = false;
  }

  async start() {
    await mkdir(this.ipcDir, { recursive: true });
    this.timer = setInterval(() => this.scan().catch(this.onError), this.pollIntervalMs);
    this.timer.unref();
    await this.scan();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const entries = await readdir(this.ipcDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          await this.scanSession(entry.name);
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  async scanSession(sessionId) {
    const directory = resolve(this.ipcDir, sessionId);
    const statePath = resolve(directory, 'state.json');
    let stateInfo;
    try {
      stateInfo = await stat(statePath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() - stateInfo.mtimeMs > this.staleSessionMs) return;

    const state = await readJson(statePath);
    if (state.protocol !== 'xshell-agent-file-v1' || state.sessionId !== sessionId) return;
    const payload = {
      metadata: { ...(state.metadata || {}), transport: 'file-v1' },
      screen: String(state.screen || ''),
    };
    if (this.core.sessions.has(sessionId)) this.core.heartbeat(sessionId, payload);
    else this.core.register({ bridgeId: sessionId, ...payload });

    const commandPath = resolve(directory, 'command.json');
    const activePath = resolve(directory, 'command.active.json');
    const resultPath = resolve(directory, 'result.json');
    let persistedJob = null;
    if (await exists(activePath)) persistedJob = await readJson(activePath);
    else if (await exists(commandPath)) persistedJob = await readJson(commandPath);
    if (persistedJob && !this.core.jobs.has(persistedJob.id)) {
      this.core.recoverDeliveredJob(sessionId, persistedJob);
      // Apply the original deadline immediately. Recovery never grants extra time.
      this.core.heartbeat(sessionId, payload);
    }

    if (await exists(resultPath)) {
      const result = await readJson(resultPath);
      if (!this.core.jobs.has(result.jobId) && result.job) {
        this.core.recoverDeliveredJob(sessionId, result.job);
      }
      try {
        this.core.completeJob(sessionId, result.jobId, result);
      } finally {
        await unlink(resultPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await unlink(activePath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }

    if (persistedJob) {
      const status = this.core.jobs.get(persistedJob.id)?.status;
      if (status === 'failed' || status === 'completed') {
        await unlink(commandPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await unlink(activePath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    if (await exists(commandPath) || await exists(activePath)) return;
    const job = this.core.nextJob(sessionId);
    if (job) await atomicWriteJson(commandPath, job);
  }
}
