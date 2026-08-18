import { timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, XshellBridgeCore } from './core.mjs';
import { DATA_DIR, loadConfig } from './config.mjs';
import { FileBridgeTransport } from './file-transport.mjs';
import { cleanRuntimeData } from './runtime-retention.mjs';

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError('Request body is too large.', 413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError('Request body must be valid JSON.');
  }
}

function tokensMatch(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAuth(request, token) {
  const authorization = request.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const bridgeToken = request.headers['x-bridge-token'];
  if (!tokensMatch(bearer || bridgeToken, token)) {
    throw new BridgeError('Unauthorized.', 401, 'UNAUTHORIZED');
  }
}

export async function createDaemon({ config: providedConfig, listen = true } = {}) {
  const config = providedConfig || await loadConfig();
  await mkdir(DATA_DIR, { recursive: true });
  const auditPath = resolve(DATA_DIR, 'audit.jsonl');
  const audit = (event) => {
    const record = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    appendFile(auditPath, `${record}\n`, 'utf8').catch((error) => {
      process.stderr.write(`[xshell-bridge] audit write failed: ${error.message}\n`);
    });
  };
  const core = new XshellBridgeCore({ ...config.safety, audit });
  const fileTransport = new FileBridgeTransport({
    core,
    ipcDir: resolve(DATA_DIR, 'ipc'),
    pollIntervalMs: Math.min(config.bridge.pollIntervalMs ?? 250, 250),
    staleSessionMs: config.safety.staleSessionMs ?? 5_000,
    onError: (error) => process.stderr.write(`[xshell-bridge] file transport: ${error.message}\n`),
  });
  await fileTransport.start();
  const maintenanceTimer = setInterval(() => {
    core.sweep();
  }, 1_000);
  maintenanceTimer.unref();
  const cleanupRuntimeData = () => cleanRuntimeData({
    dataDir: DATA_DIR,
    retentionMs: config.safety.runtimeDataRetentionMs ?? 2_592_000_000,
  }).catch((error) => process.stderr.write(`[xshell-bridge] runtime cleanup failed: ${error.message}\n`));
  const cleanupTimer = setInterval(cleanupRuntimeData, 3_600_000);
  cleanupTimer.unref();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        const sessions = core.listSessions();
        sendJson(response, 200, {
          ok: true,
          service: 'xshell-agent-bridge',
          version: '0.4.0',
          onlineSessions: sessions.filter((session) => session.online).length,
          totalSessions: sessions.length,
        });
        return;
      }

      requireAuth(request, config.server.token);

      if (request.method === 'POST' && url.pathname === '/bridge/register') {
        sendJson(response, 201, core.register(await readJson(request)));
        return;
      }

      const bridgeHeartbeat = url.pathname.match(/^\/bridge\/sessions\/([^/]+)\/heartbeat$/);
      if (request.method === 'POST' && bridgeHeartbeat) {
        sendJson(response, 200, core.heartbeat(decodeURIComponent(bridgeHeartbeat[1]), await readJson(request)));
        return;
      }

      const bridgeNext = url.pathname.match(/^\/bridge\/sessions\/([^/]+)\/next$/);
      if (request.method === 'GET' && bridgeNext) {
        const job = core.nextJob(decodeURIComponent(bridgeNext[1]));
        if (!job) {
          response.writeHead(204, { 'cache-control': 'no-store' });
          response.end();
        } else {
          sendJson(response, 200, job);
        }
        return;
      }

      const bridgeResult = url.pathname.match(/^\/bridge\/sessions\/([^/]+)\/jobs\/([^/]+)$/);
      if (request.method === 'POST' && bridgeResult) {
        sendJson(response, 200, core.completeJob(
          decodeURIComponent(bridgeResult[1]),
          decodeURIComponent(bridgeResult[2]),
          await readJson(request),
        ));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/sessions') {
        sendJson(response, 200, { sessions: core.listSessions() });
        return;
      }

      const screenRoute = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/screen$/);
      if (request.method === 'GET' && screenRoute) {
        sendJson(response, 200, core.getScreen(decodeURIComponent(screenRoute[1])));
        return;
      }

      const jobsRoute = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/jobs$/);
      if (request.method === 'POST' && jobsRoute) {
        sendJson(response, 202, core.submitJob(decodeURIComponent(jobsRoute[1]), await readJson(request)));
        return;
      }

      const jobRoute = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (request.method === 'GET' && jobRoute) {
        sendJson(response, 200, core.getJob(decodeURIComponent(jobRoute[1])));
        return;
      }

      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    } catch (error) {
      const statusCode = error instanceof BridgeError ? error.statusCode : 500;
      const code = error instanceof BridgeError ? error.code : 'INTERNAL_ERROR';
      if (statusCode === 500) process.stderr.write(`[xshell-bridge] ${error.stack || error}\n`);
      sendJson(response, statusCode, { error: { code, message: error.message } });
    }
  });

  if (listen) {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.server.port, config.server.host, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
  }
  server.on('close', () => {
    fileTransport.stop();
    clearInterval(maintenanceTimer);
    clearInterval(cleanupTimer);
  });
  return { server, core, config, fileTransport };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { config } = await createDaemon();
  process.stderr.write(`[xshell-bridge] listening on http://${config.server.host}:${config.server.port}\n`);
}
