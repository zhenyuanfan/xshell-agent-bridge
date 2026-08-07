import { randomUUID } from 'node:crypto';

export class BridgeError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'BridgeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    sessionId: job.sessionId,
    agentId: job.agentId,
    action: job.action,
    status: job.status,
    createdAt: job.createdAt,
    deliveredAt: job.deliveredAt,
    completedAt: job.completedAt,
    result: job.result,
    error: job.error,
  };
}

function auditJob(job) {
  const action = job.action?.type === 'send'
    ? { type: 'send', enter: Boolean(job.action.enter), textLength: job.action.text.length }
    : { type: job.action?.type };
  return { ...publicJob(job), action };
}

export class XshellBridgeCore {
  constructor({ staleSessionMs = 5_000, jobTimeoutMs = 30_000, maxSendChars = 8_192, now = Date.now, audit = () => {} } = {}) {
    this.staleSessionMs = staleSessionMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.maxSendChars = maxSendChars;
    this.now = now;
    this.audit = audit;
    this.sessions = new Map();
    this.jobs = new Map();
  }

  register({ bridgeId, metadata = {}, screen = '' } = {}) {
    const now = this.now();
    const id = bridgeId || randomUUID();
    const previous = this.sessions.get(id);
    const session = {
      id,
      metadata: { ...(previous?.metadata || {}), ...metadata },
      screen: String(screen ?? previous?.screen ?? ''),
      screenVersion: previous?.screenVersion || 1,
      registeredAt: previous?.registeredAt || now,
      lastSeenAt: now,
      queue: previous?.queue || [],
      activeJobId: previous?.activeJobId || null,
    };
    if (previous && session.screen !== previous.screen) session.screenVersion += 1;
    this.sessions.set(id, session);
    this.audit({ type: 'session.registered', sessionId: id, metadata: session.metadata });
    return this.describeSession(session);
  }

  heartbeat(id, { metadata = {}, screen } = {}) {
    const session = this.requireSession(id);
    if (screen !== undefined && String(screen) !== session.screen) {
      session.screen = String(screen);
      session.screenVersion += 1;
    }
    session.metadata = { ...session.metadata, ...metadata };
    session.lastSeenAt = this.now();
    this.expireActiveJob(session);
    return this.describeSession(session);
  }

