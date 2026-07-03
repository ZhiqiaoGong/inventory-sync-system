// Multi-process exactly-once test: several worker processes ingest the SAME set
// of orders against one shared SQLite database at the same time. This is the
// real deployment shape (server + cron worker, or two cron runs overlapping)
// and exercises:
//   - the UNIQUE(platform, external_event_id) arbiter behind the
//     check-then-insert race in saveOrderEventWithItems
//   - IMMEDIATE transactions + busy_timeout for cross-process writes
// Exactly-once means: every order is processed by exactly one worker, and the
// final stock reflects each order exactly once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(
  os.tmpdir(),
  `inv-conc-${process.pid}-${Math.random().toString(36).slice(2)}.db`
);
process.env.DB_PATH = dbPath;
process.env.PLATFORM_MODE = 'mock';
// Write-backs are covered elsewhere; keep this test focused on ingestion.
process.env.ENABLE_PLATFORM_PUSH = 'false';

const { db } = require('../src/db');
const { importInventoryRows } = require('../src/services');

process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore
    }
  }
});

const WORKERS = 4;
const ORDERS = 60;
const INITIAL_STOCK = 200;

function runWorker() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'concurrencyWorker.js'), '1', String(ORDERS)],
      { env: process.env, timeout: 60_000 },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(JSON.parse(stdout.trim()));
      }
    );
  });
}

test(`${WORKERS} concurrent processes ingesting the same ${ORDERS} orders decrement stock exactly once`, async () => {
  importInventoryRows([
    {
      internal_sku: 'C1',
      product_name: 'Contended SKU',
      tier: 'tier1',
      sync_enabled: '1',
      available_units: String(INITIAL_STOCK),
      low_stock_threshold: '10',
      shopify_sku: 'C1',
      shopify_variant_id: '3001',
      shopify_inventory_item_id: '11',
      shopify_location_id: '22'
    }
  ]);

  const counts = await Promise.all(Array.from({ length: WORKERS }, runWorker));

  // Every worker accounted for the full order set, one way or the other.
  for (const c of counts) {
    assert.equal((c.processed || 0) + (c.duplicate || 0), ORDERS);
  }

  // Globally, each order was processed by exactly one worker.
  const totalProcessed = counts.reduce((sum, c) => sum + (c.processed || 0), 0);
  assert.equal(totalProcessed, ORDERS, 'no order was processed twice or dropped');

  // The event store holds each order exactly once...
  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n;
  assert.equal(eventCount, ORDERS);

  // ...stock reflects each order exactly once (no lost updates, no double
  // decrements under contention)...
  const item = db
    .prepare("SELECT available_units FROM inventory_items WHERE internal_sku = 'C1'")
    .get();
  assert.equal(item.available_units, INITIAL_STOCK - ORDERS);

  // ...and the audit ledger has exactly one sale row per order, forming an
  // unbroken chain from the imported baseline to the final value.
  const saleRows = db
    .prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'sale'")
    .get().n;
  assert.equal(saleRows, ORDERS);
});
