import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError, XshellBridgeCore } from '../src/core.mjs';

test('registers sessions and versions changed screens', () => {
  let now = 1_000;
  const core = new XshellBridgeCore({ now: () => now, staleSessionMs: 500 });
  const session = core.register({ bridgeId: 'one', metadata: { remoteAddress: 'host' }, screen: '$ ' });
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
  core.register({ bridgeId: 'one' });
  const first = core.submitJob('one', { agentId: 'codex', action: { type: 'send', text: 'one', enter: true } });
  const second = core.submitJob('one', { agentId: 'kimi', action: { type: 'send', text: 'two', enter: true } });

  assert.equal(core.nextJob('one').id, first.id);
  assert.equal(core.nextJob('one'), null);
  core.completeJob('one', first.id, { ok: true });
  assert.equal(core.nextJob('one').id, second.id);
});

test('times out an unacknowledged write without retrying it', () => {
  let now = 5_000;
  const core = new XshellBridgeCore({ now: () => now, jobTimeoutMs: 100 });
  core.register({ bridgeId: 'one' });
  const job = core.submitJob('one', { action: { type: 'interrupt' } });
  core.nextJob('one');
  now += 101;
  assert.equal(core.nextJob('one'), null);
  assert.equal(core.getJob(job.id).status, 'failed');
  assert.match(core.getJob(job.id).error, /not retried/i);
});

test('rejects stale sessions and oversized input', () => {
  let now = 0;
  const core = new XshellBridgeCore({ now: () => now, staleSessionMs: 10, maxSendChars: 3 });
  core.register({ bridgeId: 'one' });
  assert.throws(
    () => core.submitJob('one', { action: { type: 'send', text: 'long' } }),
    (error) => error instanceof BridgeError && error.code === 'INPUT_TOO_LARGE',
  );
  now = 11;
  assert.throws(
    () => core.submitJob('one', { action: { type: 'interrupt' } }),
    (error) => error.code === 'SESSION_OFFLINE',
  );
});

test('audit records omit terminal text', () => {
  const events = [];
  const core = new XshellBridgeCore({ audit: (event) => events.push(event) });
  core.register({ bridgeId: 'one' });
  core.submitJob('one', { action: { type: 'send', text: 'secret command', enter: true } });
  const queued = events.find((event) => event.type === 'job.queued');
  assert.deepEqual(queued.action, { type: 'send', enter: true, textLength: 14 });
  assert.doesNotMatch(JSON.stringify(queued), /secret command/);
});
