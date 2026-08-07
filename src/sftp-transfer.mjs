import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const CREDENTIAL_FIELD = /^(?:password|passwd|passphrase|pin|otp|token|api[_-]?key|secret)$/i;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class TransferError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TransferError(`${field} 不能为空。`, 'INVALID_TRANSFER_REQUEST');
  }
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\0\r\n]/.test(normalized)) {
    throw new TransferError(`${field} 格式不合法。`, 'INVALID_TRANSFER_REQUEST');
  }
  return normalized;
}

function validateLocalName(value) {
  const name = requiredText(value, 'local_name', 255);
  if (
    name === '.'
    || name === '..'
    || /[<>:"/\\|?*]/.test(name)
    || /[. ]$/.test(name)
    || WINDOWS_RESERVED_NAME.test(name)
  ) {
    throw new TransferError('local_name 只能是安全的单个 Windows 文件名，不能包含目录或保留字符。', 'INVALID_LOCAL_NAME');
  }
  return name;
}

function validateHost(value) {
  const host = requiredText(value, 'host', 255);
  if (!/^[a-z0-9._:[\]-]+$/i.test(host)) {
    throw new TransferError('host 只能包含主机名、IPv4 或 IPv6 地址。', 'INVALID_HOST');
  }
  return host;
}

function validateUsername(value) {
  const username = requiredText(value, 'username', 128);
  if (!/^[a-z0-9._-]+$/i.test(username)) {
    throw new TransferError('username 包含不支持的字符。', 'INVALID_USERNAME');
  }
  return username;
}

function validateRemotePath(value) {
  const path = requiredText(value, 'remote_path', 4096);
  if (!/^\/[a-z0-9._/@%+=:,-]+$/i.test(path)) {
    throw new TransferError(
      'remote_path 必须是绝对路径，且首版只允许英文字母、数字和 / . _ - @ % + = : ,，不允许空格或命令符号。',
      'INVALID_REMOTE_PATH',
    );
  }
  return path;
}

function formatRemoteHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

function validateRequest(input) {
  for (const key of Object.keys(input || {})) {
    if (CREDENTIAL_FIELD.test(key)) {
      throw new TransferError('文件传输请求不得包含密码、口令、验证码、Token 或其他敏感凭据。', 'CREDENTIAL_FIELD_BLOCKED');
    }
  }

  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TransferError('port 必须是 1 到 65535 之间的整数。', 'INVALID_PORT');
  }
  const riskLevel = requiredText(input.risk_level, 'risk_level', 16);
  if (!RISK_LEVELS.has(riskLevel)) {
    throw new TransferError('risk_level 必须是 low、medium、high 或 critical。', 'INVALID_RISK_LEVEL');
  }
  const expectedSha256 = input.expected_sha256
    ? requiredText(input.expected_sha256, 'expected_sha256', 64).toLowerCase()
    : null;
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new TransferError('expected_sha256 必须是 64 位十六进制 SHA-256。', 'INVALID_SHA256');
  }

  return {
    host: validateHost(input.host),
    port,
    username: validateUsername(input.username),
    remotePath: validateRemotePath(input.remote_path),
    localName: validateLocalName(input.local_name),
    explanation: requiredText(input.explanation, 'explanation', 1000),
    expectedOutcome: requiredText(input.expected_outcome, 'expected_outcome', 1000),
    riskLevel,
    expectedSha256,
  };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeJson(temporary, value);
  await rename(temporary, path);
}

function quoteCmdPath(path) {
  return `"${path.replaceAll('%', '%%')}"`;
}

