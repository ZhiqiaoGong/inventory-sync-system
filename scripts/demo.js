// =========================
// One-command end-to-end demo: npm run demo
// =========================
// With no Shopify / Etsy credentials at all, it drives the system with built-in
// mock orders to show the tiered inventory logic: tier1 decrement + write-back,
// tier2 tracked only, tier3 order logged only, and unmatched SKUs flagged.
//
// To make each run deterministic, it uses a throwaway demo.db and clears the
// old one before running.

const fs = require('fs');
const path = require('path');

// These env vars must be set before requiring the business modules, because
// db.js / services.js read them at load time.
process.env.DB_PATH = process.env.DEMO_DB_PATH || './demo.db';
process.env.PLATFORM_MODE = 'mock';
process.env.ENABLE_PLATFORM_PUSH = 'true';

// Remove the previous demo database so this is a clean run.
const demoDbPath = path.resolve(process.env.DB_PATH);
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(demoDbPath + suffix);
  } catch {
    // Ignore if the file does not exist.
  }
}

const { db, initDb } = require('../src/db');
const { parseSimpleCsv } = require('../src/csv');
const {
  importInventoryRows,
  ingestShopifyOrders,
  ingestEtsyReceipts,
  getInventorySnapshot,
  getLowStockItems,
  processDuePushJobs,
  listDeadLetterJobs,
  requeueDeadLetterJob,
  reconcileInventory
} = require('../src/services');
const { fetchShopifyPaidOrders, fetchEtsyReceipts } = require('../src/platforms');

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

async function main() {
  initDb();

  section('1. Import the internal inventory table (sample_inventory.csv)');
  const csvText = fs.readFileSync(path.resolve(__dirname, '../sample_inventory.csv'), 'utf8');
  const rows = parseSimpleCsv(csvText);
  importInventoryRows(rows);
  console.table(
    getInventorySnapshot().map((i) => ({
      internal_sku: i.internal_sku,
      tier: i.tier,
      sync_enabled: i.sync_enabled,
      available_units: i.available_units
    }))
  );

  section('2. Pull and process mock orders (Shopify + Etsy, no credentials needed)');
  const shopifyOrders = await fetchShopifyPaidOrders({ limit: 50 });
  const shopifyResult = await ingestShopifyOrders(shopifyOrders);
  const etsyReceipts = await fetchEtsyReceipts({ limit: 50 });
  const etsyResult = await ingestEtsyReceipts(etsyReceipts);

  const flatItems = [];
  for (const order of [...shopifyResult, ...etsyResult]) {
    for (const item of order.items || []) {
      flatItems.push({
        platform: order.platform,
        order: order.orderId,
        internal_sku: item.internalSku || item.platformSku || '(unknown)',
        qty: item.quantity,
        status: item.status
      });
    }
  }
  console.table(flatItems);

  section('3. Inventory snapshot after processing');
  console.table(
    getInventorySnapshot().map((i) => ({
      internal_sku: i.internal_sku,
      tier: i.tier,
      available_units: i.available_units,
      low_stock_threshold: i.low_stock_threshold
    }))
  );

  section('4. Inventory change ledger (inventory_ledger)');
  const ledger = db
    .prepare(
      'SELECT internal_sku, reason, platform, change_units, before_units, after_units FROM inventory_ledger ORDER BY id'
    )
    .all();
  console.table(ledger);

  section('5. Platform write-back logs (sync_push_logs)');
  const pushLogs = db
    .prepare(
      'SELECT internal_sku, platform, target_quantity, status, message FROM sync_push_logs ORDER BY id'
    )
    .all();
  console.table(pushLogs);

  section('6. Low-stock monitoring (/inventory/low-stock)');
  const lowStock = getLowStockItems();
  if (lowStock.length === 0) {
    console.log('No items are below their threshold.');
  } else {
    console.table(
      lowStock.map((i) => ({
        internal_sku: i.internal_sku,
        available_units: i.available_units,
        threshold: i.low_stock_threshold
      }))
    );
  }

  section('7. Re-running the same sync is idempotent (deduplicated)');
  const shopifyAgain = await ingestShopifyOrders(await fetchShopifyPaidOrders({ limit: 50 }));
  const etsyAgain = await ingestEtsyReceipts(await fetchEtsyReceipts({ limit: 50 }));
  console.table(
    [...shopifyAgain, ...etsyAgain].map((o) => ({
      platform: o.platform,
      order: o.orderId,
      status: o.status
    }))
  );
  const redAfterReplay = getInventorySnapshot().find((i) => i.internal_sku === 'BALLOON-RED-STD');
  console.log(
    `BALLOON-RED-STD is still ${redAfterReplay.available_units} units: the replay did not double-count.`
  );

  section('8. Write-back resilience: retry with backoff, then dead-letter');
  console.log('Simulating a platform outage (every write-back fails) and selling 3 more units...');
  process.env.MOCK_PUSH_FAILURE_RATE = '1';
  await ingestShopifyOrders([
    {
      id: 1005,
      name: '#1005',
      financial_status: 'paid',
      line_items: [
        {
          sku: 'BALLOON-RED-STD',
          variant_id: 111111111,
          quantity: 3,
          price: '9.90',
          title: 'Red Balloon Standard'
        }
      ]
    }
  ]);

  const showJobs = () =>
    console.table(
      db
        .prepare(
          'SELECT id, internal_sku, platform, target_quantity, status, attempts, last_error FROM push_jobs ORDER BY id'
        )
        .all()
    );
  console.log('The sale itself succeeded; the failed write-backs wait in the outbox as jobs:');
  showJobs();

  console.log('Fast-forwarding through the exponential backoff windows (still failing)...');
  for (let round = 0; round < 5; round++) {
    // Inject a far-future "now" so the demo does not sleep through real backoff.
    await processDuePushJobs({ now: Date.now() + (round + 1) * 60 * 60 * 1000 });
  }
  console.log('After exhausting max attempts, the jobs are dead-lettered for a human:');
  showJobs();

  console.log('The platform recovers; an operator requeues the dead-letter jobs...');
  process.env.MOCK_PUSH_FAILURE_RATE = '0';
  for (const job of listDeadLetterJobs()) {
    requeueDeadLetterJob(job.id);
  }
  await processDuePushJobs();
  console.log('The queued (latest) values are delivered exactly once per platform:');
  showJobs();

  section('9. Reconciliation: replaying the ledger catches silent drift');
  const clean = reconcileInventory();
  console.log(
    `Clean check: ${clean.checkedSkus} SKUs replayed from the ledger, consistent = ${clean.consistent}`
  );

  console.log('\nSomeone edits stock directly in the database, bypassing the ledger...');
  db.prepare(
    "UPDATE inventory_items SET available_units = 999 WHERE internal_sku = 'BALLOON-RED-STD'"
  ).run();
  const dirty = reconcileInventory();
  console.table(dirty.mismatches);
  console.log('Reconciliation pinpoints the drifted SKU and the exact delta.');

  // Undo the tampering so the demo database ends in a consistent state.
  const lastGood = dirty.mismatches[0].expected_units;
  db.prepare(
    "UPDATE inventory_items SET available_units = ? WHERE internal_sku = 'BALLOON-RED-STD'"
  ).run(lastGood);

  console.log(
    '\nDemo complete. All of the above used local mock data; no real platform API was called.'
  );
}

main().catch((error) => {
  console.error('Demo failed:', error);
  process.exit(1);
});
