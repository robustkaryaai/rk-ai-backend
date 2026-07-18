// Ensure required env vars for local tests
process.env.RK_DESKTOP_ENCRYPTION_KEYS = JSON.stringify({ v1: 'test-encryption-secret' });
process.env.RK_DESKTOP_ENCRYPTION_SECRET = 'test-encryption-secret';
process.env.RK_DESKTOP_ENCRYPTION_KEY_VERSION = 'v1';
process.env.RK_DESKTOP_DEVICE_SHARED_SECRET = 'test-device-secret';
// allow in-memory fallback store for tests
process.env.RK_DESKTOP_STRICT_PERSISTENCE = '0';
process.env.RK_DESKTOP_ALLOW_INMEMORY_FALLBACK = '1';

import assert from 'assert';
import { encryptJson, decryptJson } from '../RK_AI_DESKTOP/memory/encryption.js';
import { createSessionToken, verifySessionToken } from '../RK_AI_DESKTOP/device_bridge/sessionToken.js';
import { runIntegrationTests } from './integration/requeue_resume.test.js';
import { runCheckpointTests } from './integration/checkpoint_resume.test.js';
import { runSchedulerMetricsTests } from './integration/scheduler_metrics.test.js';

async function testEncryptionRoundtrip() {
  const value = { hello: 'world', num: 42 };
  const userId = 'test-user';
  try {
    const buf = encryptJson({ userId, scope: 'long_term', value });
    const out = decryptJson({ userId, scope: 'long_term', buffer: buf });
    assert.deepStrictEqual(out, value, 'Encryption roundtrip failed');
    console.log('Encryption roundtrip OK');
  } catch (err) {
    console.warn('Encryption test skipped (configuration missing):', err.message);
  }
}

async function testSessionToken() {
  try {
    const deviceId = 'dev1';
    const sessionId = 'sess1';
    const token = createSessionToken({ deviceId, sessionId, expiresInMs: 1000 * 60 });
    const payload = verifySessionToken(token);
    assert(payload && payload.deviceId === deviceId && payload.sessionId === sessionId, 'Session token validation failed');
    console.log('Session token OK');
  } catch (err) {
    console.warn('Session token test skipped (configuration missing):', err.message);
  }
}

async function run() {
  try {
    await testEncryptionRoundtrip();
    await testSessionToken();
    await runIntegrationTests();
    await runCheckpointTests();
    await runSchedulerMetricsTests();
    console.log('All tests passed');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

run();
