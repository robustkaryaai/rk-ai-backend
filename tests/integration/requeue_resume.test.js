import assert from 'assert';
import { createSupabaseDesktopStore } from '../../RK_AI_DESKTOP/providers/supabaseDesktopStore.js';
import { createWeightedScheduler } from '../../RK_AI_DESKTOP/queue/scheduler.js';
import { DESKTOP_PLANS } from '../../RK_AI_DESKTOP/configuration/index.js';
import { JOB_STATUS } from '../../RK_AI_DESKTOP/contracts/job.js';

// small helper to wait
function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function runIntegrationTests() {
  const store = createSupabaseDesktopStore();
  const scheduler = createWeightedScheduler({ store });

  // ensure init doesn't throw
  await scheduler.init();

  // create a job and persist it via store
  const job = {
    id: 'test-job-1',
    plan: DESKTOP_PLANS.core,
    deviceId: 'dev-test',
    createdAt: new Date().toISOString(),
    status: JOB_STATUS.waiting,
  };

  await store.createJob(job);

  // requeue with a small delay and verify it becomes available after the delay
  await scheduler.requeue(job, 150);
  // wait longer than the delay
  await wait(300);

  const next = scheduler.next();
  assert(next && next.id === job.id, 'Requeued job was not enqueued after delay');

  // Now test recovery: create another job with a future next_attempt_at
  const job2 = {
    id: 'test-job-2',
    plan: DESKTOP_PLANS.core,
    deviceId: 'dev-test',
    createdAt: new Date().toISOString(),
    status: JOB_STATUS.waiting,
  };
  const future = new Date(Date.now() + 200).toISOString();
  await store.createJob(job2);
  await store.updateJob(job2.id, { next_attempt_at: future, status: JOB_STATUS.waiting });

  // simulate recovery by starting the recovery loop on the existing scheduler
  if (typeof scheduler.startRecoveryLoop === 'function') scheduler.startRecoveryLoop(100);

  await wait(200);
  // debug: inspect persisted waiting jobs and scheduler snapshot
  try {
    // eslint-disable-next-line no-console
    console.log('Persisted waiting jobs:', await store.listJobsByStatus([JOB_STATUS.waiting]));
    // eslint-disable-next-line no-console
    console.log('Scheduler snapshot after recovery start:', scheduler.snapshot());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Debug error reading store/snapshot', err.message || err);
  }
  // poll for the job to be enqueued (give recovery loop + timer time)
  let next2 = null;
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    next2 = scheduler.next();
    if (next2 && next2.id === job2.id) break;
    // small backoff
    // eslint-disable-next-line no-await-in-loop
    await wait(100);
  }
  assert(next2 && next2.id === job2.id, 'Recovered job was not enqueued after recovery loop');

  console.log('Integration tests (requeue/resume) passed');
}

export default runIntegrationTests;
