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
  getLowStockItems
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
    .prepare('SELECT internal_sku, reason, platform, change_units, before_units, after_units FROM inventory_ledger ORDER BY id')
    .all();
  console.table(ledger);

  section('5. Platform write-back logs (sync_push_logs)');
  const pushLogs = db
    .prepare('SELECT internal_sku, platform, target_quantity, status, message FROM sync_push_logs ORDER BY id')
    .all();
  console.table(pushLogs);

  section('6. Low-stock monitoring (/inventory/low-stock)');
  const lowStock = getLowStockItems();
  if (lowStock.length === 0) {
    console.log('No items are below their threshold.');
  } else {
    console.table(lowStock.map((i) => ({ internal_sku: i.internal_sku, available_units: i.available_units, threshold: i.low_stock_threshold })));
  }

  console.log('\nDemo complete. All of the above used local mock data; no real platform API was called.');
}

main().catch((error) => {
  console.error('Demo failed:', error);
  process.exit(1);
});
