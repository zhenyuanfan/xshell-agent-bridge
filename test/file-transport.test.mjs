import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { XshellBridgeCore } from '../src/core.mjs';
import { FileBridgeTransport } from '../src/file-transport.mjs';

test('file transport discovers a bridge and completes a write', async (t) => {
  const ipcDir = await mkdtemp(resolve(tmpdir(), 'xshell-agent-test-'));
  t.after(() => rm(ipcDir, { recursive: true, force: true }));
  const sessionDir = resolve(ipcDir, 'local-one');
  await mkdir(sessionDir);
  const state = {
    protocol: 'xshell-agent-file-v2',
    sessionId: 'local-one',
    metadata: { connected: true, approvalMode: 'xshell-dialog-v1' },
    screen: 'C:\\> ',
  };
  await writeFile(resolve(sessionDir, 'state.json'), JSON.stringify(state));

  const core = new XshellBridgeCore({ staleSessionMs: 5_000 });
  const transport = new FileBridgeTransport({ core, ipcDir, staleSessionMs: 5_000 });
  await transport.scan();
  assert.equal(core.getScreen('local-one').screen, 'C:\\> ');

  const job = core.submitJob('local-one', {
    agentId: 'codex',
    action: {
      type: 'send',
      text: 'echo ok',
      enter: true,
      explanation: '打印一行中文测试说明。',
      expectedOutcome: '终端显示 ok，然后返回提示符。',
      riskLevel: 'low',
    },
  });
  await transport.scan();
  const commandPath = resolve(sessionDir, 'command.json');
  const command = JSON.parse(await readFile(commandPath, 'utf8'));
  assert.equal(command.id, job.id);
  assert.equal(command.action.explanation, '打印一行中文测试说明。');
  assert.equal(command.action.expectedOutcome, '终端显示 ok，然后返回提示符。');

  await rename(commandPath, resolve(sessionDir, 'command.active.json'));
  await writeFile(resolve(sessionDir, 'result.json'), JSON.stringify({
    jobId: job.id,
    ok: true,
    result: { acceptedByXshell: true },
  }));
  await transport.scan();
  assert.equal(core.getJob(job.id).status, 'completed');
});

test('file transport recovers an uncertain active write without replaying it', async (t) => {
  const ipcDir = await mkdtemp(resolve(tmpdir(), 'xshell-agent-recovery-'));
  t.after(() => rm(ipcDir, { recursive: true, force: true }));
  const sessionDir = resolve(ipcDir, 'recovered-one');
  await mkdir(sessionDir);
  await writeFile(resolve(sessionDir, 'state.json'), JSON.stringify({
    protocol: 'xshell-agent-file-v2',
    sessionId: 'recovered-one',
    metadata: { approvalMode: 'xshell-dialog-v1' },
    screen: '$ ',
  }));
  const uncertain = {
    id: 'uncertain-job',
    sessionId: 'recovered-one',
    agentId: 'kimi',
    action: {
      type: 'send',
      text: 'do-not-replay',
      enter: true,
      explanation: 'Exercise crash recovery.',
      expectedOutcome: 'The command is not replayed.',
      riskLevel: 'low',
    },
    createdAt: Date.now(),
    deliveredAt: Date.now(),
  };
  const activePath = resolve(sessionDir, 'command.active.json');
  await writeFile(activePath, JSON.stringify(uncertain));

  const core = new XshellBridgeCore();
  const transport = new FileBridgeTransport({ core, ipcDir, staleSessionMs: 5_000 });
  await transport.scan();
  assert.equal(core.getJob('uncertain-job').status, 'delivered');
  assert.equal(core.listSessions()[0].activeJobId, 'uncertain-job');
  assert.equal(await readFile(activePath, 'utf8'), JSON.stringify(uncertain));
});

test('discovers a v1 bridge as read-only and refuses to deliver writes', async (t) => {
  const ipcDir = await mkdtemp(resolve(tmpdir(), 'xshell-agent-legacy-'));
  t.after(() => rm(ipcDir, { recursive: true, force: true }));
  const sessionDir = resolve(ipcDir, 'legacy-one');
  await mkdir(sessionDir);
  await writeFile(resolve(sessionDir, 'state.json'), JSON.stringify({
    protocol: 'xshell-agent-file-v1',
    sessionId: 'legacy-one',
    screen: '$ ',
  }));

  const core = new XshellBridgeCore({ staleSessionMs: 5_000 });
  const transport = new FileBridgeTransport({ core, ipcDir, staleSessionMs: 5_000 });
  await transport.scan();
  assert.equal(core.listSessions()[0].metadata.transport, 'file-v1-read-only');
  assert.throws(
    () => core.submitJob('legacy-one', {
      action: {
        type: 'send',
        text: 'pwd',
        enter: true,
        explanation: 'Show the current directory.',
        expectedOutcome: 'The path is printed.',
        riskLevel: 'low',
      },
    }),
    (error) => error.code === 'APPROVAL_UNAVAILABLE',
  );
});
