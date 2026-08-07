# Agent 客户端接入

Xshell Agent Bridge 的 Agent 接口是标准 MCP stdio。每个客户端只负责启动 `src/mcp-stdio.mjs`；该进程会连接到共享守护进程，守护进程未启动时会自动拉起。

## Codex / ChatGPT desktop

项目已包含使用相对路径的 `.codex/config.toml`。重新打开此项目后，Codex、ChatGPT desktop 和 Codex IDE 扩展会加载这项配置。配置使用 `default_tools_approval_mode = "writes"`；除此之外，桥接脚本还会在 Xshell 内对每一次写操作强制弹窗确认。

也可以添加到用户级配置：

```powershell
codex mcp add xshell --env XSHELL_AGENT_ID=codex -- node "<PROJECT_ROOT>\src\mcp-stdio.mjs"
```

## Kimi Code CLI

项目已包含 `.kimi-code/mcp.json`。安装 Kimi Code CLI 后，在项目目录启动 `kimi`，再运行 `/mcp` 查看 `xshell`。Kimi 对未匹配永久权限规则的 MCP 调用默认询问；不要对全部 `mcp__xshell__*` 设置永久放行，因为其中包含终端写操作。

## Claude Code

项目已包含 `.mcp.json`。在项目目录启动 Claude Code，批准项目级 MCP server 后即可使用。也可手动添加：

```powershell
claude mcp add -s project xshell -e XSHELL_AGENT_ID=claude -- node "<PROJECT_ROOT>\src\mcp-stdio.mjs"
```

## 其他支持 MCP stdio 的 Agent

使用以下等价配置：

```json
{
  "command": "node",
  "args": [
    "<PROJECT_ROOT>\\src\\mcp-stdio.mjs"
  ],
  "cwd": "<PROJECT_ROOT>",
  "env": {
    "XSHELL_AGENT_ID": "your-agent-name"
  }
}
```

同一 Xshell 标签页可以被多个 Agent 同时读取。所有写操作在守护进程中按标签页排队，并逐条显示 Xshell 本地“是/否”确认框，不会并发输入。`<PROJECT_ROOT>` 表示你克隆本仓库后的实际绝对路径。

无论使用哪种 Agent 客户端，密码、口令、Passphrase、PIN、OTP、验证码、Token 和 API Key 都必须由用户直接在 Xshell 中输入。不要给相关写工具设置绕过桥接规则的替代通道。
