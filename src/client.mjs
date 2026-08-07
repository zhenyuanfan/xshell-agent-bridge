import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const DAEMON_ENTRY = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
const REQUIRED_DAEMON_VERSION = '0.2.0';

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export class DaemonClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.baseUrl = `http://${config.server.host}:${config.server.port}`;
  }

  async request(path, { method = 'GET', body, authenticated = true } = {}) {
    const headers = { accept: 'application/json' };
    if (authenticated) headers.authorization = `Bearer ${this.config.server.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(value?.error?.message || `Daemon returned HTTP ${response.status}.`);
      error.code = value?.error?.code || 'DAEMON_ERROR';
      error.status = response.status;
      throw error;
    }
    return value;
  }

  health() {
    return this.request('/health', { authenticated: false });
  }

  listSessions() {
    return this.request('/v1/sessions');
  }

  readScreen(sessionId) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/screen`);
  }

  submitJob(sessionId, body) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/jobs`, { method: 'POST', body });
  }

  getJob(jobId) {
    return this.request(`/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  async waitForJob(jobId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const job = await this.getJob(jobId);
      if (['completed', 'failed'].includes(job.status)) return job;
      await delay(100);
    }
    return { ...(await this.getJob(jobId)), waitTimedOut: true };
  }

  async resolveSessionId(requestedId) {
    if (requestedId) return requestedId;
    const { sessions } = await this.listSessions();
    const online = sessions.filter((session) => session.online);
    if (online.length === 1) return online[0].id;
    if (online.length === 0) throw new Error('No online Xshell bridge session was found.');
    throw new Error('More than one Xshell session is online; pass session_id explicitly.');
  }
}

export function requireCompatibleDaemon(health) {
  if (health?.version === REQUIRED_DAEMON_VERSION) return;
  const error = new Error(
    `The running Xshell bridge daemon is version ${health?.version || 'unknown'}, but this client requires ${REQUIRED_DAEMON_VERSION}. Stop the old daemon and restart the Agent client.`,
  );
  error.code = 'DAEMON_VERSION_MISMATCH';
  throw error;
}

export async function connectToDaemon({ autoStart = true } = {}) {
  const config = await loadConfig();
  const client = new DaemonClient(config);
  try {
    requireCompatibleDaemon(await client.health());
    return client;
  } catch (firstError) {
    if (firstError.code === 'DAEMON_VERSION_MISMATCH') throw firstError;
    if (!autoStart) throw firstError;
  }

  const child = spawn(process.execPath, [resolve(DAEMON_ENTRY)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    try {
      requireCompatibleDaemon(await client.health());
      return client;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to start the Xshell bridge daemon: ${lastError?.message || 'unknown error'}`);
}
