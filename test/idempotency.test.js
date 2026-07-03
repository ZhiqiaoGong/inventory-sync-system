const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanup,
  importInventoryRows,
  ingestShopifyOrders,
  getInventorySnapshot
} = require('./helpers');

process.on('exit', cleanup);

function snapshotFor(sku) {
  return getInventorySnapshot().find((i) => i.internal_sku === sku);
}

before(() => {
  importInventoryRows([
    {
      internal_sku: 'IDEM',
      product_name: 'Idempotent',
      tier: 'tier1',
      sync_enabled: '1',
      available_units: '100',
      low_stock_threshold: '10',
      shopify_sku: 'IDEM',
      shopify_variant_id: '7001',
      shopify_inventory_item_id: '11',
      shopify_location_id: '22'
    }
  ]);
});

test('processing the same order twice decrements stock only once', async () => {
  const order = {
    id: 900,
    name: '#900',
    line_items: [{ sku: 'IDEM', variant_id: 7001, quantity: 3 }]
  };

  const [first] = await ingestShopifyOrders([order]);
  assert.equal(first.status, 'processed');
  assert.equal(snapshotFor('IDEM').available_units, 97);

  const [second] = await ingestShopifyOrders([order]);
  assert.equal(second.status, 'duplicate');
  assert.equal(
    snapshotFor('IDEM').available_units,
    97,
    'stock must not be double-counted on replay'
  );
});
