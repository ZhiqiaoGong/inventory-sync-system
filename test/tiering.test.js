const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  cleanup,
  importInventoryRows,
  ingestShopifyOrders,
  getInventorySnapshot,
  getLowStockItems
} = require('./helpers');

process.on('exit', cleanup);

function snapshotFor(sku) {
  return getInventorySnapshot().find((i) => i.internal_sku === sku);
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
    },
    {
      internal_sku: 'T2',
      product_name: 'Tier 2',
      tier: 'tier2',
      sync_enabled: '0',
      available_units: '50',
      low_stock_threshold: '5',
      shopify_sku: 'T2'
    },
    {
      internal_sku: 'T3',
      product_name: 'Tier 3',
      tier: 'tier3',
      sync_enabled: '0',
      available_units: '',
      low_stock_threshold: '5',
      shopify_sku: 'T3'
    }
  ]);
});

test('tier1 sale decrements stock, reports synced, and writes a push log', async () => {
  const [result] = await ingestShopifyOrders([
    { id: 100, name: '#100', line_items: [{ sku: 'T1', variant_id: 1001, quantity: 5 }] }
  ]);

  assert.equal(result.items[0].status, 'synced');
  assert.equal(snapshotFor('T1').available_units, 95);

  const pushLog = db
    .prepare("SELECT * FROM sync_push_logs WHERE internal_sku = 'T1' AND platform = 'shopify'")
    .get();
  assert.equal(pushLog.status, 'success');
  assert.equal(pushLog.target_quantity, 95);
});

test('tier2 sale decrements internal stock but does not push', async () => {
  const [result] = await ingestShopifyOrders([
    { id: 200, name: '#200', line_items: [{ sku: 'T2', quantity: 4 }] }
  ]);

  assert.equal(result.items[0].status, 'tracked_only');
  assert.equal(snapshotFor('T2').available_units, 46);

  const pushCount = db
    .prepare("SELECT COUNT(*) AS n FROM sync_push_logs WHERE internal_sku = 'T2'")
    .get();
  assert.equal(pushCount.n, 0);
});

test('tier3 with no unit-level stock is tracked only and never decremented', async () => {
  const [result] = await ingestShopifyOrders([
    { id: 300, name: '#300', line_items: [{ sku: 'T3', quantity: 1 }] }
  ]);

  assert.equal(result.items[0].status, 'tracked_only');
  assert.equal(snapshotFor('T3').available_units, null);
});

test('an unknown SKU is reported as unresolved', async () => {
  const [result] = await ingestShopifyOrders([
    { id: 400, name: '#400', line_items: [{ sku: 'DOES-NOT-EXIST', quantity: 1 }] }
  ]);

  assert.equal(result.items[0].status, 'unresolved');
});

test('oversell clamps stock to zero and flags oversold', async () => {
  const before = snapshotFor('T1').available_units; // 95 after the first test
  const [result] = await ingestShopifyOrders([
    {
      id: 500,
      name: '#500',
      line_items: [{ sku: 'T1', variant_id: 1001, quantity: before + 1000 }]
    }
  ]);

  assert.equal(result.items[0].oversold, true);
  assert.equal(snapshotFor('T1').available_units, 0);

  // The ledger stays consistent: before + change === after, never negative.
  const ledger = db
    .prepare("SELECT * FROM inventory_ledger WHERE internal_sku = 'T1' ORDER BY id DESC")
    .get();
  assert.equal(ledger.after_units, 0);
  assert.equal(ledger.before_units + ledger.change_units, ledger.after_units);
});

test('low-stock view lists items at or below their threshold', () => {
  // T1 is now at 0 (<= 10) after the oversell test.
  const lowSkus = getLowStockItems().map((i) => i.internal_sku);
  assert.ok(lowSkus.includes('T1'));
});
