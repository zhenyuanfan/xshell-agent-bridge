import assert from 'node:assert/strict';
import test from 'node:test';
import { requireDesktopBridgeSession } from '../src/desktop-bridge.mjs';

test('requires an online v2 Xshell bridge before starting a desktop transfer', () => {
  assert.throws(
    () => requireDesktopBridgeSession([]),
    (error) => error.code === 'DESKTOP_BRIDGE_UNAVAILABLE',
  );
  assert.throws(
    () => requireDesktopBridgeSession([{
      online: true,
      metadata: { approvalMode: 'xshell-dialog-v1', commandPolicyMode: 'agent-destructive-block-v1' },
    }]),
    (error) => error.code === 'DESKTOP_BRIDGE_UNAVAILABLE',
  );
  const bridge = requireDesktopBridgeSession([{
    id: 'desktop-ready',
    online: true,
    metadata: {
      approvalMode: 'xshell-dialog-v1',
      commandPolicyMode: 'agent-destructive-block-v1',
      desktopLaunchMode: 'xshell-startfile-v1',
    },
  }]);
  assert.equal(bridge.id, 'desktop-ready');
});
