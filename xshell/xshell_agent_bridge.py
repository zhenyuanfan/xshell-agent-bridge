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
        "protocol": "xshell-agent-file-v1",
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


def execute_job(job):
    action = job.get("action", {})
    try:
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
            {"jobId": job["id"], "job": job, "ok": True, "result": {"acceptedByXshell": True}},
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
