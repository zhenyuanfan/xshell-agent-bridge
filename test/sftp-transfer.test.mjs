import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SftpDownloadManager, SftpUploadManager } from '../src/sftp-transfer.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'xshell-sftp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const downloadDir = resolve(root, 'downloads');
  const stateDir = resolve(root, 'state');
  const scriptPath = resolve(root, 'download.ps1');
  const scpPath = resolve(root, 'scp.exe');
  await Promise.all([
    mkdir(downloadDir),
    writeFile(scriptPath, '# test'),
    writeFile(scpPath, 'test'),
  ]);
  const launches = [];
  const manager = new SftpDownloadManager({
    downloadDir,
    stateDir,
    scriptPath,
    scpPath,
    launcher: async (...args) => launches.push(args),
    now: () => '2026-08-07T00:00:00.000Z',
  });
  return { root, downloadDir, stateDir, scriptPath, scpPath, manager, launches };
}

async function uploadFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'xshell-sftp-upload-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const downloadDir = resolve(root, 'downloads');
  const stateDir = resolve(root, 'state');
  const scriptPath = resolve(root, 'upload.ps1');
  const scpPath = resolve(root, 'scp.exe');
  const sshPath = resolve(root, 'ssh.exe');
  await Promise.all([
    mkdir(downloadDir),
    writeFile(scriptPath, '# test'),
    writeFile(scpPath, 'test'),
    writeFile(sshPath, 'test'),
  ]);
  const launches = [];
  const manager = new SftpUploadManager({
    downloadDir,
    stateDir,
    scriptPath,
    scpPath,
    sshPath,
    launcher: async (...args) => launches.push(args),
    now: () => '2026-08-07T00:00:00.000Z',
  });
  return { root, downloadDir, stateDir, scriptPath, scpPath, sshPath, manager, launches };
}

function request(overrides = {}) {
  return {
    host: '10.0.0.8',
    port: 22,
    username: 'deploy',
    remote_path: '/opt/packages/app.jar',
    local_name: 'app.jar',
    explanation: '把已经准备好的部署包下载到本机中转目录。',
    expected_outcome: '本地生成经过确认的 app.jar。',
    risk_level: 'low',
    ...overrides,
  };
}

test('creates an approved download plan without credentials', async (t) => {
  const { manager, launches, stateDir, downloadDir } = await fixture(t);
  const started = await manager.startDownload(request({ expected_sha256: 'a'.repeat(64) }));
  assert.equal(started.status, 'awaiting_user');
  assert.equal(launches.length, 1);

  const specPath = launches[0][1];
  const specText = await readFile(specPath, 'utf8');
  const spec = JSON.parse(specText);
  assert.equal(spec.remoteSource, 'deploy@10.0.0.8:/opt/packages/app.jar');
  assert.equal(spec.finalPath, resolve(downloadDir, 'app.jar'));
  assert.match(spec.partPath, /\.part$/);
  assert.equal(spec.expectedSha256, 'a'.repeat(64));
  assert.equal(specText.includes('secret-value'), false);

  const status = await manager.getStatus(started.transfer_id);
  assert.equal(status.stage, 'desktop_launch');
  assert.equal(status.remote.path, '/opt/packages/app.jar');
  assert.equal(resolve(stateDir, started.transfer_id), resolve(specPath, '..'));
});

test('queues a credential-free desktop launch request for Xshell', async (t) => {
  const { root, downloadDir, stateDir, scriptPath, scpPath } = await fixture(t);
  const desktopLaunchDir = resolve(root, 'desktop-launch');
  const manager = new SftpDownloadManager({
    downloadDir,
    stateDir,
    desktopLaunchDir,
    scriptPath,
    scpPath,
    now: () => '2026-08-07T00:00:00.000Z',
  });
  const started = await manager.startDownload(request({ local_name: 'queued.jar' }));
  const requestPath = resolve(desktopLaunchDir, `${started.transfer_id}.request.json`);
  const queued = JSON.parse(await readFile(requestPath, 'utf8'));
  const command = await readFile(resolve(stateDir, started.transfer_id, 'launch.cmd'), 'utf8');

  assert.equal(started.stage, 'desktop_launch');
  assert.equal(queued.protocol, 'xshell-agent-desktop-launch-v1');
  assert.equal(queued.transferId, started.transfer_id);
  assert.match(command, /chcp 65001/);
  assert.match(command, /launch-scp-download\.ps1/);
  assert.match(command, /download\.ps1/);
  assert.equal(command.includes('secret-value'), false);
});

