# Xshell Agent Bridge - run this file from Xshell's Tools > Script > Run menu.
# Xshell 8 embeds Python 3.8 and injects the global `xsh` automation object.

import json
import os
import re
import time


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
CONFIG_PATH = os.environ.get(
    "XSHELL_BRIDGE_CONFIG",
    os.path.abspath(os.path.join(PROJECT_ROOT, "config", "local.json")),
)


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


CONFIG = load_config()
POLL_MS = int(CONFIG.get("bridge", {}).get("pollIntervalMs", 250))
BRIDGE_ID = os.urandom(16).hex()
PROTOCOL = "xshell-agent-file-v2"
APPROVAL_MODE = "xshell-dialog-v1"
COMMAND_POLICY_MODE = "agent-destructive-block-v1"
RISK_LABELS = {
    "low": "低",
    "medium": "中",
    "high": "高",
    "critical": "严重",
}
IPC_ROOT = os.path.abspath(os.path.join(PROJECT_ROOT, "data", "ipc"))
DESKTOP_LAUNCH_ROOT = os.path.abspath(os.path.join(PROJECT_ROOT, "data", "desktop-launch"))
TRANSFER_ROOT = os.path.abspath(os.path.join(PROJECT_ROOT, "data", "transfers"))
DESKTOP_LAUNCH_PROTOCOL = "xshell-agent-desktop-launch-v1"
SESSION_DIR = os.path.join(IPC_ROOT, BRIDGE_ID)
STATE_PATH = os.path.join(SESSION_DIR, "state.json")
COMMAND_PATH = os.path.join(SESSION_DIR, "command.json")
ACTIVE_PATH = os.path.join(SESSION_DIR, "command.active.json")
RESULT_PATH = os.path.join(SESSION_DIR, "result.json")
LAST_STATE = None
LAST_TOUCH_AT = 0.0
HARD_BLOCKED_INPUT_PATTERNS = (
    (
        "文件删除或内容清空",
        re.compile(
            r"(?:^|[\s;&|()'\"`])(?:/(?:usr/)?bin/)?"
            r"(?:rm|rmdir|unlink|shred|remove-item|clear-content|erase|del|rd)"
            r"(?=[\s;&|()'\"`]|$)",
            re.I,
        ),
    ),
    (
        "脚本删除文件",
        re.compile(
            r"\b(?:os\.(?:remove|unlink)|shutil\.rmtree|fileutils\.rm_rf|"
            r"fs\.(?:rm|unlink)(?:sync)?|[a-z_$][\w$]*\.unlink)\s*\(",
            re.I,
        ),
    ),
    (
        "find 批量删除",
        re.compile(r"\bfind\b[^\r\n]{0,2000}(?:-delete|-exec(?:dir)?\s+)", re.I),
    ),
    (
        "容器或编排资源删除",
        re.compile(
            r"\b(?:(?:docker|podman)\s+"
            r"(?:(?:container|image|volume|network|system|builder)\s+)?(?:rm|rmi|prune)|"
            r"(?:docker|podman)\s+compose\b[^\r\n;&|]{0,240}\bdown\b|"
            r"kubectl\s+delete|helm\s+uninstall|crictl\s+(?:rm|rmi))\b",
            re.I,
        ),
    ),
    (
        "数据库删除或清空",
        re.compile(
            r"(?:^|[\s;\"'`])(?:drop\s+(?:database|schema|table|view|index|user)|"
            r"truncate\s+(?:table\s+)?|delete\s+from)\b",
            re.I,
        ),
    ),
    (
        "磁盘格式化或擦除",
        re.compile(
            r"(?:^|[\s;&|()'\"`])"
            r"(?:mkfs(?:\.[\w-]+)?|wipefs|blkdiscard|fdisk|cfdisk|sfdisk|format-volume)"
            r"(?=[\s;&|()'\"`]|$)|\bdd\b[^\r\n]{0,500}\bof\s*=\s*/dev/",
            re.I,
        ),
    ),
    (
        "软件包卸载",
        re.compile(
            r"\b(?:(?:apt|apt-get)\b[^\r\n;&|]{0,240}\b(?:remove|purge|autoremove)|"
            r"(?:yum|dnf)\b[^\r\n;&|]{0,240}\b(?:remove|erase|autoremove)|"
            r"rpm\b[^\r\n;&|]{0,240}\s-e(?:\s|$)|apk\s+del|pacman\s+-R)\b",
            re.I,
        ),
    ),
    (
        "版本库强制清理",
        re.compile(
            r"\bgit\s+(?:reset\b[^\r\n;&|]{0,240}--hard|"
            r"clean\b[^\r\n;&|]{0,240}(?:-[^\s]*f|--force))\b",
            re.I,
        ),
    ),
    (
        "关机或重启",
        re.compile(
            r"(?:^|[\s;&|()'\"`])(?:shutdown|reboot|poweroff|halt)"
            r"(?=[\s;&|()'\"`]|$)|\bsystemctl\s+(?:poweroff|reboot|halt)\b|"
            r"(?:^|[\s;&|])init\s+[06](?=\s|$)",
            re.I,
        ),
    ),
    (
        "防火墙规则清空",
        re.compile(
            r"\biptables\b[^\r\n;&|]{0,240}(?:\s-F|\s-X|--flush)|"
            r"\bnft\s+flush\s+ruleset\b",
            re.I,
        ),
    ),
)


