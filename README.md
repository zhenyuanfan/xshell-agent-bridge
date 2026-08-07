# Xshell Agent Bridge

**Xshell MCP Server for AI Agents** — 一个面向 Codex、Claude Code、Kimi Code CLI、Cursor 等 MCP 客户端的本地桥接程序，让 AI Agent 能读取和操作已打开的 Xshell 终端标签页。

> v0.4.0 企业安全策略版：在安全确认和文件传输基础上，新增 Agent 危险命令硬拦截。文件删除、资源清理、磁盘格式化、数据库删除、软件卸载和关机重启等操作不能由 Agent 发送；如确有需要，只能由用户在 Xshell 中亲自输入。

它适合需要由 AI 协助完成服务器巡检、部署、排障、离线环境文件中转或重复终端操作的场景。终端功能只能操作你在 Xshell 中已连接并主动接入桥接脚本的标签页；文件下载功能只有在你核对本地弹窗后，才会通过系统 OpenSSH 连接指定服务器。

关键词：Xshell MCP、SFTP MCP、MCP server、AI terminal automation、secure file transfer、Codex、Claude Code、Cursor、Kimi Code CLI、SSH terminal bridge。

## 能力与边界

| 能力 | 说明 |
| --- | --- |
| 读取终端 | 获取当前可见的 Xshell 屏幕内容。 |
| 写入终端 | 每次先在 Xshell 本地弹窗确认，再发送精确文本、回车或 `Ctrl+C`。 |
| 等待输出 | 等待屏幕出现指定文本，便于确认命令结果。 |
| 安全下载 | 使用 Windows OpenSSH 从服务器下载单个文件；两次本地确认、密码人工输入、`.part` 临时文件和可选 SHA-256 校验。 |
| 安全上传 | 把 `downloads/` 中的单个文件上传为远程唯一 `.part` 文件；两次本地确认、密码人工输入、服务器端 SHA-256 校验并禁止覆盖。 |
| 企业安全策略 | 守护核心与 Xshell 脚本双重拦截 Agent 发起的删除、清理、格式化、卸载和关机重启等高破坏性命令。 |
| 多 Agent 协作 | 同一标签页可被多个 Agent 读取；写操作会排队执行。 |
| 本机运行 | 守护进程只监听 `127.0.0.1`，不对外暴露 HTTP 服务。 |

它不会扫描 `.xsh` 会话文件，也不会读取或返回 Xshell 已保存的密码、密钥。下载请求的 MCP 参数不允许包含密码、口令或 Token；认证发生在独立的本地终端窗口中。终端可见内容仍可能包含敏感信息；而且发送文本等同于在当前会话中手动输入命令，权限与该会话完全一致。

## 工作原理

```mermaid
flowchart LR
  A["Codex / Claude / Kimi / Cursor"] -->|"MCP stdio"| B["src/mcp-stdio.mjs"]
  B --> C["Node 守护进程"]
  C <-->|"本地原子文件信箱"| D["Xshell Python 脚本"]
  D --> F{"用户在 Xshell 确认？"}
  F -->|"是"| E["向当前 Xshell 标签页发送输入"]
  F -->|"否"| G["拒绝执行并回报 Agent"]
  B --> H["安全下载模块"]
  H -->|"无凭据桌面启动请求"| D
  D --> I{"用户核对下载计划？"}
  I -->|"是"| J["独立终端中人工认证"]
  J --> K["下载为 .part 并校验"]
  K --> L{"用户确认最终改名？"}
```

Xshell 内嵌 Python 的能力有限，因此桥接最后一段使用 `data/ipc/` 下的原子 JSON 文件通信：脚本上报屏幕与会话状态，守护进程投递操作申请。脚本领取申请后先调用 Xshell 8 的 `MessageBox` 显示本地确认框；用户同意后才调用 `xsh.Screen.Send`。操作不会自动重试，避免在崩溃或断连后重复执行。

## 快速开始

### 1. 准备环境

