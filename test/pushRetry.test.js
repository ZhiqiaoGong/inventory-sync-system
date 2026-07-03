const { test, before } = require('node:test');
const assert = require('node:assert/strict');

// Deterministic backoff math for this file; read dynamically by services.js.
process.env.PUSH_RETRY_BASE_MS = '1000';
process.env.PUSH_MAX_ATTEMPTS = '5';

const {
  db,
  cleanup,
  importInventoryRows,
  ingestShopifyOrders,
  processDuePushJobs,
  listDeadLetterJobs,
  requeueDeadLetterJob
} = require('./helpers');

process.on('exit', cleanup);

function shopifyJob() {
  return db
    .prepare("SELECT * FROM push_jobs WHERE internal_sku = 'T1' AND platform = 'shopify'")
    .get();
}

before(() => {
  importInventoryRows([
    {
      internal_sku: 'T1',
      product_name: 'Tier 1',
      tier: 'tier1',
      sync_enabled: '1',
      available_units: '100',
      low_stock_threshold: '10',
      shopify_sku: 'T1',
      shopify_variant_id: '1001',
      shopify_inventory_item_id: '11',
      shopify_location_id: '22'
    }
  ]);
});

test('a failed write-back is kept as a pending job scheduled for retry', async () => {
  process.env.MOCK_PUSH_FAILURE_RATE = '1';

  const [result] = await ingestShopifyOrders([
    { id: 100, name: '#100', line_items: [{ sku: 'T1', variant_id: 1001, quantity: 5 }] }
  ]);

  // The sale itself still succeeds: the stock change and the write-back
  // obligation are decoupled by the outbox.
  assert.equal(result.items[0].status, 'synced');

  const job = shopifyJob();
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 1);
  assert.equal(job.target_quantity, 95);
  assert.ok(job.next_attempt_at > Date.now() - 1000, 'retry is scheduled in the future');

  const failedLog = db
    .prepare(
      "SELECT * FROM sync_push_logs WHERE internal_sku = 'T1' AND platform = 'shopify' AND status = 'failed'"
    )
    .get();
  assert.ok(failedLog, 'each failed attempt is logged');
});

test('a second sale coalesces into the pending job instead of stacking a queue', async () => {
  process.env.MOCK_PUSH_FAILURE_RATE = '1';

  await ingestShopifyOrders([
    { id: 101, name: '#101', line_items: [{ sku: 'T1', variant_id: 1001, quantity: 3 }] }
  ]);

  const jobs = db
    .prepare(
      "SELECT * FROM push_jobs WHERE internal_sku = 'T1' AND platform = 'shopify' AND status = 'pending'"
    )
    .all();
  assert.equal(jobs.length, 1, 'still exactly one pending job for the SKU+platform');
  // Absolute-set pushes only need the latest value: 100 - 5 - 3 = 92.
  assert.equal(jobs[0].target_quantity, 92);
  // Coalescing does not burn an attempt.
  assert.equal(jobs[0].attempts, 1);
});

test('retries back off exponentially and dead-letter after max attempts', async () => {
  process.env.MOCK_PUSH_FAILURE_RATE = '1';

  // Attempt 2: fast-forward past the first backoff window.
  const t2 = Date.now() + 60_000;
  const [attempt2] = await processDuePushJobs({ now: t2 });
  assert.equal(attempt2.outcome, 'retry_scheduled');
  assert.equal(attempt2.attempts, 2);
  // base * 2^(attempts-1) = 1000 * 2 = 2000ms after the injected now.
  assert.equal(attempt2.nextAttemptAt, t2 + 2000);

  // Attempt 3.
  const t3 = t2 + 60_000;
  const [attempt3] = await processDuePushJobs({ now: t3 });
  assert.equal(attempt3.outcome, 'retry_scheduled');
  assert.equal(attempt3.nextAttemptAt, t3 + 4000, 'backoff doubles each attempt');

  // Attempts 4 and 5: the 5th exhausts max_attempts and dead-letters.
  const [attempt4] = await processDuePushJobs({ now: t3 + 60_000 });
  assert.equal(attempt4.outcome, 'retry_scheduled');
  const [attempt5] = await processDuePushJobs({ now: t3 + 120_000 });
  assert.equal(attempt5.outcome, 'dead_letter');

  const job = shopifyJob();
  assert.equal(job.status, 'dead_letter');
  assert.equal(job.attempts, 5);
  assert.equal(listDeadLetterJobs().length, 1);

  // Dead-lettered jobs are not picked up again, even far in the future.
  const nothing = await processDuePushJobs({ now: Date.now() + 10 * 60_000 });
  assert.equal(nothing.length, 0);
});

test('a requeued dead-letter job succeeds once the platform recovers', async () => {
  process.env.MOCK_PUSH_FAILURE_RATE = '0';

  const deadJob = listDeadLetterJobs()[0];
  const requeued = requeueDeadLetterJob(deadJob.id);
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attempts, 0, 'a human requeue grants a fresh set of attempts');

  const [delivery] = await processDuePushJobs();
  assert.equal(delivery.outcome, 'succeeded');

  const job = shopifyJob();
  assert.equal(job.status, 'succeeded');
  assert.equal(job.target_quantity, 92, 'the coalesced (latest) value is what gets delivered');

  const successLog = db
    .prepare(
      "SELECT * FROM sync_push_logs WHERE internal_sku = 'T1' AND platform = 'shopify' AND status = 'success'"
    )
    .get();
  assert.ok(successLog);
});

test('requeueing a non-dead-letter job is refused', () => {
  const succeeded = shopifyJob();
  assert.equal(requeueDeadLetterJob(succeeded.id), null);
  assert.equal(requeueDeadLetterJob(999999), null);
});