def atomic_write_json(path, value):
    temporary = path + "." + os.urandom(4).hex() + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
    os.replace(temporary, path)


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def safe_value(getter, default=None):
    try:
        return getter()
    except Exception:
        return default


def metadata():
    return {
        "connected": bool(safe_value(lambda: xsh.Session.Connected, False)),
        "remoteAddress": str(safe_value(lambda: xsh.Session.RemoteAddress, "")),
        "remotePort": int(safe_value(lambda: xsh.Session.RemotePort, 0) or 0),
        "sessionPath": str(safe_value(lambda: xsh.Session.Path, "")),
        "rows": int(safe_value(lambda: xsh.Screen.Rows, 0) or 0),
        "columns": int(safe_value(lambda: xsh.Screen.Columns, 0) or 0),
        "approvalMode": APPROVAL_MODE,
        "commandPolicyMode": COMMAND_POLICY_MODE,
        "desktopLaunchMode": "xshell-startfile-v1",
    }


def capture_screen():
    rows = int(safe_value(lambda: xsh.Screen.Rows, 0) or 0)
    columns = int(safe_value(lambda: xsh.Screen.Columns, 0) or 0)
    if rows < 1 or columns < 1:
        return ""
    return str(xsh.Screen.Get(1, 1, rows, columns))


def write_state():
    global LAST_STATE, LAST_TOUCH_AT
    state = {
        "protocol": PROTOCOL,
        "sessionId": BRIDGE_ID,
        "metadata": metadata(),
        "screen": capture_screen(),
    }
    serialized = json.dumps(state, ensure_ascii=False, sort_keys=True)
    now = time.monotonic()
    if serialized != LAST_STATE or not os.path.exists(STATE_PATH):
        atomic_write_json(STATE_PATH, state)
        LAST_STATE = serialized
        LAST_TOUCH_AT = now
    elif now - LAST_TOUCH_AT >= 1.0:
        os.utime(STATE_PATH, None)
        LAST_TOUCH_AT = now


def approval_message(job):
    action = job.get("action", {})
    if action.get("type") == "send":
        operation = "发送终端输入" + ("并按回车" if action.get("enter", False) else "（不按回车）")
        exact_input = json.dumps(str(action.get("text", "")), ensure_ascii=False)
        for codepoint in range(0x202A, 0x202F):
            exact_input = exact_input.replace(chr(codepoint), "\\u" + format(codepoint, "04x"))
        for codepoint in range(0x2066, 0x206A):
            exact_input = exact_input.replace(chr(codepoint), "\\u" + format(codepoint, "04x"))
    else:
        operation = "发送 Ctrl+C 中断当前命令"
        exact_input = "Ctrl+C"
    remote_address = str(metadata().get("remoteAddress") or "未知主机")
    return (
        "AI Agent 请求执行一个终端操作。\n\n"
        "目标主机：" + remote_address + "\n"
        "Agent：" + str(job.get("agentId", "unknown-agent")) + "\n"
        "操作：" + operation + "\n"
        "风险等级：" + RISK_LABELS.get(str(action.get("riskLevel", "")), "未说明") + "\n\n"
        "为什么要做：\n" + str(action.get("explanation", "")) + "\n\n"
        "预期结果：\n" + str(action.get("expectedOutcome", "")) + "\n\n"
        "将要发送的完整内容（引号内为输入，反斜杠表示转义字符）：\n---\n" + exact_input + "\n---\n\n"
        "只有在你理解并同意以上内容时才点击“是”。点击“否”不会向服务器发送任何内容。"
    )


def request_user_approval(job):
    try:
        # Xshell MessageBox nType=4 displays Yes/No; return value 6 means Yes.
        return int(xsh.Dialog.MessageBox(approval_message(job), "Xshell Agent Bridge 安全确认", 4)) == 6
    except Exception as error:
        raise RuntimeError("无法显示 Xshell 安全确认框，已拒绝执行：" + str(error))


def hard_blocked_operation(text):
    normalized = re.sub(r"\\\r?\n", " ", str(text or ""))
    for category, pattern in HARD_BLOCKED_INPUT_PATTERNS:
        if pattern.search(normalized):
            return category
    return None


