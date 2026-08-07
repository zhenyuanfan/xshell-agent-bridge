import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError, XshellBridgeCore } from '../src/core.mjs';

const approvalMetadata = {
  approvalMode: 'xshell-dialog-v1',
  commandPolicyMode: 'agent-destructive-block-v1',
};
const sendAction = (text, enter = true) => ({
  type: 'send',
  text,
  enter,
  explanation: `Run ${text} for this test.`,
  expectedOutcome: 'The test command is accepted.',
  riskLevel: 'low',
});
const interruptAction = () => ({
  type: 'interrupt',
  explanation: 'Stop the test command.',
  expectedOutcome: 'The test command stops.',
  riskLevel: 'low',
});

test('registers sessions and versions changed screens', () => {
  let now = 1_000;
  const core = new XshellBridgeCore({ now: () => now, staleSessionMs: 500 });
  const session = core.register({ bridgeId: 'one', metadata: { ...approvalMetadata, remoteAddress: 'host' }, screen: '$ ' });
  assert.equal(session.online, true);
  assert.equal(core.getScreen('one').screenVersion, 1);

  now += 100;
  core.heartbeat('one', { screen: '$ echo hi' });
  assert.equal(core.getScreen('one').screenVersion, 2);

  now += 501;
  assert.equal(core.listSessions()[0].online, false);
});

test('serializes writes and never redelivers an active write', () => {
  let now = 10_000;
  const core = new XshellBridgeCore({ now: () => now });
  core.register({ bridgeId: 'one', metadata: approvalMetadata });
  const first = core.submitJob('one', { agentId: 'codex', action: sendAction('one') });
  const second = core.submitJob('one', { agentId: 'kimi', action: sendAction('two') });

  assert.equal(core.nextJob('one').id, first.id);
  assert.equal(core.nextJob('one'), null);
  core.completeJob('one', first.id, { ok: true });
  assert.equal(core.nextJob('one').id, second.id);
});

test('times out an unacknowledged write without retrying it', () => {
  let now = 5_000;
  const core = new XshellBridgeCore({ now: () => now, jobTimeoutMs: 100 });
  core.register({ bridgeId: 'one', metadata: approvalMetadata });
  const job = core.submitJob('one', { action: interruptAction() });
  core.nextJob('one');
  now += 101;
  assert.equal(core.nextJob('one'), null);
  assert.equal(core.getJob(job.id).status, 'failed');
  assert.match(core.getJob(job.id).error, /not retried/i);
});

test('rejects stale sessions and oversized input', () => {
  let now = 0;
  const core = new XshellBridgeCore({ now: () => now, staleSessionMs: 10, maxSendChars: 3 });
  core.register({ bridgeId: 'one', metadata: approvalMetadata });
  assert.throws(
    () => core.submitJob('one', { action: sendAction('long') }),
    (error) => error instanceof BridgeError && error.code === 'INPUT_TOO_LARGE',
  );
  now = 11;
  assert.throws(
    () => core.submitJob('one', { action: interruptAction() }),
    (error) => error.code === 'SESSION_OFFLINE',
  );
});

test('audit records omit terminal text', () => {
  const events = [];
  const core = new XshellBridgeCore({ audit: (event) => events.push(event) });
  core.register({ bridgeId: 'one', metadata: approvalMetadata });
  core.submitJob('one', { action: sendAction('secret command') });
  const queued = events.find((event) => event.type === 'job.queued');
  assert.deepEqual(queued.action, {
    type: 'send',
    enter: true,
    textLength: 14,
    explanationLength: 33,
    expectedOutcomeLength: 29,
    riskLevel: 'low',
  });
  assert.doesNotMatch(JSON.stringify(queued), /secret command/);
});

test('rejects writes from a legacy bridge without local approval capability', () => {
  const core = new XshellBridgeCore();
  core.register({ bridgeId: 'legacy', metadata: { transport: 'file-v1' } });
  assert.throws(
    () => core.submitJob('legacy', { action: sendAction('pwd') }),
    (error) => error instanceof BridgeError && error.code === 'APPROVAL_UNAVAILABLE',
  );
});