export class SftpDownloadManager {
  constructor({
    downloadDir = resolve(PROJECT_ROOT, 'downloads'),
    stateDir = resolve(PROJECT_ROOT, 'data', 'transfers'),
    desktopLaunchDir = resolve(PROJECT_ROOT, 'data', 'desktop-launch'),
    scriptPath = resolve(PROJECT_ROOT, 'scripts', 'run-scp-download.ps1'),
    scpPath = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'scp.exe'),
    launcher = null,
    now = () => new Date().toISOString(),
  } = {}) {
    this.downloadDir = resolve(downloadDir);
    this.stateDir = resolve(stateDir);
    this.desktopLaunchDir = resolve(desktopLaunchDir);
    this.scriptPath = resolve(scriptPath);
    this.scpPath = resolve(scpPath);
    this.launcher = launcher;
    this.now = now;
  }

  async queueDesktopLaunch(transferId, transferDir, specPath) {
    if (process.platform !== 'win32') {
      throw new TransferError('安全下载窗口目前只支持 Windows。', 'UNSUPPORTED_PLATFORM');
    }
    const launcherPath = resolve(PROJECT_ROOT, 'scripts', 'launch-scp-download.ps1');
    const commandPath = resolve(transferDir, 'launch.cmd');
    const requestPath = resolve(this.desktopLaunchDir, `${transferId}.request.json`);
    const command = [
      '@echo off',
      '@chcp 65001 >nul',
      '@set "BRIDGE_PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
      '@if exist "%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" set "BRIDGE_PS=%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"',
      `"%BRIDGE_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${quoteCmdPath(launcherPath)} -RunnerPath ${quoteCmdPath(this.scriptPath)} -SpecPath ${quoteCmdPath(specPath)}`,
      '',
    ].join('\r\n');
    await mkdir(this.desktopLaunchDir, { recursive: true });
    await writeFile(commandPath, command, { encoding: 'utf8', mode: 0o600 });
    await writeJsonAtomic(requestPath, {
      protocol: 'xshell-agent-desktop-launch-v1',
      transferId,
      createdAt: this.now(),
    });
  }

  async startDownload(input) {
    const request = validateRequest(input || {});
    await Promise.all([
      stat(this.scpPath).catch(() => {
        throw new TransferError('未找到 Windows OpenSSH scp.exe，请先安装 OpenSSH 客户端。', 'SCP_NOT_FOUND');
      }),
      stat(this.scriptPath).catch(() => {
        throw new TransferError('未找到本地安全下载脚本。', 'TRANSFER_SCRIPT_NOT_FOUND');
      }),
    ]);
    await mkdir(this.downloadDir, { recursive: true });

    const finalPath = resolve(this.downloadDir, request.localName);
    if (await exists(finalPath)) {
      throw new TransferError(
        `本地文件已存在，安全策略禁止覆盖：${finalPath}`,
        'LOCAL_FILE_EXISTS',
      );
    }

    const transferId = randomUUID();
    const transferDir = resolve(this.stateDir, transferId);
    const partPath = resolve(this.downloadDir, `${request.localName}.${transferId}.part`);
    const specPath = resolve(transferDir, 'spec.json');
    const progressPath = resolve(transferDir, 'progress.json');
    const resultPath = resolve(transferDir, 'result.json');
    await mkdir(transferDir, { recursive: true });

    const remoteSource = `${request.username}@${formatRemoteHost(request.host)}:${request.remotePath}`;
    const initialApproval = [
      'AI Agent 请求从服务器下载一个文件。',
      '',
      `服务器：${request.host}:${request.port}`,
      `登录用户：${request.username}`,
      `远程文件：${request.remotePath}`,
      `本地文件：${finalPath}`,
      `临时文件：${partPath}`,
      '覆盖策略：禁止覆盖已有本地文件',
      `风险等级：${request.riskLevel.toUpperCase()}`,
      '',
      '为什么要做：',
      request.explanation,
      '',
      '预期结果：',
      request.expectedOutcome,
      '',
      '点击“是”后才会启动 scp；密码和首次连接确认必须由你在随后出现的终端窗口中亲自输入。',
    ].join('\r\n');

    const spec = {
      protocol: 'xshell-agent-secure-download-v1',
      initialApprovalHandledByXshell: true,
      transferId,
      createdAt: this.now(),
      host: request.host,
      port: request.port,
      username: request.username,
      remotePath: request.remotePath,
      remoteSource,
      localName: request.localName,
      finalPath,
      partPath,
      expectedSha256: request.expectedSha256,
      scpPath: this.scpPath,
      progressPath,
      resultPath,
      texts: {
        title: 'Xshell Agent Bridge 文件下载确认',
        initialApproval,
        consoleTitle: `安全下载：${request.localName}`,
        consoleIntro: '请在此窗口亲自完成主机指纹确认和密码输入。密码不会发送给 AI，也不会写入桥接日志。',
        transferring: '正在建立安全连接并下载文件，请根据提示亲自输入密码。',
        finalizeHeader: '文件已经下载到临时路径并完成本地校验。是否改为正式文件名？',
        sizeLabel: '文件大小',
        hashLabel: '本地 SHA-256',
        expectedHashLabel: '预期 SHA-256',
        finalPathLabel: '正式文件',
        rejectInitial: '你已拒绝下载，程序没有连接服务器，也没有创建目标文件。',
        rejectFinalize: '你已拒绝最终改名。临时 .part 文件会保留，程序不会覆盖或删除任何文件。',
        completed: '下载和最终改名已经完成。',
        hashMismatch: 'SHA-256 校验失败。临时 .part 文件会保留，不会改成正式文件。',
        failedPrefix: '下载失败。程序不会自动重试或删除临时文件。\r\n\r\n',
        windowClosed: '下载窗口被关闭，任务已取消。程序不会自动重试。',
        launcherFailed: '无法启动安全下载窗口。',
      },
    };
    await writeJson(specPath, spec);
    await writeJson(progressPath, {
      transferId,
      status: 'awaiting_user',
      stage: 'desktop_launch',
      updatedAt: this.now(),
    });

    try {
      if (this.launcher) await this.launcher(this.scriptPath, specPath);
      else await this.queueDesktopLaunch(transferId, transferDir, specPath);
    } catch (error) {
      await writeJson(resultPath, {
        transferId,
        status: 'failed',
        stage: 'launch',
        error: error.message,
        updatedAt: this.now(),
      });
      throw new TransferError(`无法打开安全下载窗口：${error.message}`, 'TRANSFER_LAUNCH_FAILED');
    }

    return {
      transfer_id: transferId,
      status: 'awaiting_user',
      stage: 'desktop_launch',
      message: '已把无凭据的启动请求交给 Xshell 桌面桥接脚本。窗口出现后请先核对确认，再亲自输入密码。',
      local_path: finalPath,
    };
  }

  async getStatus(transferId) {
    if (typeof transferId !== 'string' || !/^[a-f0-9-]{36}$/i.test(transferId)) {
      throw new TransferError('transfer_id 格式不正确。', 'INVALID_TRANSFER_ID');
    }
    const transferDir = resolve(this.stateDir, transferId);
    const specPath = resolve(transferDir, 'spec.json');
    let spec;
    try {
      spec = await readJson(specPath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new TransferError('没有找到该文件传输任务。', 'TRANSFER_NOT_FOUND');
      throw error;
    }

    const resultPath = resolve(transferDir, 'result.json');
    const progressPath = resolve(transferDir, 'progress.json');
    const state = await readJson(await exists(resultPath) ? resultPath : progressPath);
    return {
      transfer_id: transferId,
      direction: spec.direction || 'download',
      status: state.status,
      stage: state.stage,
      remote: {
        host: spec.host,
        port: spec.port,
        username: spec.username,
        path: spec.remotePath,
      },
      local_path: state.localPath || spec.localPath || spec.finalPath,
      part_path: state.partPath || spec.partPath,
      size: state.size ?? null,
      sha256: state.sha256 || null,
      error: state.error || null,
      updated_at: state.updatedAt,
    };
  }
}

