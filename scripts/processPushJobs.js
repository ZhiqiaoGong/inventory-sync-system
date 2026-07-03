// One-shot push-job dispatcher: deliver every due write-back job, then exit.
// Suitable as a cron target alongside syncOrdersOnce.js, e.g.:
//   */1 * * * * cd /path/to/app && node scripts/processPushJobs.js
const { processDuePushJobs, listDeadLetterJobs } = require('../src/services');

async function main() {
  const results = await processDuePushJobs();

  if (results.length === 0) {
    console.log('No push jobs due.');
  } else {
    console.table(
      results.map((r) => ({
        job: r.jobId,
        sku: r.internalSku,
        platform: r.platform,
        outcome: r.outcome,
        attempts: r.attempts ?? '',
        error: r.error || ''
      }))
    );
  }

  const dead = listDeadLetterJobs();
  if (dead.length > 0) {
    console.log(`${dead.length} job(s) in the dead-letter queue need human attention.`);
  }
}

main().catch((error) => {
  console.error('Push job processing failed:', error);
  process.exit(1);
});
