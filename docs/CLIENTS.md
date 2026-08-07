# Agent 客户端接入

Xshell Agent Bridge 的 Agent 接口是标准 MCP stdio。每个客户端只负责启动 `src/mcp-stdio.mjs`；该进程会连接到共享守护进程，守护进程未启动时会自动拉起。

## Codex / ChatGPT desktop

项目已包含 `.codex/config.toml`。重新打开此项目后，Codex、ChatGPT desktop 和 Codex IDE 扩展会共享这项配置。配置使用 `default_tools_approval_mode = "writes"`：读取工具可直接调用，`xshell_send` 与 `xshell_interrupt` 请求审批。

也可以添加到用户级配置：

```powershell
codex mcp add xshell --env XSHELL_AGENT_ID=codex -- node "C:\Users\大佬\Documents\ChatGPT\codex操控xshell\src\mcp-stdio.mjs"
```

## Kimi Code CLI

项目已包含 `.kimi-code/mcp.json`。安装 Kimi Code CLI 后，在项目目录启动 `kimi`，再运行 `/mcp` 查看 `xshell`。Kimi 对未匹配永久权限规则的 MCP 调用默认询问；不要对全部 `mcp__xshell__*` 设置永久放行，因为其中包含终端写操作。

## Claude Code

项目已包含 `.mcp.json`。在项目目录启动 Claude Code，批准项目级 MCP server 后即可使用。也可手动添加：

```powershell
claude mcp add -s project xshell -e XSHELL_AGENT_ID=claude -- node "C:\Users\大佬\Documents\ChatGPT\codex操控xshell\src\mcp-stdio.mjs"
```

## 其他支持 MCP stdio 的 Agent

使用以下等价配置：

```json
{
  "command": "node",
  "args": [
    "C:\\Users\\大佬\\Documents\\ChatGPT\\codex操控xshell\\src\\mcp-stdio.mjs"
  ],
  "cwd": "C:\\Users\\大佬\\Documents\\ChatGPT\\codex操控xshell",
  "env": {
    "XSHELL_AGENT_ID": "your-agent-name"
  }
}
```

同一 Xshell 标签页可以被多个 Agent 同时读取。所有写操作在守护进程中按标签页排队，不会并发输入。