- Node.js 20 或更高版本
- Xshell 8
- Windows OpenSSH 客户端（Windows 10/11 通常已经包含，可用 `ssh -V` 检查）
- 任一支持 MCP stdio 的 Agent 客户端

项目没有 npm 第三方依赖，不需要执行 `npm install`。仓库已经包含 Codex、Kimi Code CLI 和 Claude Code 的项目级 MCP 配置；在项目目录重新打开 Agent 客户端后，首次调用工具时会自动启动 Node 守护进程。

首次自动启动会创建本机专用的 `config/local.json`，其中含随机鉴权令牌。该文件已经被 Git 忽略，不能提交或分享。

### 2. 接入一个 Xshell 标签页

在要让 Agent 操作的 Xshell 标签页中选择：

`工具 → 脚本 → 运行`

然后打开：

```text
xshell\xshell_agent_bridge.py
```

每个需要接入的标签页都要运行一次脚本。脚本会持续运行、每隔约 250ms 更新状态；关闭标签页或停止脚本后，该会话会自动离线。

### 3. 告诉 Agent 你要做什么

例如：“检查 Docker 是否安装，不要执行其他操作。”Agent 可以直接读取屏幕。涉及终端输入时，流程如下：

1. Agent 先在对话中说明这一步要做什么。
2. Xshell 弹窗显示目标主机、Agent、风险等级、原因、预期结果和完整输入。
3. 你检查内容：点击“是”才执行；点击“否”不会向服务器发送任何内容。
4. Agent 读取执行后的屏幕，再解释结果并提出下一步。

因此，普通使用者日常只需：**打开 Xshell → 运行桥接脚本 → 向 Agent 描述任务 → 逐条确认写操作**。

### 4. 从服务器下载文件

告诉 Agent 服务器地址、登录用户名、远程文件路径以及希望保存的文件名，例如：“从 `10.0.0.8` 的 `/opt/packages/app.jar` 下载到本机，保存为 `app.jar`。”不要在对话中提供密码。

下载流程如下：

1. Agent 解释下载目的、目标路径、预期结果和风险，然后调用 `sftp_download`。
2. 新版 Xshell 桥接脚本在你的真实桌面弹窗，显示服务器、用户名、远程文件、本地文件、临时文件和禁止覆盖策略；默认按钮是“否”。
3. 你点击“是”后，Xshell 脚本使用 `os.startfile` 从交互桌面运行本地启动文件，再创建独立 PowerShell 窗口。首次连接的主机指纹确认和密码都由你亲自输入，Agent、MCP 与 Xshell 脚本都不会收到这些输入。
4. OpenSSH 把内容写入 `downloads/` 下唯一的 `.part` 文件。若提供预期 SHA-256，程序会自动比对。
5. 下载和校验完成后再次弹窗；只有你再次点击“是”，程序才把 `.part` 改为正式文件名。
6. Agent 使用 `sftp_transfer_status` 查询成功、拒绝或失败结果。

当前版本只下载单个普通文件，不下载目录、不自动覆盖、不自动删除失败的 `.part` 文件，也不会在失败后自动重试。为了兼容旧版 OpenSSH 并阻止远程路径注入，远程路径必须是绝对路径，首版暂不支持带空格或中文的远程文件名。下载时至少要有一个运行新版桥接脚本的 Xshell 标签页，用来把认证窗口安全地启动到当前 Windows 桌面；目标服务器还必须能从当前电脑通过 SSH/SFTP 访问。

如果直接关闭下载 PowerShell 窗口，后台观察进程会把任务标记为“已取消”；不会连接重试，也不会删除可能已经产生的 `.part` 文件。

### 5. 其他 Agent 客户端

仓库已包含 Codex、Kimi Code CLI 与 Claude Code 的项目级 MCP 配置。重新打开项目或在项目目录启动对应客户端后即可使用。

其他 MCP 客户端以以下命令启动服务：

```powershell
node C:\绝对路径\src\mcp-stdio.mjs
```