export class SftpUploadManager extends SftpDownloadManager {
  constructor(options = {}) {
    super({
      ...options,
      scriptPath: options.scriptPath || resolve(PROJECT_ROOT, 'scripts', 'run-scp-upload.ps1'),
    });
    this.sshPath = resolve(
      options.sshPath || resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
    );
  }

  async startUpload(input) {
    const request = validateRequest(input || {});
    await Promise.all([
      stat(this.scpPath).catch(() => {
        throw new TransferError('未找到 Windows OpenSSH scp.exe，请先安装 OpenSSH 客户端。', 'SCP_NOT_FOUND');
      }),
      stat(this.sshPath).catch(() => {
        throw new TransferError('未找到 Windows OpenSSH ssh.exe，请先安装 OpenSSH 客户端。', 'SSH_NOT_FOUND');
      }),
      stat(this.scriptPath).catch(() => {
        throw new TransferError('未找到本地安全上传脚本。', 'TRANSFER_SCRIPT_NOT_FOUND');
      }),
    ]);
    await mkdir(this.downloadDir, { recursive: true });

    const localPath = resolve(this.downloadDir, request.localName);
    let localInfo;
    try {
      localInfo = await stat(localPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new TransferError(`待上传的本地文件不存在：${localPath}`, 'LOCAL_FILE_NOT_FOUND');
      }
      throw error;
    }
    if (!localInfo.isFile()) {
      throw new TransferError('首版上传只支持单个普通文件。', 'LOCAL_FILE_NOT_REGULAR');
    }
    const localSha256 = await sha256File(localPath);

    const transferId = randomUUID();
    const transferDir = resolve(this.stateDir, transferId);
    const specPath = resolve(transferDir, 'spec.json');
    const progressPath = resolve(transferDir, 'progress.json');
    const resultPath = resolve(transferDir, 'result.json');
    const remotePartPath = `${request.remotePath}.${transferId}.part`;
    const remoteTarget = `${request.username}@${formatRemoteHost(request.host)}`;
    const remoteDestination = `${remoteTarget}:${remotePartPath}`;
    const remoteFinalizeCommand = [
      'set -eu',
      `test ! -e '${request.remotePath}'`,
      `actual=$(sha256sum -- '${remotePartPath}')`,
      'actual=${actual%% *}',
      `test "$actual" = '${localSha256}'`,
      `mv -n -- '${remotePartPath}' '${request.remotePath}'`,
      `test ! -e '${remotePartPath}'`,
    ].join('; ');
    await mkdir(transferDir, { recursive: true });

    const initialApproval = [
      'AI Agent 请求向服务器上传一个文件。',
      '',
      `本地文件：${localPath}`,
      `文件大小：${localInfo.size} bytes`,
      `本地 SHA-256：${localSha256}`,
      `服务器：${request.host}:${request.port}`,
      `登录用户：${request.username}`,
      `远程临时文件：${remotePartPath}`,
      `远程正式文件：${request.remotePath}`,
      '覆盖策略：禁止覆盖已有远程正式文件',
      `风险等级：${request.riskLevel.toUpperCase()}`,
      '',
      '为什么要做：',
      request.explanation,
      '',
      '预期结果：',
      request.expectedOutcome,
      '',
      '点击“是”后才会启动 scp。密码必须由你在终端窗口亲自输入；最终校验和改名可能要求再次输入密码。',
    ].join('\r\n');

    const spec = {
      protocol: 'xshell-agent-secure-upload-v1',
      direction: 'upload',
      initialApprovalHandledByXshell: true,
      transferId,
      createdAt: this.now(),
      host: request.host,
      port: request.port,
      username: request.username,
      remotePath: request.remotePath,
      remotePartPath,
      remoteTarget,
      remoteDestination,
      remoteFinalizeCommand,
      localName: request.localName,
      localPath,
      partPath: remotePartPath,
      expectedSha256: localSha256,
      size: localInfo.size,
      scpPath: this.scpPath,
      sshPath: this.sshPath,
      progressPath,
      resultPath,
      texts: {
        title: 'Xshell Agent Bridge 文件上传确认',
        initialApproval,
        consoleTitle: `安全上传：${request.localName}`,
        consoleIntro: '请在此窗口亲自完成主机指纹确认和密码输入。密码不会发送给 AI，也不会写入桥接日志。',
        transferring: '正在建立安全连接并上传到远程临时路径，请根据提示亲自输入密码。',
        finalizeHeader: '文件已上传到远程临时路径。是否再次认证，在服务器校验 SHA-256，并在不覆盖的前提下改为正式文件名？',
        sizeLabel: '文件大小',
        hashLabel: '本地 SHA-256',
        partPathLabel: '远程临时文件',
        finalPathLabel: '远程正式文件',
        rejectInitial: '你已拒绝上传，程序没有连接服务器。',
        rejectFinalize: '你已拒绝远程校验和改名。远程 .part 文件会保留，程序不会覆盖或删除任何文件。',
        completed: '上传、远程校验和最终改名已经完成。',
        failedPrefix: '上传失败。程序不会自动重试或删除远程临时文件。\r\n\r\n',
        windowClosed: '上传窗口被关闭，任务已取消。程序不会自动重试。',
        launcherFailed: '无法启动安全上传窗口。',
      },
    };
    await writeJson(specPath, spec);
    await writeJson(progressPath, {
      transferId,
      status: 'awaiting_user',
      stage: 'desktop_launch',
      updatedAt: this.now(),
    });

    try {
      if (this.launcher) await this.launcher(this.scriptPath, specPath);
      else await this.queueDesktopLaunch(transferId, transferDir, specPath);
    } catch (error) {
      await writeJson(resultPath, {
        transferId,
        status: 'failed',
        stage: 'launch',
        error: error.message,
        updatedAt: this.now(),
      });
      throw new TransferError(`无法打开安全上传窗口：${error.message}`, 'TRANSFER_LAUNCH_FAILED');
    }

    return {
      transfer_id: transferId,
      status: 'awaiting_user',
      stage: 'desktop_launch',
      message: '已把无凭据的上传启动请求交给 Xshell 桌面桥接脚本。窗口出现后请核对并亲自输入密码。',
      local_path: localPath,
      remote_path: request.remotePath,
      size: localInfo.size,
      sha256: localSha256,
    };
  }
}
