export function requireDesktopBridgeSession(sessions) {
  const bridge = (sessions || []).find((session) => (
    session.online
    && session.metadata?.approvalMode === 'xshell-dialog-v1'
    && session.metadata?.commandPolicyMode === 'agent-destructive-block-v1'
    && session.metadata?.desktopLaunchMode === 'xshell-startfile-v1'
  ));
  if (bridge) return bridge;
  const error = new Error(
    '没有发现可用的新版 Xshell 桌面桥接会话。请先在任一已打开的 Xshell 标签页运行 xshell_agent_bridge.py，再重新发起文件传输。',
  );
  error.code = 'DESKTOP_BRIDGE_UNAVAILABLE';
  throw error;
}
