const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  cleanup,
  importInventoryRows,
  ingestShopifyOrders,
  reconcileInventory,
  listReconciliationRuns
} = require('./helpers');

process.on('exit', cleanup);

before(async () => {
  importInventoryRows([
    {
      internal_sku: 'R1',
      product_name: 'Reconciled 1',
      tier: 'tier1',
      sync_enabled: '1',
      available_units: '100',
      low_stock_threshold: '10',
      shopify_sku: 'R1',
      shopify_variant_id: '2001',
      shopify_inventory_item_id: '11',
      shopify_location_id: '22'
    },
    {
      internal_sku: 'R2',
      product_name: 'Reconciled 2',
      tier: 'tier2',
      sync_enabled: '0',
      available_units: '50',
      low_stock_threshold: '5',
      shopify_sku: 'R2'
    }
  ]);

  await ingestShopifyOrders([
    { id: 700, name: '#700', line_items: [{ sku: 'R1', variant_id: 2001, quantity: 5 }] },
    { id: 701, name: '#701', line_items: [{ sku: 'R2', quantity: 4 }] }
  ]);
});

test('a healthy system reconciles clean: imports and sales replay to live stock', () => {
  const report = reconcileInventory();

  assert.equal(report.consistent, true);
  assert.equal(report.checkedSkus, 2, 'both SKUs have ledger history (import baseline + sale)');
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.chainViolations.length, 0);
});

test('an out-of-band stock edit is detected as drift with the exact delta', () => {
  // Someone edits stock directly, bypassing the ledger (the classic silent bug).
  db.prepare("UPDATE inventory_items SET available_units = 80 WHERE internal_sku = 'R1'").run();

  const report = reconcileInventory();

  assert.equal(report.consistent, false);
  assert.equal(report.mismatches.length, 1);
  const drift = report.mismatches[0];
  assert.equal(drift.internal_sku, 'R1');
  assert.equal(drift.expected_units, 95); // 100 imported - 5 sold
  assert.equal(drift.actual_units, 80);
  assert.equal(drift.delta, -15);

  // Restore for the following tests.
  db.prepare("UPDATE inventory_items SET available_units = 95 WHERE internal_sku = 'R1'").run();
  assert.equal(reconcileInventory().consistent, true);
});

test('a tampered ledger row is caught as a chain violation', () => {
  const saleRow = db
    .prepare(
      "SELECT * FROM inventory_ledger WHERE internal_sku = 'R2' AND reason = 'sale' ORDER BY id DESC"
    )
    .get();
  db.prepare('UPDATE inventory_ledger SET change_units = -2 WHERE id = ?').run(saleRow.id);

  const report = reconcileInventory();

  assert.equal(report.consistent, false);
  assert.ok(
    report.chainViolations.some(
      (v) => v.internal_sku === 'R2' && v.type === 'broken_row' && v.ledger_id === saleRow.id
    )
  );

  // Restore.
  db.prepare('UPDATE inventory_ledger SET change_units = -4 WHERE id = ?').run(saleRow.id);
});

test('reconciliation runs are persisted for auditability', () => {
  const runs = listReconciliationRuns();
  assert.ok(runs.length >= 4, 'each reconcile() call above left an audit row');

  const latest = runs[0];
  assert.equal(latest.checked_skus, 2);
  const details = JSON.parse(latest.details);
  assert.ok(Array.isArray(details.mismatches));
  assert.ok(Array.isArray(details.chainViolations));
});

test('a re-import at a new quantity is a ledger event, not drift', async () => {
  // The team recounts the shelf and imports R2 at 60 (was 46 after the sale).
  importInventoryRows([
    {
      internal_sku: 'R2',
      product_name: 'Reconciled 2',
      tier: 'tier2',
      sync_enabled: '0',
      available_units: '60',
      low_stock_threshold: '5',
      shopify_sku: 'R2'
    }
  ]);

  const report = reconcileInventory();
  assert.equal(report.consistent, true, 'the import wrote its own ledger row, so replay matches');

  const importRows = db
    .prepare(
      "SELECT * FROM inventory_ledger WHERE internal_sku = 'R2' AND reason = 'import_snapshot' ORDER BY id"
    )
    .all();
  assert.equal(importRows.length, 2, 'initial import + recount import');
  assert.equal(importRows[1].before_units, 46);
  assert.equal(importRows[1].after_units, 60);
});