可选环境变量 `XSHELL_AGENT_ID` 用于在审计日志中区分调用方。各客户端的配置示例见 [docs/CLIENTS.md](docs/CLIENTS.md)。

## 推荐操作流程

Agent 操作终端时必须遵循以下顺序：

1. 调用 `xshell_health`，确认守护进程运行且存在在线会话。
2. 调用 `xshell_list_sessions`，多标签页时明确选择目标 `session_id`。
3. 调用 `xshell_read_screen`，确认主机、用户、提示符和当前正在运行的命令。
4. 在对话中向用户说明本阶段的完整目标、预期结果、风险、失败后可能留下的状态和完整命令。同一目标内风险相近、依赖明确的连续命令尽量合并，减少不必要的弹窗；无关操作不得打包。
5. 调用 `xshell_send` 或 `xshell_interrupt`，等待用户在 Xshell 本地点击“是”或“否”。
6. 再次读屏，或调用 `xshell_wait_for` 等待预期输出，确认命令的实际结果。
7. Agent 必须主动用中文解释本次结果：是否成功、关键输出的含义、实际产生的变化、是否留下临时文件或中间状态，以及是否还需要下一步。

`xshell_send` 的“完成”只表示用户已批准且 Xshell 已接受输入，不代表远端命令执行成功；最后一步的读屏或等待仍然必要。

如果当前可见输出不足以判断结果，Agent 必须明确说“暂时无法确认”，并建议或执行经过用户许可的核验步骤，不能仅凭命令已经发送就宣称成功。

推荐按“目标阶段”确认，而不是机械地按每条小命令确认。例如部署一个容器通常可分为“环境与冲突检查”和“拉取、创建、启动、验证”两个阶段。后一阶段可以使用 `&&` 在前一步成功后继续，并在确认框中一次展示全部命令。删除文件、覆盖配置、停止服务、修改权限、清理数据等破坏性操作仍须拆开单独确认，不能藏在普通检查或部署命令中。

## 使用注意事项

### 屏幕读取不是截图

桥接脚本通过 Xshell 的文本接口读取当前终端窗口，返回的是可见文字而不是图片。当前版本只读取窗口中现有的行和列，不会读取已经滚出窗口的完整回滚历史。

因此：

- 短命令和少量输出可以直接读屏确认。
- 输出速度很快时，某些文字可能在两次屏幕采集之间滚出窗口；`xshell_wait_for` 不应作为高吞吐日志的唯一判断依据。
- 不要依赖扩大 Xshell 回滚行数来保存部署证据；桥接程序仍然只保证读取当前可见区域。

### 长任务和大量日志必须落盘

部署 JAR、启动服务、构建项目或运行长任务时，应先把标准输出和错误输出写入服务器日志文件，再使用 `tail`、`grep`、`sed` 或 `journalctl` 分段检查。例如：

```bash
nohup java -jar app.jar > app.log 2>&1 &
tail -n 100 app.log
grep -nEi 'error|exception|failed' app.log | tail -n 100
```

随后还应检查进程、监听端口或应用健康接口，不能仅凭终端最后几行判断部署成功。同一目标的低风险连续操作可以合并说明和确认；高风险操作必须单独处理，并由用户在 Xshell 判断。

### 密码和敏感凭据必须由用户亲自输入

Agent 不得请求、代填、传输或保存密码、口令、Passphrase、PIN、OTP、验证码、Token、API Key 等敏感凭据。遇到认证提示时，标准流程是：

1. Agent 识别到密码或验证码提示后停止发送输入。
2. Agent 请用户切换到 Xshell，并在终端中亲自输入敏感内容。
3. 用户输入完成后通知 Agent；Agent只读取后续状态和非敏感输出，再提出下一步。

桥接核心会在两处强制拦截：

