import { createInterface } from 'node:readline';
import { connectToDaemon } from './client.mjs';

const AGENT_ID = process.env.XSHELL_AGENT_ID || `mcp-${process.pid}`;
const PROTOCOL_VERSION = '2025-06-18';

const tools = [
  {
    name: 'xshell_health',
    title: '检查 Xshell 桥接状态',
    description: '检查本机桥接服务是否运行，并统计已接入的 Xshell 标签页。只读操作。',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'xshell_list_sessions',
    title: '列出 Xshell 会话',
    description: '列出当前已接入桥接程序的 Xshell 标签页，不读取 Xshell 保存的凭据。只读操作。',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'xshell_read_screen',
    title: '读取 Xshell 屏幕文字',
    description: '读取终端窗口当前可见的文字，不是截图，也不包含已滚出窗口的完整历史。只有一个在线会话时可省略 session_id。',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'Session id from xshell_list_sessions.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'xshell_send',
    title: '申请向 Xshell 发送输入',
    description: '申请发送精确终端输入。调用前必须向用户解释本步骤；Xshell 会显示说明、预期结果、风险和完整输入，只有用户点击“是”才发送。密码、口令、验证码、Token、API Key 等敏感信息必须由用户在 Xshell 中亲自输入，Agent 不得代填。',
    inputSchema: {
      type: 'object',
      required: ['text', 'explanation', 'expected_outcome', 'risk_level'],
      properties: {
        session_id: { type: 'string', description: '目标会话 ID；只有一个在线会话时可省略。' },
        text: { type: 'string', description: '准备输入终端的完整文本，不得包含密码或其他敏感凭据。' },
        enter: { type: 'boolean', default: false, description: '输入文本后是否按回车。' },
        explanation: { type: 'string', minLength: 1, maxLength: 1000, description: '用通俗语言解释这个单独步骤要做什么，以及为什么需要它。' },
        expected_outcome: { type: 'string', minLength: 1, maxLength: 1000, description: '成功后预计出现的输出或变化。' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: '本次完整输入的风险等级。' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 120000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'xshell_interrupt',
    title: '申请中断 Xshell 命令',
    description: '申请发送 Ctrl+C。调用前必须解释影响，Xshell 会要求用户本地确认；用户拒绝时不会发送任何内容。',
    inputSchema: {
      type: 'object',
      required: ['explanation', 'expected_outcome', 'risk_level'],
      properties: {
        session_id: { type: 'string' },
        explanation: { type: 'string', minLength: 1, maxLength: 1000, description: 'Why the running command should be interrupted.' },
        expected_outcome: { type: 'string', minLength: 1, maxLength: 1000, description: 'What should happen after Ctrl+C is sent.' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 120000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'xshell_wait_for',
    title: '等待 Xshell 出现文字',
    description: '轮询当前可见屏幕，直到出现指定文字或超时。不会发送终端输入；高速日志应落盘后分段查看。',
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
      ? {
          type: 'send',
          text: args.text,
          enter: args.enter ?? false,
          explanation: args.explanation,
          expectedOutcome: args.expected_outcome,
          riskLevel: args.risk_level,
        }
      : {
          type: 'interrupt',
          explanation: args.explanation,
          expectedOutcome: args.expected_outcome,
          riskLevel: args.risk_level,
        };
    const queued = await client.submitJob(sessionId, { agentId: AGENT_ID, action });
    const job = await client.waitForJob(queued.id, args.timeout_ms ?? 120_000);
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
      serverInfo: { name: 'xshell-agent-bridge', version: '0.2.0' },
      instructions: '先读屏。每次调用 xshell_send 或 xshell_interrupt 前，必须向用户解释单个步骤、完整输入、预期结果和真实风险，不能把无关步骤打包。每次写操作都会在 Xshell 本地显示“是/否”确认框，只有用户点击“是”才执行。密码、口令、Passphrase、PIN、OTP、验证码、Token、API Key 等所有敏感凭据必须由用户在 Xshell 中亲自输入；Agent 不得请求、代填、传输或保存。检测到敏感输入提示时，应暂停并请用户手动输入，确认完成后再继续只读检查。',
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

// MCP JSON-RPC over stdio is UTF-8. Set it explicitly on Windows so direct
// Agent clients preserve Chinese explanations and other non-ASCII text.
process.stdin.setEncoding('utf8');
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
