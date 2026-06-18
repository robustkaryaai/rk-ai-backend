import assert from 'assert';
import { createSupabaseDesktopStore } from '../../RK_AI_DESKTOP/providers/supabaseDesktopStore.js';
import { createWeightedScheduler } from '../../RK_AI_DESKTOP/queue/scheduler.js';
import { DESKTOP_PLANS } from '../../RK_AI_DESKTOP/configuration/index.js';
import { metrics } from '../../RK_AI_DESKTOP/observability/metrics.js';
import { JOB_STATUS } from '../../RK_AI_DESKTOP/contracts/job.js';

export async function runSchedulerMetricsTests() {
  metrics.reset();
  const store = createSupabaseDesktopStore();
  const scheduler = createWeightedScheduler({ store });
  await scheduler.init();

  const job = { id: 'mjob-1', plan: DESKTOP_PLANS.core, deviceId: 'dev-x', createdAt: new Date().toISOString(), status: JOB_STATUS.waiting };
  scheduler.enqueue(job);
  assert.strictEqual(metrics.get('jobs_enqueued'), 1, 'jobs_enqueued should be 1');

  await scheduler.requeue(job, 0);
  // allow any async persistence
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(metrics.get('jobs_requeued'), 1, 'jobs_requeued should be 1');

  const dequeued = scheduler.next();
  assert(dequeued && dequeued.id === job.id, 'job should be dequeued');
  assert.strictEqual(metrics.get('jobs_dequeued'), 1, 'jobs_dequeued should be 1');

  console.log('Scheduler metrics integration test passed');
}

export default runSchedulerMetricsTests;