  listSessions() {
    return [...this.sessions.values()]
      .map((session) => this.describeSession(session))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  getScreen(id) {
    const session = this.requireSession(id);
    return {
      sessionId: id,
      screen: session.screen,
      screenVersion: session.screenVersion,
      capturedAt: session.lastSeenAt,
      stale: !this.isOnline(session),
    };
  }

  submitJob(id, { agentId = 'unknown-agent', action } = {}) {
    const session = this.requireSession(id);
    if (!this.isOnline(session)) {
      throw new BridgeError('The Xshell bridge is offline or stale.', 409, 'SESSION_OFFLINE');
    }
    this.validateAction(action);
    const now = this.now();
    const job = {
      id: randomUUID(),
      sessionId: id,
      agentId: String(agentId).slice(0, 128),
      action: structuredClone(action),
      status: 'queued',
      createdAt: now,
      deliveredAt: null,
      completedAt: null,
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    session.queue.push(job.id);
    this.audit({ type: 'job.queued', ...auditJob(job) });
    return publicJob(job);
  }

  nextJob(id) {
    const session = this.requireSession(id);
    session.lastSeenAt = this.now();
    this.expireActiveJob(session);
    if (session.activeJobId) return null;

    while (session.queue.length > 0) {
      const job = this.jobs.get(session.queue.shift());
      if (!job || job.status !== 'queued') continue;
      job.status = 'delivered';
      job.deliveredAt = this.now();
      session.activeJobId = job.id;
      this.audit({ type: 'job.delivered', ...auditJob(job) });
      return publicJob(job);
    }
    return null;
  }

  completeJob(id, jobId, { ok = true, result = null, error = null } = {}) {
    const session = this.requireSession(id);
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== id) {
      throw new BridgeError('Unknown job for this session.', 404, 'JOB_NOT_FOUND');
    }
    if (job.status !== 'delivered') {
      throw new BridgeError(`Job cannot complete from status ${job.status}.`, 409, 'INVALID_JOB_STATE');
    }
    job.status = ok ? 'completed' : 'failed';
    job.completedAt = this.now();
    job.result = ok ? result : null;
    job.error = ok ? null : String(error || 'Xshell bridge action failed.');
    if (session.activeJobId === job.id) session.activeJobId = null;
    this.audit({ type: ok ? 'job.completed' : 'job.failed', ...auditJob(job) });
    return publicJob(job);
  }

  recoverDeliveredJob(id, snapshot) {
    const session = this.requireSession(id);
    if (!snapshot?.id || snapshot.sessionId !== id) {
      throw new BridgeError('Invalid recovered job snapshot.', 400, 'INVALID_JOB_SNAPSHOT');
    }
    if (this.jobs.has(snapshot.id)) return publicJob(this.jobs.get(snapshot.id));
    this.validateAction(snapshot.action);
    const job = {
      id: snapshot.id,
      sessionId: id,
      agentId: String(snapshot.agentId || 'recovered-agent').slice(0, 128),
      action: structuredClone(snapshot.action),
      status: 'delivered',
      createdAt: Number(snapshot.createdAt) || this.now(),
      deliveredAt: Number(snapshot.deliveredAt) || this.now(),
      completedAt: null,
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    session.activeJobId = job.id;
    this.audit({ type: 'job.recovered_uncertain', ...auditJob(job) });
    return publicJob(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new BridgeError('Unknown job.', 404, 'JOB_NOT_FOUND');
    return publicJob(job);
  }

  describeSession(session) {
    return {
      id: session.id,
      metadata: session.metadata,
      online: this.isOnline(session),
      registeredAt: session.registeredAt,
      lastSeenAt: session.lastSeenAt,
      screenVersion: session.screenVersion,
      queuedWrites: session.queue.length,
      activeJobId: session.activeJobId,
    };
  }

  requireSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new BridgeError('Unknown Xshell session.', 404, 'SESSION_NOT_FOUND');
    return session;
  }

  isOnline(session) {
    return this.now() - session.lastSeenAt <= this.staleSessionMs;
  }

  expireActiveJob(session) {
    if (!session.activeJobId) return;
    const job = this.jobs.get(session.activeJobId);
    if (!job || job.status !== 'delivered') {
      session.activeJobId = null;
      return;
    }
    if (this.now() - job.deliveredAt <= this.jobTimeoutMs) return;
    job.status = 'failed';
    job.completedAt = this.now();
    job.error = 'The Xshell bridge did not acknowledge the action before its deadline. It was not retried to avoid duplicate input.';
    session.activeJobId = null;
    this.audit({ type: 'job.timed_out', ...auditJob(job) });
  }

  validateAction(action) {
    if (!action || typeof action !== 'object') {
      throw new BridgeError('action must be an object.');
    }
    if (action.type === 'send') {
      if (typeof action.text !== 'string') throw new BridgeError('send.text must be a string.');
      if (action.text.length > this.maxSendChars) {
        throw new BridgeError(`send.text exceeds the ${this.maxSendChars} character limit.`, 413, 'INPUT_TOO_LARGE');
      }
      if (action.text.includes('\u0000')) throw new BridgeError('send.text may not contain NUL bytes.');
      if (action.enter !== undefined && typeof action.enter !== 'boolean') {
        throw new BridgeError('send.enter must be boolean.');
      }
      return;
    }
    if (action.type === 'interrupt') return;
    throw new BridgeError(`Unsupported action type: ${action.type}`, 400, 'UNSUPPORTED_ACTION');
  }
}
