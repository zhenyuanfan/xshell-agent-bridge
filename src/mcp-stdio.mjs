import { createInterface } from 'node:readline';
import { connectToDaemon } from './client.mjs';

const AGENT_ID = process.env.XSHELL_AGENT_ID || `mcp-${process.pid}`;
const PROTOCOL_VERSION = '2025-06-18';

const tools = [
  {
    name: 'xshell_health',
    title: 'Xshell Bridge Health',
    description: 'Check whether the local Xshell middleware is running and count connected bridge sessions.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'xshell_list_sessions',
    title: 'List Xshell Sessions',
    description: 'List Xshell tabs that are currently attached to the middleware. Does not expose saved credentials.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'xshell_read_screen',
    title: 'Read Xshell Screen',
    description: 'Read the latest visible terminal screen snapshot. If exactly one session is online, session_id may be omitted.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'Session id from xshell_list_sessions.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'xshell_send',
    title: 'Send Input to Xshell',
    description: 'Send exact text to a live Xshell tab, optionally followed by Enter. Write actions are serialized per session and audited.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        session_id: { type: 'string', description: 'Session id. May be omitted only when one session is online.' },
        text: { type: 'string', description: 'Exact text to type into the terminal.' },
        enter: { type: 'boolean', default: false, description: 'Whether to press Enter after the text.' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 30000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'xshell_interrupt',
    title: 'Interrupt Xshell Command',
    description: 'Send Ctrl+C to a live Xshell tab. Write actions are serialized and audited.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 30000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'xshell_wait_for',
    title: 'Wait for Xshell Text',
    description: 'Poll screen snapshots until literal text appears or a timeout expires. This does not send terminal input.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        session_id: { type: 'string' },
        text: { type: 'string', minLength: 1 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 30000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function output(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

async function callTool(client, name, args = {}) {
  if (name === 'xshell_health') return output(await client.health());
  if (name === 'xshell_list_sessions') return output(await client.listSessions());

  if (name === 'xshell_read_screen') {
    const sessionId = await client.resolveSessionId(args.session_id);
    return output(await client.readScreen(sessionId));
  }

  if (name === 'xshell_send' || name === 'xshell_interrupt') {
    const sessionId = await client.resolveSessionId(args.session_id);
    const action = name === 'xshell_send'
      ? { type: 'send', text: args.text, enter: args.enter ?? false }
      : { type: 'interrupt' };
    const queued = await client.submitJob(sessionId, { agentId: AGENT_ID, action });
    const job = await client.waitForJob(queued.id, args.timeout_ms ?? 30_000);
    return output({ job, screen: await client.readScreen(sessionId) }, job.status === 'failed');
  }

  if (name === 'xshell_wait_for') {
    const sessionId = await client.resolveSessionId(args.session_id);
    const deadline = Date.now() + (args.timeout_ms ?? 30_000);
    let snapshot;
    do {
      snapshot = await client.readScreen(sessionId);
      if (snapshot.screen.includes(args.text)) return output({ matched: true, ...snapshot });
      await sleep(100);
    } while (Date.now() <= deadline);
    return output({ matched: false, expected: args.text, ...snapshot });
  }

  throw new Error(`Unknown tool: ${name}`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request, getClient) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: request.params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'xshell-agent-bridge', version: '0.1.0' },
      instructions: 'Read the screen before sending input. Treat xshell_send and xshell_interrupt as write operations requiring user awareness. Multiple agents may connect; writes are serialized per Xshell session.',
    };
  }
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    try {
      return await callTool(await getClient(), request.params?.name, request.params?.arguments || {});
    } catch (error) {
      return output({ error: error.message, code: error.code || 'TOOL_ERROR' }, true);
    }
  }
  const error = new Error(`Method not found: ${request.method}`);
  error.code = -32601;
  throw error;
}

let clientPromise;
const getClient = () => {
  clientPromise ||= connectToDaemon();
  return clientPromise;
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }
  if (request.id === undefined) continue;
  try {
    write({ jsonrpc: '2.0', id: request.id, result: await handle(request, getClient) });
  } catch (error) {
    write({ jsonrpc: '2.0', id: request.id, error: { code: error.code || -32603, message: error.message } });
  }
}
