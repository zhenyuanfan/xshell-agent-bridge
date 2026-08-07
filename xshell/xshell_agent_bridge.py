# Xshell Agent Bridge - run this file from Xshell's Tools > Script > Run menu.
# Xshell 8 embeds Python 3.8 and injects the global `xsh` automation object.

import json
import os
import time


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get(
    "XSHELL_BRIDGE_CONFIG",
    os.path.abspath(os.path.join(SCRIPT_DIR, "..", "config", "local.json")),
)


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


CONFIG = load_config()
POLL_MS = int(CONFIG.get("bridge", {}).get("pollIntervalMs", 250))
BRIDGE_ID = os.urandom(16).hex()
PROTOCOL = "xshell-agent-file-v2"
APPROVAL_MODE = "xshell-dialog-v1"
RISK_LABELS = {
    "low": "低",
    "medium": "中",
    "high": "高",
    "critical": "严重",
}
IPC_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "data", "ipc"))
SESSION_DIR = os.path.join(IPC_ROOT, BRIDGE_ID)
STATE_PATH = os.path.join(SESSION_DIR, "state.json")
COMMAND_PATH = os.path.join(SESSION_DIR, "command.json")
ACTIVE_PATH = os.path.join(SESSION_DIR, "command.active.json")
RESULT_PATH = os.path.join(SESSION_DIR, "result.json")
LAST_STATE = None
LAST_TOUCH_AT = 0.0


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


def execute_job(job):
    action = job.get("action", {})
    try:
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


def Main():
    xsh.Screen.Synchronous = True
    os.makedirs(SESSION_DIR, exist_ok=True)
    write_state()

    while True:
        try:
            write_state()
            if os.path.exists(COMMAND_PATH) and not os.path.exists(ACTIVE_PATH):
                # Claim before execution. An uncertain input is never replayed after a crash.
                os.replace(COMMAND_PATH, ACTIVE_PATH)
                execute_job(read_json(ACTIVE_PATH))
                write_state()
        except Exception:
            # Keep the script alive; the daemon can restart independently.
            pass
        xsh.Session.Sleep(POLL_MS)
