import { readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

async function removeExpiredChildren(directory, maximumAgeMs, now) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    const target = resolve(directory, entry.name);
    const details = await stat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!details || now - details.mtimeMs <= maximumAgeMs) continue;
    await rm(target, { recursive: entry.isDirectory(), force: true });
    removed += 1;
  }
  return removed;
}

// Runtime IPC contains short-lived screen snapshots and transfer manifests. It
// deliberately never touches downloads/, including .part files: those require
// an explicit human decision after a transfer failure or rejection.
export async function cleanRuntimeData({ dataDir, retentionMs, now = Date.now() }) {
  const [ipc, desktopLaunch, transfers] = await Promise.all([
    removeExpiredChildren(resolve(dataDir, 'ipc'), retentionMs, now),
    removeExpiredChildren(resolve(dataDir, 'desktop-launch'), retentionMs, now),
    removeExpiredChildren(resolve(dataDir, 'transfers'), retentionMs, now),
  ]);
  return { ipc, desktopLaunch, transfers, total: ipc + desktopLaunch + transfers };
}