- 当前屏幕末尾出现 `Password:`、密码、口令、Passphrase、OTP、验证码、PIN、Token 等输入提示时，拒绝 Agent 的文本发送请求。
- 输入内容疑似使用 `sshpass`、`sudo -S`、命令行密码参数、URL 内嵌凭据或密码环境变量时，在写入 IPC 文件之前拒绝。

不要把密码发在 Agent 对话中，也不要把密码写入命令行让 Agent 代为执行。自动识别用于防止常见误操作，不能代替用户核对 Xshell 弹窗中的完整命令。

### MCP 工具

| 工具 | 用途 | 是否写入终端 |
| --- | --- | --- |
| `xshell_health` | 检查守护进程与在线会话数量 | 否 |
| `xshell_list_sessions` | 列出已接入的标签页 | 否 |
| `xshell_read_screen` | 读取最新可见屏幕 | 否 |
| `xshell_send` | 提议发送文本；必须提供解释、预期结果和风险，并由用户在 Xshell 确认 | 是 |
| `xshell_interrupt` | 提议发送 `Ctrl+C`；同样需要本地确认 | 是 |
| `xshell_wait_for` | 等待屏幕出现目标文本 | 否 |
| `sftp_download` | 提议从服务器下载单个文件；两次本地确认，密码由用户在独立终端输入 | 不写终端；写入本机 `downloads/` |
| `sftp_upload` | 提议把 `downloads/` 中的单个文件安全上传到服务器；远程校验并禁止覆盖 | 不写 Xshell；在服务器创建文件 |
| `sftp_transfer_status` | 查询下载或上传阶段、大小、SHA-256 和错误信息 | 否 |

## 本地验证与排障

不需要 Xshell 也可以验证完整流程：

```powershell
npm run demo:bridge
```

常见情况：

| 现象 | 处理方式 |
| --- | --- |
| `onlineSessions: 0` | 在目标 Xshell 标签页重新运行 `xshell_agent_bridge.py`。 |
| 会话显示离线 | 确认标签页仍连接且脚本没有停止；每个新标签页都需要单独接入。 |
| Agent 无法发现工具 | 重新打开项目或重启 Agent 客户端，确认其 MCP 配置已加载。 |
| 提示 `APPROVAL_UNAVAILABLE` | 当前标签页仍在运行旧版脚本；停止脚本并重新运行仓库中的最新脚本。 |
| 提示 `COMMAND_POLICY_UNAVAILABLE` | 当前 Xshell 标签页没有声明企业安全策略；停止脚本并重新运行 v0.4.0 的最新脚本。 |
| 提示 `DESTRUCTIVE_COMMAND_BLOCKED` | Agent 请求包含硬拦截的危险操作，程序没有发送。确有需要时由用户在 Xshell 中亲自输入。 |
| 提示 `DAEMON_VERSION_MISMATCH` | 本机仍有旧版守护进程；先停止旧进程，再重新打开 Agent 客户端，让 v0.4.0 自动启动。 |
| 提示 `SCP_NOT_FOUND` | 在 Windows“可选功能”中安装 OpenSSH 客户端，再重新打开 Agent。 |
| 提示 `LOCAL_FILE_EXISTS` | `downloads/` 下已有同名文件；程序不会覆盖，请先由你人工核对和改名。 |
| 下载停在认证阶段 | 切换到新打开的 PowerShell 窗口，亲自核对主机指纹并输入密码。 |
| 下载失败后留下 `.part` | 这是安全保留的临时文件；程序不会自动删除或重试，请核对后人工处理。 |
| Xshell 弹出安全确认框 | 核对目标主机、说明、风险和完整输入；同意选“是”，不确定或不同意选“否”。 |
| 弹窗中的中文说明变成 `?` | 正常 Agent 项目配置会直接使用 UTF-8。手动用旧版 Windows PowerShell 管道调试时，应先设置 `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`，否则中文会在进入 MCP 前丢失。 |
| 用户拒绝后工具报错 | 这是正常的安全结果；没有任何输入发送到服务器。 |
| 命令已发送但没有结果 | 先读屏；长命令需要用 `xshell_wait_for` 等待标志文本或提示符。 |
| 守护进程端口冲突 | 修改 `config/local.json` 的本机端口后，重启守护进程和 Agent 客户端。 |

