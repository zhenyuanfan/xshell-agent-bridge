import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'local.json');
export const DATA_DIR = resolve(PROJECT_ROOT, 'data');

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 32145,
  },
  safety: {
    maxSendChars: 8192,
    jobTimeoutMs: 120_000,
    staleSessionMs: 5_000,
  },
  bridge: {
    pollIntervalMs: 250,
  },
};

function mergeConfig(raw) {
  const safety = { ...DEFAULTS.safety, ...raw.safety };
  if (!Number.isFinite(safety.jobTimeoutMs)) safety.jobTimeoutMs = DEFAULTS.safety.jobTimeoutMs;
  safety.jobTimeoutMs = Math.max(DEFAULTS.safety.jobTimeoutMs, safety.jobTimeoutMs);
  return {
    server: { ...DEFAULTS.server, ...raw.server },
    safety,
    bridge: { ...DEFAULTS.bridge, ...raw.bridge },
  };
}

function validateConfig(config) {
  if (config.server.host !== '127.0.0.1' && config.server.host !== 'localhost') {
    throw new Error('The MVP daemon may only bind to localhost.');
  }
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    throw new Error('server.port must be an integer between 1 and 65535.');
  }
  if (typeof config.server.token !== 'string' || config.server.token.length < 32) {
    throw new Error('server.token must contain at least 32 characters.');
  }
  return config;
}

async function createLocalConfig() {
  await mkdir(dirname(LOCAL_CONFIG_PATH), { recursive: true });
  const initial = mergeConfig({
    server: { token: randomBytes(32).toString('hex') },
  });
  const handle = await open(LOCAL_CONFIG_PATH, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(initial, null, 2)}\n`, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
  return initial;
}

export async function loadConfig({ create = true } = {}) {
  let raw;
  try {
    raw = JSON.parse(await readFile(LOCAL_CONFIG_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && create) {
      try {
        return validateConfig(await createLocalConfig());
      } catch (createError) {
        if (createError.code !== 'EEXIST') throw createError;
        raw = JSON.parse(await readFile(LOCAL_CONFIG_PATH, 'utf8'));
      }
    } else {
      throw error;
    }
  }
  return validateConfig(mergeConfig(raw));
}

export function projectRoot() {
  return PROJECT_ROOT;
}
