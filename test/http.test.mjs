import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createDaemon } from '../src/daemon.mjs';

test('HTTP bridge completes a queued write end to end', async (t) => {
  const config = {
    server: { host: '127.0.0.1', port: 0, token: 'a'.repeat(32) },
    safety: { staleSessionMs: 5_000, jobTimeoutMs: 1_000, maxSendChars: 100 },
    bridge: { pollIntervalMs: 10 },
  };
  const { server } = await createDaemon({ config, listen: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const headers = { authorization: `Bearer ${config.server.token}`, 'content-type': 'application/json' };
  const call = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, ...options });
    const text = await response.text();
    return { status: response.status, value: text ? JSON.parse(text) : null };
  };

  assert.equal((await call('/bridge/register', {
    method: 'POST',
    body: JSON.stringify({
      bridgeId: 'test-session',
      screen: '$ ',
      metadata: { approvalMode: 'xshell-dialog-v1', commandPolicyMode: 'agent-destructive-block-v1' },
    }),
  })).status, 201);
  const queued = await call('/v1/sessions/test-session/jobs', {
    method: 'POST',
    body: JSON.stringify({
      agentId: 'test',
      action: {
        type: 'send',
        text: 'pwd',
        enter: true,
        explanation: 'Show the current directory.',
        expectedOutcome: 'The current path is printed.',
        riskLevel: 'low',
      },
    }),
  });
  assert.equal(queued.status, 202);

  const delivered = await call('/bridge/sessions/test-session/next');
  assert.equal(delivered.value.id, queued.value.id);
  await call(`/bridge/sessions/test-session/jobs/${delivered.value.id}`, {
    method: 'POST',
    body: JSON.stringify({ ok: true, result: { acceptedByXshell: true, approvedByUser: true } }),
  });
  const completed = await call(`/v1/jobs/${queued.value.id}`);
  assert.equal(completed.value.status, 'completed');
});

test('HTTP API rejects missing authentication', async (t) => {
  const config = {
    server: { host: '127.0.0.1', port: 0, token: 'b'.repeat(32) },
    safety: {},
    bridge: {},
  };
  const { server } = await createDaemon({ config, listen: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/sessions`);
  assert.equal(response.status, 401);
});
