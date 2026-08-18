import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { cleanRuntimeData } from '../src/runtime-retention.mjs';

test('removes expired runtime state but preserves downloads and recent transfer state', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'xshell-retention-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldIpc = resolve(root, 'ipc', 'old-session');
  const oldTransfer = resolve(root, 'transfers', 'old-transfer');
  const recentTransfer = resolve(root, 'transfers', 'recent-transfer');
  const download = resolve(root, 'downloads', 'keep.part');
  await Promise.all([oldIpc, oldTransfer, recentTransfer, resolve(root, 'downloads')].map((path) => mkdir(path, { recursive: true })));
  await writeFile(download, 'keep');
  const oldDate = new Date(Date.now() - 10_000);
  await Promise.all([utimes(oldIpc, oldDate, oldDate), utimes(oldTransfer, oldDate, oldDate)]);

  const result = await cleanRuntimeData({ dataDir: root, retentionMs: 1_000 });
  assert.equal(result.ipc, 1);
  assert.equal(result.transfers, 1);
  await assert.rejects(() => stat(oldIpc), { code: 'ENOENT' });
  await assert.rejects(() => stat(oldTransfer), { code: 'ENOENT' });
  await Promise.all([stat(recentTransfer), stat(download)]);
});
