import { createInterface } from 'node:readline';
import { connectToDaemon } from './client.mjs';
import { SftpDownloadManager, SftpUploadManager } from './sftp-transfer.mjs';

const AGENT_ID = process.env.XSHELL_AGENT_ID || `mcp-${process.pid}`;
const PROTOCOL_VERSION = '2025-06-18';
const downloadManager = new SftpDownloadManager();
const uploadManager = new SftpUploadManager();

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
    description: '申请发送精确终端输入。调用前必须向用户解释本步骤；Xshell 会显示说明、预期结果、风险和完整输入，只有用户点击“是”才发送。企业安全模式会硬性拒绝文件删除、资源清理、磁盘格式化、数据库删除、软件卸载和关机重启等命令；Agent 不得通过脚本、编码、别名或拆分命令绕过，只能请用户在 Xshell 中亲自输入。密码、口令、验证码、Token、API Key 等敏感信息同样必须由用户亲自输入，Agent 不得代填。',
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
  {
    name: 'sftp_download',
    title: '申请从服务器安全下载文件',
    description: '申请使用 Windows OpenSSH 从服务器下载单个文件。程序会先在本机弹窗展示主机、远程路径、本地路径、风险和预期结果；用户同意后才打开独立终端，密码必须由用户亲自输入。文件先保存为唯一的 .part 文件，可校验 SHA-256，再次确认后才改为正式文件名。默认禁止覆盖已有文件。',
    inputSchema: {
      type: 'object',
      required: ['host', 'username', 'remote_path', 'local_name', 'explanation', 'expected_outcome', 'risk_level'],
      properties: {
        host: { type: 'string', minLength: 1, maxLength: 255, description: '服务器主机名或 IP 地址，不得包含密码。' },
        port: { type: 'integer', minimum: 1, maximum: 65535, default: 22 },
        username: { type: 'string', minLength: 1, maxLength: 128, description: '服务器登录用户名，不是密码。' },
        remote_path: { type: 'string', minLength: 1, maxLength: 4096, description: '准备下载的单个远程文件绝对路径。' },
        local_name: { type: 'string', minLength: 1, maxLength: 255, description: '保存到项目 downloads 目录的文件名，不能包含目录。' },
        expected_sha256: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$', description: '可选；已知的远程文件 SHA-256，用于下载完成后校验。' },
        explanation: { type: 'string', minLength: 1, maxLength: 1000, description: '用中文解释为什么需要下载这个文件。' },
        expected_outcome: { type: 'string', minLength: 1, maxLength: 1000, description: '成功后预期得到什么文件。' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'sftp_upload',
    title: '申请向服务器安全上传文件',
    description: '申请使用 Windows OpenSSH 向服务器上传 downloads 目录中的单个文件。程序会先计算本地文件大小和 SHA-256，并在 Xshell 弹窗展示全部信息；用户同意后才打开独立终端，密码必须由用户亲自输入。文件先上传为唯一的远程 .part 文件，再次确认后才在服务器校验 SHA-256，并以禁止覆盖方式改为正式文件名。',
    inputSchema: {
      type: 'object',
      required: ['host', 'username', 'remote_path', 'local_name', 'explanation', 'expected_outcome', 'risk_level'],
      properties: {
        host: { type: 'string', minLength: 1, maxLength: 255, description: '服务器主机名或 IP 地址，不得包含密码。' },
        port: { type: 'integer', minimum: 1, maximum: 65535, default: 22 },
        username: { type: 'string', minLength: 1, maxLength: 128, description: '服务器登录用户名，不是密码。' },
        remote_path: { type: 'string', minLength: 1, maxLength: 4096, description: '准备创建的远程正式文件绝对路径；已存在时不会覆盖。' },
        local_name: { type: 'string', minLength: 1, maxLength: 255, description: '项目 downloads 目录内待上传的文件名，不能包含目录。' },
        explanation: { type: 'string', minLength: 1, maxLength: 1000, description: '用中文解释为什么需要上传这个文件。' },
        expected_outcome: { type: 'string', minLength: 1, maxLength: 1000, description: '成功后服务器上预期得到什么文件。' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'sftp_transfer_status',
    title: '查询文件传输状态',
    description: '读取下载或上传任务的当前阶段、文件大小、SHA-256 或错误信息。只读操作，不会连接服务器或修改文件。',
    inputSchema: {
      type: 'object',
      required: ['transfer_id'],
      properties: {
        transfer_id: { type: 'string', description: 'sftp_download 或 sftp_upload 返回的任务 ID。' },
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

async function callTool(getClient, name, args = {}) {
  if (name === 'sftp_download') return output(await downloadManager.startDownload(args));
  if (name === 'sftp_upload') return output(await uploadManager.startUpload(args));
  if (name === 'sftp_transfer_status') return output(await downloadManager.getStatus(args.transfer_id));

  const client = await getClient();
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
      serverInfo: { name: 'xshell-agent-bridge', version: '0.4.0' },
      instructions: '先读屏。每次调用 xshell_send、xshell_interrupt、sftp_download 或 sftp_upload 前，必须向用户解释完整目标、完整输入、预期结果、真实风险，以及失败时可能留下的中间状态。同一目标内、风险相近、前后依赖明确的连续命令应尽量合并为一次确认，减少不必要的弹窗；不得合并无关操作。企业安全模式禁止 Agent 执行文件删除或清空、find 批量删除、容器与编排资源删除、数据库 DROP/TRUNCATE/DELETE、磁盘格式化或擦除、软件包卸载、Git 强制清理、关机重启及防火墙规则清空。Agent 不得使用别名、解释器、脚本文件、Python/Node、编码、变量展开、分段执行或其他方式绕过硬拦截，也不得指导用户关闭安全策略；如确需执行，必须解释原因并请用户在 Xshell 中亲自输入。覆盖、停服务、改权限等其他高风险动作仍须拆开单独确认。每次终端写操作都会在 Xshell 本地显示“是/否”确认框；文件下载和上传会在 Windows 本地分阶段确认，只有用户点击“是”才继续。密码、口令、Passphrase、PIN、OTP、验证码、Token、API Key 等所有敏感凭据必须由用户在 Xshell 或独立传输终端中亲自输入；Agent 不得请求、代填、传输或保存。传输默认禁止覆盖，先使用唯一 .part 文件，校验后再次确认才改为正式文件名。每次命令或文件传输结束后，Agent 必须读取实际结果并主动用中文向用户解释：是否成功、关键输出的含义、服务器或本机发生了什么变化、是否留下临时文件或其他中间状态，以及是否还需下一步。工具返回“已批准”或“已发送”不等于远程执行成功；必须通过读屏、等待标志、退出状态或传输结果进行核验。若证据不足，必须明确说明暂时无法确认，不能猜测或直接宣称成功。',
    };
  }
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    try {
      return await callTool(getClient, request.params?.name, request.params?.arguments || {});
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
