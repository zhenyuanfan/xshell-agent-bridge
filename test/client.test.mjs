import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCompatibleDaemon } from '../src/client.mjs';

test('accepts only the v0.2.0 daemon safety protocol', () => {
  assert.doesNotThrow(() => requireCompatibleDaemon({ version: '0.2.0' }));
  assert.throws(
    () => requireCompatibleDaemon({ version: '0.1.0' }),
    (error) => error.code === 'DAEMON_VERSION_MISMATCH' && /Stop the old daemon/.test(error.message),
  );
});
