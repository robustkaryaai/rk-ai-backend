import assert from 'assert';
import { createSupabaseDesktopStore } from '../../RK_AI_DESKTOP/providers/supabaseDesktopStore.js';

export async function runCheckpointTests() {
  const store = createSupabaseDesktopStore();
  const jobId = 'checkpoint-job-1';
  const checkpoint = {
    sequence: 1,
    lifecycleStage: 'in_progress',
    plan: { steps: ['a', 'b'] },
    stepResults: { a: { ok: true } },
  };

  await store.saveCheckpoint(jobId, checkpoint);
  const rec = await store.getLatestCheckpoint(jobId);
  const payload = await store.loadCheckpointPayload(rec);
  assert.deepStrictEqual(payload, checkpoint, 'Checkpoint payload mismatch');
  console.log('Checkpoint resume integration test passed');
}

export default runCheckpointTests;