## 安全与审计

- 写操作按 Xshell 标签页串行化，避免多个 Agent 同时输入。
- v0.4.0 只向同时声明支持 `xshell-dialog-v1` 和 `agent-destructive-block-v1` 的新脚本投递写操作；旧脚本默认拒绝。
- `xshell_send` 和 `xshell_interrupt` 强制要求 Agent 提供解释、预期结果及 `low` / `medium` / `high` / `critical` 风险等级。
- 同一目标的低风险连续命令可以合并确认；确认说明必须披露全部动作和中间状态。破坏性或高风险动作必须单独确认。
- 文件删除或清空、`find -delete/-exec`、容器与编排资源删除、数据库删除或清空、磁盘格式化或擦除、软件包卸载、Git 强制清理、关机重启和防火墙规则清空会被守护核心硬性拒绝，不进入 Xshell 队列。Xshell 脚本还会对任务文件做第二次检查。
- MCP 指令禁止 Agent 使用脚本、编码、别名、解释器或拆分命令绕过硬拦截。基于文本的检测仍不能代替服务器最小权限账号、受限 `sudoers`、文件权限和备份；企业服务器应继续使用这些系统级保护。
- 每次命令或文件传输完成后，Agent 必须核验实际输出，并用中文解释成功或失败、关键输出、实际变化及遗留状态；“已批准”或“已发送”不能作为执行成功的依据。
- 密码提示和常见命令行凭据模式会在桥接核心中被拒绝，敏感内容必须由用户直接在 Xshell 输入。
- 最终批准发生在 Xshell 本地“是/否”窗口中，不依赖不同 Agent 客户端各自的审批设置。
- 文件下载参数不提供密码字段；认证输入只发生在独立 OpenSSH 终端。下载先写唯一 `.part` 文件，默认禁止覆盖，最终改名还需要第二次本地确认。
- Agent 后台进程不直接创建桌面窗口；它只写无凭据启动请求，由用户主动运行的 Xshell 脚本校验任务 ID 和项目内路径后，在交互桌面启动认证窗口。
- 下载任务状态位于 `data/transfers/`，下载结果位于 `downloads/`；两个目录都被 Git 忽略，不会上传到 GitHub。
- 默认最大输入长度为 8192 字符；会话超过 5 秒未上报状态会被视为离线；人工确认等待时间至少为 120 秒，旧版本地配置会在内存中自动提升，无需改动令牌文件。
- 写操作元数据会记录到 `data/audit.jsonl`，只保存文本长度等元数据，不保存命令原文。
- `data/` 会短暂保存屏幕快照和待执行输入，已被 Git 忽略，并继承当前 Windows 用户的文件权限。停止脚本后可删除其中的过期会话目录。
- Agent 客户端自身的写工具审批建议继续保留，作为 Xshell 本地确认之外的额外保护。

## 发布与可发现性

README 已使用 Xshell MCP、AI terminal automation 与主流 Agent 的自然语言描述，便于 GitHub、网页搜索和 AI 检索理解项目用途。要让外部用户真正搜到项目，发布到公开 GitHub 仓库时还应：

1. 使用清晰的仓库名，例如 `xshell-agent-bridge`。
2. 设置仓库简介：`Local MCP server that lets AI agents safely control attached Xshell terminal sessions.`
3. 添加 Topics：`xshell`、`mcp`、`model-context-protocol`、`ai-agents`、`terminal-automation`、`codex`、`claude-code`。
4. 保持本 README、版本号和开源许可证完整；公开仓库被搜索引擎收录需要一些时间。

## 开发命令

```powershell
npm test          # 运行测试
npm start         # 启动守护进程
npm run mcp       # 以 MCP stdio 方式启动
npm run demo:bridge # 运行模拟 Xshell 演示
```
