import { randomUUID } from 'node:crypto';

export const REQUIRED_APPROVAL_MODE = 'xshell-dialog-v1';
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const SENSITIVE_PROMPT_PATTERN = /(?:password|passphrase|密码|口令|验证码|verification(?:\s+code)?|one[- ]time(?:\s+password)?|otp|pin|authentication\s+code|api\s*key|token)[^\r\n]{0,160}[:：?]\s*$/i;
const SENSITIVE_INPUT_PATTERNS = [
  /\bsshpass\b/i,
  /\bsudo\b[^\r\n]*\s-S(?:\s|$)/i,
  /--password-stdin\b/i,
  /(?:^|\s)--?(?:password|passwd|passphrase|token|secret|api[-_]?key)(?:=|\s+)\S+/i,
  /(?:^|\s)(?:PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|API_KEY)\s*=\s*\S+/i,
  /\b(?:mysql|mariadb)\b[^\r\n]*\s-p(?!\s|$)\S+/i,
  /:\/\/[^/\s:@]+:[^@\s/]+@/,
  /(?:^|\s)-u\s+[^\s:]+:[^\s]+/i,
];

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
    ? {
        type: 'send',
        enter: Boolean(job.action.enter),
        textLength: job.action.text.length,
        explanationLength: job.action.explanation.length,
        expectedOutcomeLength: job.action.expectedOutcome.length,
        riskLevel: job.action.riskLevel,
      }
    : {
        type: job.action?.type,
        explanationLength: job.action?.explanation?.length,
        expectedOutcomeLength: job.action?.expectedOutcome?.length,
        riskLevel: job.action?.riskLevel,
      };
  return { ...publicJob(job), action };
}

export class XshellBridgeCore {
  constructor({ staleSessionMs = 5_000, jobTimeoutMs = 120_000, maxSendChars = 8_192, maxExplanationChars = 1_000, now = Date.now, audit = () => {} } = {}) {
    this.staleSessionMs = staleSessionMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.maxSendChars = maxSendChars;
    this.maxExplanationChars = maxExplanationChars;
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
    if (session.metadata.approvalMode !== REQUIRED_APPROVAL_MODE) {
      throw new BridgeError(
        'This Xshell tab is not running the v2 bridge with local user approval. Restart the updated Xshell script.',
        409,
        'APPROVAL_UNAVAILABLE',
      );
    }
    this.validateAction(action);
    if (action.type === 'send') this.validateSensitiveInput(session, action.text);
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
    this.validateApprovalDetails(action);
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

  validateApprovalDetails(action) {
    for (const field of ['explanation', 'expectedOutcome']) {
      if (typeof action[field] !== 'string' || action[field].trim().length === 0) {
        throw new BridgeError(`action.${field} must explain the proposed operation to the user.`, 400, 'EXPLANATION_REQUIRED');
      }
      if (action[field].length > this.maxExplanationChars) {
        throw new BridgeError(`action.${field} exceeds the ${this.maxExplanationChars} character limit.`, 413, 'INPUT_TOO_LARGE');
      }
    }
    if (!RISK_LEVELS.has(action.riskLevel)) {
      throw new BridgeError('action.riskLevel must be one of: low, medium, high, critical.', 400, 'RISK_LEVEL_REQUIRED');
    }
  }

  validateSensitiveInput(session, text) {
    const visibleTail = String(session.screen || '').trimEnd().split(/\r?\n/).slice(-3).join('\n');
    if (SENSITIVE_PROMPT_PATTERN.test(visibleTail)) {
      throw new BridgeError(
        '检测到密码、口令或验证码输入提示。为保护凭据，Agent 不得发送内容；请用户直接在 Xshell 中手动输入。',
        409,
        'SENSITIVE_PROMPT_REQUIRES_USER_INPUT',
      );
    }
    if (SENSITIVE_INPUT_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new BridgeError(
        '输入内容疑似包含密码、Token、API Key 或自动填密参数。桥接程序已拒绝发送，请由用户在 Xshell 中手动输入敏感信息。',
        400,
        'SENSITIVE_INPUT_BLOCKED',
      );
    }
  }
}