test('rejects writes when the Xshell script lacks the enterprise command policy', () => {
  const core = new XshellBridgeCore();
  core.register({ bridgeId: 'approval-only', metadata: { approvalMode: 'xshell-dialog-v1' } });
  assert.throws(
    () => core.submitJob('approval-only', { action: sendAction('pwd') }),
    (error) => error instanceof BridgeError && error.code === 'COMMAND_POLICY_UNAVAILABLE',
  );
});

test('requires an explanation, expected outcome, and risk level for every write', () => {
  const core = new XshellBridgeCore();
  core.register({ bridgeId: 'one', metadata: approvalMetadata });
  assert.throws(
    () => core.submitJob('one', { action: { type: 'send', text: 'pwd', enter: true } }),
    (error) => error instanceof BridgeError && error.code === 'EXPLANATION_REQUIRED',
  );
  assert.throws(
    () => core.submitJob('one', {
      action: { ...sendAction('pwd'), riskLevel: 'unknown' },
    }),
    (error) => error instanceof BridgeError && error.code === 'RISK_LEVEL_REQUIRED',
  );
});

test('requires the user to type credentials directly at sensitive prompts', () => {
  const core = new XshellBridgeCore();
  core.register({
    bridgeId: 'one',
    metadata: approvalMetadata,
    screen: '[sudo] password for root: ',
  });
  assert.throws(
    () => core.submitJob('one', { action: sendAction('not-a-real-password') }),
    (error) => error instanceof BridgeError && error.code === 'SENSITIVE_PROMPT_REQUIRES_USER_INPUT',
  );
  assert.equal(core.listSessions()[0].queuedWrites, 0);
});

test('blocks common inline credential patterns before they reach Xshell', () => {
  const blockedInputs = [
    'sshpass -p secret ssh server',
    'mysql -uroot -psecret',
    'curl -u user:secret https://example.test',
    'TOKEN=secret deploy-command',
    'sudo -S systemctl restart app',
    'docker login --password-stdin',
  ];
  for (const [index, text] of blockedInputs.entries()) {
    const core = new XshellBridgeCore();
    core.register({ bridgeId: `session-${index}`, metadata: approvalMetadata, screen: '$ ' });
    assert.throws(
      () => core.submitJob(`session-${index}`, { action: sendAction(text) }),
      (error) => error instanceof BridgeError && error.code === 'SENSITIVE_INPUT_BLOCKED',
    );
  }
});

test('does not block ordinary commands that only mention the word password', () => {
  const core = new XshellBridgeCore();
  core.register({ bridgeId: 'one', metadata: approvalMetadata, screen: '$ ' });
  assert.doesNotThrow(
    () => core.submitJob('one', { action: sendAction("grep -n password /etc/login.defs") }),
  );
});

test('hard-blocks destructive Agent commands before they enter the queue', () => {
  const blockedInputs = [
    'rm -f /tmp/app.jar',
    'sudo /usr/bin/rm -rf /var/lib/app',
    'find /opt/app -type f -delete',
    'python -c "import shutil; shutil.rmtree(\'/tmp/app\')"',
    'docker system prune -af',
    'docker compose down -v',
    'kubectl delete namespace production',
    'mysql -e "DROP TABLE users"',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'apt-get purge nginx',
    'git reset --hard HEAD~1',
    'shutdown -h now',
    'iptables -F',
  ];
  for (const [index, text] of blockedInputs.entries()) {
    const core = new XshellBridgeCore();
    core.register({ bridgeId: `destructive-${index}`, metadata: approvalMetadata, screen: '$ ' });
    assert.throws(
      () => core.submitJob(`destructive-${index}`, { action: sendAction(text) }),
      (error) => error instanceof BridgeError && error.code === 'DESTRUCTIVE_COMMAND_BLOCKED',
      text,
    );
    assert.equal(core.listSessions()[0].queuedWrites, 0);
  }
});

test('allows non-destructive deployment and inspection commands', () => {
  const allowedInputs = [
    'docker run --rm eclipse-temurin:8-jdk java -version',
    'docker ps -a',
    'systemctl status docker',
    'find /opt/app -type f -maxdepth 2',
    'git status --short',
  ];
  for (const [index, text] of allowedInputs.entries()) {
    const core = new XshellBridgeCore();
    core.register({ bridgeId: `allowed-${index}`, metadata: approvalMetadata, screen: '$ ' });
    assert.doesNotThrow(() => core.submitJob(`allowed-${index}`, { action: sendAction(text) }), text);
  }
});