test('blocks credential fields and unsafe destination names', async (t) => {
  const { manager } = await fixture(t);
  await assert.rejects(
    manager.startDownload(request({ password: 'secret-value' })),
    (error) => error.code === 'CREDENTIAL_FIELD_BLOCKED',
  );
  await assert.rejects(
    manager.startDownload(request({ local_name: '..\\outside.jar' })),
    (error) => error.code === 'INVALID_LOCAL_NAME',
  );
  await assert.rejects(
    manager.startDownload(request({ remote_path: '/opt/app.jar;touch /tmp/injected' })),
    (error) => error.code === 'INVALID_REMOTE_PATH',
  );
  await assert.rejects(
    manager.startDownload(request({ remote_path: 'relative/app.jar' })),
    (error) => error.code === 'INVALID_REMOTE_PATH',
  );
});

test('refuses to overwrite an existing local file', async (t) => {
  const { manager, downloadDir } = await fixture(t);
  await writeFile(resolve(downloadDir, 'app.jar'), 'existing');
  await assert.rejects(
    manager.startDownload(request()),
    (error) => error.code === 'LOCAL_FILE_EXISTS',
  );
});

test('creates a no-overwrite upload plan from the downloads directory', async (t) => {
  const { manager, launches, downloadDir } = await uploadFixture(t);
  await writeFile(resolve(downloadDir, 'app.jar'), 'upload-content', 'utf8');

  const started = await manager.startUpload(request({
    explanation: '把已检查的部署包上传到服务器临时目录。',
    expected_outcome: '服务器生成经过哈希校验的 app.jar。',
  }));
  assert.equal(started.status, 'awaiting_user');
  assert.equal(started.size, 14);
  assert.match(started.sha256, /^[a-f0-9]{64}$/);
  assert.equal(launches.length, 1);

  const specText = await readFile(launches[0][1], 'utf8');
  const spec = JSON.parse(specText);
  assert.equal(spec.protocol, 'xshell-agent-secure-upload-v1');
  assert.equal(spec.direction, 'upload');
  assert.equal(spec.localPath, resolve(downloadDir, 'app.jar'));
  assert.equal(spec.remoteTarget, 'deploy@10.0.0.8');
  assert.match(spec.remotePartPath, /^\/opt\/packages\/app\.jar\.[a-f0-9-]{36}\.part$/);
  assert.equal(spec.remoteDestination, `${spec.remoteTarget}:${spec.remotePartPath}`);
  assert.match(spec.remoteFinalizeCommand, /test ! -e '\/opt\/packages\/app\.jar'/);
  assert.match(spec.remoteFinalizeCommand, /sha256sum --/);
  assert.match(spec.remoteFinalizeCommand, /mv -n --/);
  assert.match(spec.remoteFinalizeCommand, /test ! -e '\/opt\/packages\/app\.jar\.[a-f0-9-]{36}\.part'/);
  assert.equal(specText.includes('secret-value'), false);

  const status = await manager.getStatus(started.transfer_id);
  assert.equal(status.direction, 'upload');
  assert.equal(status.remote.path, '/opt/packages/app.jar');
  assert.equal(status.local_path, resolve(downloadDir, 'app.jar'));
});

test('upload refuses credential fields and missing local files', async (t) => {
  const { manager } = await uploadFixture(t);
  await assert.rejects(
    manager.startUpload(request({ password: 'secret-value' })),
    (error) => error.code === 'CREDENTIAL_FIELD_BLOCKED',
  );
  await assert.rejects(
    manager.startUpload(request()),
    (error) => error.code === 'LOCAL_FILE_NOT_FOUND',
  );
});

test('reads a completed PowerShell result written with a UTF-8 BOM', async (t) => {
  const { manager, launches } = await fixture(t);
  const started = await manager.startDownload(request());
  const spec = JSON.parse(await readFile(launches[0][1], 'utf8'));
  const result = {
    transferId: started.transfer_id,
    status: 'completed',
    stage: 'completed',
    size: 123,
    sha256: 'b'.repeat(64),
    localPath: spec.finalPath,
    updatedAt: '2026-08-07T00:01:00.000Z',
  };
  await writeFile(spec.resultPath, `\uFEFF${JSON.stringify(result)}`, 'utf8');
  const status = await manager.getStatus(started.transfer_id);
  assert.equal(status.status, 'completed');
  assert.equal(status.size, 123);
  assert.equal(status.sha256, 'b'.repeat(64));
});

test('watcher records cancellation when the interactive window disappears', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'xshell-sftp-watcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specPath = resolve(root, 'spec.json');
  const resultPath = resolve(root, 'result.json');
  await writeFile(specPath, JSON.stringify({
    transferId: 'watcher-test',
    resultPath,
    partPath: resolve(root, 'file.part'),
    texts: { windowClosed: '窗口已关闭。' },
  }), 'utf8');

  const watcherPath = fileURLToPath(new URL('../scripts/watch-scp-download.ps1', import.meta.url));
  await new Promise((resolveRun, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      watcherPath,
      '-RunnerId',
      '2147483000',
      '-SpecPath',
      specPath,
    ], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`watcher exited with ${code}`));
    });
  });

  const result = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stage, 'window_closed');
  assert.equal(result.error, '窗口已关闭。');
});