def execute_job(job):
    action = job.get("action", {})
    try:
        if action.get("type") == "send":
            blocked_category = hard_blocked_operation(action.get("text", ""))
            if blocked_category:
                raise RuntimeError(
                    "企业安全模式已硬性拦截 Agent 的“"
                    + blocked_category
                    + "”操作。该命令没有发送；如确有需要，请用户在 Xshell 中亲自输入。"
                )
        if not request_user_approval(job):
            atomic_write_json(
                RESULT_PATH,
                {"jobId": job["id"], "job": job, "ok": False, "error": "用户在 Xshell 安全确认框中拒绝了该操作。"},
            )
            return
        if action.get("type") == "send":
            xsh.Screen.Send(action.get("text", ""))
            if action.get("enter", False):
                xsh.Screen.Send("\r")
        elif action.get("type") == "interrupt":
            xsh.Screen.Send(chr(3))
        else:
            raise RuntimeError("unsupported action: " + str(action.get("type")))
        atomic_write_json(
            RESULT_PATH,
            {
                "jobId": job["id"],
                "job": job,
                "ok": True,
                "result": {"acceptedByXshell": True, "approvedByUser": True},
            },
        )
    except Exception as error:
        atomic_write_json(
            RESULT_PATH,
            {"jobId": job["id"], "job": job, "ok": False, "error": str(error)},
        )


def valid_transfer_id(value):
    value = str(value)
    return len(value) == 36 and all(character in "0123456789abcdef-" for character in value.lower())


def transfer_state(transfer_id, status, stage, error=None):
    value = {
        "transferId": transfer_id,
        "status": status,
        "stage": stage,
        "updatedAt": time.time(),
    }
    if error:
        value["error"] = str(error)
    return value


def process_desktop_launch_requests():
    os.makedirs(DESKTOP_LAUNCH_ROOT, exist_ok=True)
    for name in sorted(os.listdir(DESKTOP_LAUNCH_ROOT)):
        if not name.endswith(".request.json"):
            continue
        request_path = os.path.join(DESKTOP_LAUNCH_ROOT, name)
        active_path = request_path[:-len(".request.json")] + ".active.json"
        try:
            os.replace(request_path, active_path)
        except OSError:
            continue

        transfer_id = name[:-len(".request.json")]
        transfer_dir = os.path.abspath(os.path.join(TRANSFER_ROOT, transfer_id))
        progress_path = os.path.join(transfer_dir, "progress.json")
        result_path = os.path.join(transfer_dir, "result.json")
        try:
            request = read_json(active_path)
            if request.get("protocol") != DESKTOP_LAUNCH_PROTOCOL:
                raise RuntimeError("不支持的桌面启动协议。")
            if request.get("transferId") != transfer_id or not valid_transfer_id(transfer_id):
                raise RuntimeError("文件传输任务 ID 不合法。")
            if os.path.commonpath([TRANSFER_ROOT, transfer_dir]) != TRANSFER_ROOT:
                raise RuntimeError("文件传输任务路径越界。")

            spec_path = os.path.join(transfer_dir, "spec.json")
            launch_path = os.path.join(transfer_dir, "launch.cmd")
            if not os.path.isfile(spec_path) or not os.path.isfile(launch_path):
                raise RuntimeError("文件传输计划或桌面启动文件不存在。")
            spec = read_json(spec_path)
            if spec.get("transferId") != transfer_id:
                raise RuntimeError("文件传输计划与任务 ID 不匹配。")

            approved = int(xsh.Dialog.MessageBox(
                str(spec.get("texts", {}).get("initialApproval", "是否启动文件传输？")),
                str(spec.get("texts", {}).get("title", "Xshell Agent Bridge 文件传输确认")),
                4,
            )) == 6
            if not approved:
                atomic_write_json(result_path, transfer_state(
                    transfer_id,
                    "rejected",
                    "initial_approval",
                    "用户在 Xshell 文件传输确认框中拒绝了该操作。",
                ))
                continue

            os.startfile(launch_path)
            atomic_write_json(progress_path, transfer_state(
                transfer_id,
                "awaiting_user",
                "authentication_and_transfer",
            ))
        except Exception as error:
            if valid_transfer_id(transfer_id) and os.path.isdir(transfer_dir):
                atomic_write_json(result_path, transfer_state(
                    transfer_id,
                    "failed",
                    "desktop_launch",
                    error,
                ))
        finally:
            try:
                os.remove(active_path)
            except OSError:
                pass


def Main():
    xsh.Screen.Synchronous = True
    os.makedirs(SESSION_DIR, exist_ok=True)
    os.makedirs(DESKTOP_LAUNCH_ROOT, exist_ok=True)
    write_state()

    while True:
        try:
            write_state()
            process_desktop_launch_requests()
            if os.path.exists(COMMAND_PATH) and not os.path.exists(ACTIVE_PATH):
                # Claim before execution. An uncertain input is never replayed after a crash.
                os.replace(COMMAND_PATH, ACTIVE_PATH)
                execute_job(read_json(ACTIVE_PATH))
                write_state()
        except Exception:
            # Keep the script alive; the daemon can restart independently.
            pass
        xsh.Session.Sleep(POLL_MS)
