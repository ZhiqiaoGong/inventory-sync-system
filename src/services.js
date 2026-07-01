const { db, statements } = require('./db');
const {
  setShopifyInventoryAbsolute,
  updateEtsyListingInventory
} = require('./platforms');
require('dotenv').config();

const ENABLE_PLATFORM_PUSH = String(process.env.ENABLE_PLATFORM_PUSH).toLowerCase() === 'true';
const DEFAULT_LOW_STOCK_THRESHOLD = Number(process.env.DEFAULT_LOW_STOCK_THRESHOLD || 10);
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID || null;

// ======================================================
// This file is the business logic layer of the system:
// - the platform APIs are just tools
// - the database is just storage
// - the real business rules live here
// ======================================================

function normalizeTier(rawTier) {
  const value = String(rawTier || '').trim().toLowerCase();
  if (['tier1', 'tier2', 'tier3'].includes(value)) return value;
  return 'tier3';
}

function normalizeBoolean(rawValue, defaultValue = false) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return defaultValue ? 1 : 0;
  const value = String(rawValue).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(value) ? 1 : 0;
}

function nullableInt(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const n = Number(rawValue);
  return Number.isNaN(n) ? null : Math.trunc(n);
}

function importInventoryRows(rows) {
  // Bulk-import inventory rows from CSV. Each row is one internal SKU.
  const tx = db.transaction((items) => {
    for (const row of items) {
      const tier = normalizeTier(row.tier);
      const syncEnabled = row.sync_enabled !== undefined
        ? normalizeBoolean(row.sync_enabled)
        : (tier === 'tier1' ? 1 : 0);

      statements.upsertInventoryItem.run({
        internal_sku: row.internal_sku,
        product_name: row.product_name || null,
        tier,
        sync_enabled: syncEnabled,
        monitoring_enabled: row.monitoring_enabled !== undefined
          ? normalizeBoolean(row.monitoring_enabled, true)
          : 1,
        available_units: nullableInt(row.available_units),
        low_stock_threshold: nullableInt(row.low_stock_threshold) ?? DEFAULT_LOW_STOCK_THRESHOLD,
        units_per_pack: nullableInt(row.units_per_pack),
        notes: row.notes || null
      });

      statements.upsertSkuMapping.run({
        internal_sku: row.internal_sku,
        shopify_sku: row.shopify_sku || null,
        shopify_variant_id: row.shopify_variant_id || null,
        shopify_inventory_item_id: row.shopify_inventory_item_id || null,
        shopify_location_id: row.shopify_location_id || SHOPIFY_LOCATION_ID || null,
        etsy_sku: row.etsy_sku || null,
        etsy_listing_id: row.etsy_listing_id || null,
        etsy_offering_id: row.etsy_offering_id || null
      });
    }
  });

  tx(rows);
}

function resolveInternalSkuForShopifyLineItem(item) {
  // Prefer matching by Shopify variant_id, since it is more stable than the name.
  if (item.variant_id != null) {
    const hit = statements.findInventoryItemByShopifyVariantId.get(String(item.variant_id));
    if (hit) return hit;
  }

  // If variant_id is not configured, fall back to matching by SKU.
  const sku = (item.sku || '').trim();
  if (sku) {
    return statements.findInventoryItemByPlatformSku.get(sku, '__NO_ETSY_SKU__') || null;
  }

  return null;
}

function resolveInternalSkuForEtsyLineItem(item) {
  // Be tolerant of different Etsy field names.
  const candidateSku = (item.sku || item.skus || '').toString().trim();
  if (candidateSku) {
    return statements.findInventoryItemByPlatformSku.get('__NO_SHOPIFY_SKU__', candidateSku) || null;
  }
  return null;
}

function saveOrderEventWithItems({ platform, externalEventId, externalOrderId, orderName, orderStatus, rawPayload, items }) {
  // Idempotency: if this event was already processed, do not write it again.
  const existed = statements.findOrderEventByPlatformAndEventId.get(platform, externalEventId);
  if (existed) {
    return { duplicate: true, orderEventId: existed.id };
  }

  const tx = db.transaction(() => {
    const result = statements.insertOrderEvent.run(
      platform,
      externalEventId,
      externalOrderId,
      orderName || null,
      orderStatus || null,
      JSON.stringify(rawPayload || {})
    );

    const orderEventId = result.lastInsertRowid;

    for (const item of items) {
      statements.insertOrderEventItem.run(
        orderEventId,
        platform,
        item.platform_sku || null,
        item.internal_sku || null,
        item.quantity,
        item.unit_price || null,
        item.title || null
      );
    }

    return { duplicate: false, orderEventId };
  });

  return tx();
}

async function pushInventoryToPlatforms(internalSku, targetQuantity) {
  const mapping = statements.findSkuMappingByInternalSku.get(internalSku);
  if (!mapping) {
    statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'skipped', 'no SKU mapping found');
    statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'skipped', 'no SKU mapping found');
    return;
  }

  if (!ENABLE_PLATFORM_PUSH) {
    statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'skipped', 'ENABLE_PLATFORM_PUSH=false');
    statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'skipped', 'ENABLE_PLATFORM_PUSH=false');
    return;
  }

  // ----------------------
  // Shopify write-back
  // ----------------------
  try {
    if (mapping.shopify_inventory_item_id && (mapping.shopify_location_id || SHOPIFY_LOCATION_ID)) {
      await setShopifyInventoryAbsolute({
        inventoryItemId: mapping.shopify_inventory_item_id,
        locationId: mapping.shopify_location_id || SHOPIFY_LOCATION_ID,
        available: targetQuantity
      });
      statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'success', 'Shopify inventory updated');
    } else {
      statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'skipped', 'missing Shopify inventory mapping');
    }
  } catch (error) {
    statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'failed', error.message);
  }

  // ----------------------
  // Etsy write-back
  // ----------------------
  // This provides a call entry point, but the Etsy inventory payload is more
  // complex and depends on each listing's structure. So we take the safest path:
  // - if you have prepared a real listing inventory payload, replace productsPayload
  // - if not yet, just log it instead of force-pushing
  try {
    if (mapping.etsy_listing_id && mapping.etsy_offering_id) {
      const productsPayload = {
        // This is a placeholder example.
        // A real Etsy inventory payload usually needs a fuller products / offerings structure.
        // If your listings share a consistent structure, extend this into a real payload here.
        products: [
          {
            offerings: [
              {
                offering_id: Number(mapping.etsy_offering_id),
                quantity: Number(targetQuantity),
                is_enabled: true
              }
            ]
          }
        ]
      };

      await updateEtsyListingInventory({
        listingId: mapping.etsy_listing_id,
        productsPayload
      });
      statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'success', 'Etsy inventory updated');
    } else {
      statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'skipped', 'missing Etsy mapping / offering id');
    }
  } catch (error) {
    statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'failed', error.message);
  }
}

async function applySaleToInventory({ platform, externalOrderId, internalSku, quantity, notes }) {
  // Sale logic: an order arrives, so stock -= quantity.
  const item = statements.findInventoryItemByInternalSku.get(internalSku);
  if (!item) {
    throw new Error(`internal_sku not found: ${internalSku}`);
  }

  // If this SKU has no unit-level stock, it cannot be auto-decremented.
  // This is exactly the tier2 / tier3 case.
  if (item.available_units === null || item.available_units === undefined) {
    return {
      status: 'tracked_only',
      message: 'this SKU has no reliable unit-level stock; order recorded but not auto-decremented'
    };
  }

  const beforeUnits = Number(item.available_units);
  const afterUnits = beforeUnits - Number(quantity);

  const tx = db.transaction(() => {
    statements.updateInventoryUnits.run(afterUnits, internalSku);
    statements.insertLedger.run(
      internalSku,
      'sale',
      platform,
      externalOrderId,
      -Number(quantity),
      beforeUnits,
      afterUnits,
      notes || null
    );
  });

  tx();

  // Only tier1 with sync_enabled=1 writes back to the platforms.
  if (item.tier === 'tier1' && Number(item.sync_enabled) === 1) {
    await pushInventoryToPlatforms(internalSku, afterUnits);
    return {
      status: 'synced',
      message: 'tier1 SKU: stock decremented and write-back attempted',
      beforeUnits,
      afterUnits
    };
  }

  // tier2: record the change only, no write-back.
  if (item.tier === 'tier2') {
    return {
      status: 'tracked_only',
      message: 'tier2 SKU: internal stock/trend recorded, no write-back',
      beforeUnits,
      afterUnits
    };
  }

  // tier3: keep the manual workflow.
  return {
    status: 'manual',
    message: 'tier3 SKU: manual workflow kept, no write-back',
    beforeUnits,
    afterUnits
  };
}

async function ingestShopifyOrders(orders) {
  const results = [];

  for (const order of orders) {
    const externalEventId = `shopify-order-${order.id}`;
    const externalOrderId = String(order.id);
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

    const normalizedItems = lineItems.map((item) => {
      const resolved = resolveInternalSkuForShopifyLineItem(item);
      return {
        platform_sku: item.sku || null,
        internal_sku: resolved?.internal_sku || null,
        quantity: Number(item.quantity || 0),
        unit_price: item.price || null,
        title: item.title || null
      };
    });

    const saved = saveOrderEventWithItems({
      platform: 'shopify',
      externalEventId,
      externalOrderId,
      orderName: order.name || null,
      orderStatus: order.financial_status || order.fulfillment_status || null,
      rawPayload: order,
      items: normalizedItems
    });

    if (saved.duplicate) {
      results.push({ platform: 'shopify', orderId: externalOrderId, status: 'duplicate' });
      continue;
    }

    const eventResults = [];

    for (const item of normalizedItems) {
      if (!item.internal_sku || item.quantity <= 0) {
        eventResults.push({
          platformSku: item.platform_sku,
          status: 'unresolved',
          message: 'no internal SKU mapping found or invalid quantity'
        });
        continue;
      }

      const applied = await applySaleToInventory({
        platform: 'shopify',
        externalOrderId,
        internalSku: item.internal_sku,
        quantity: item.quantity,
        notes: `Shopify order ${order.name || order.id}`
      });

      eventResults.push({
        internalSku: item.internal_sku,
        quantity: item.quantity,
        ...applied
      });
    }

    statements.markOrderEventProcessed.run(saved.orderEventId);

    results.push({
      platform: 'shopify',
      orderId: externalOrderId,
      status: 'processed',
      items: eventResults
    });
  }

  return results;
}

async function ingestEtsyReceipts(receipts) {
  const results = [];

  for (const receipt of receipts) {
    const externalEventId = `etsy-receipt-${receipt.receipt_id || receipt.transaction_id || receipt.id}`;
    const externalOrderId = String(receipt.receipt_id || receipt.transaction_id || receipt.id);

    const transactions = Array.isArray(receipt.transactions)
      ? receipt.transactions
      : (Array.isArray(receipt.Transactions) ? receipt.Transactions : []);

    const normalizedItems = transactions.map((item) => {
      const resolved = resolveInternalSkuForEtsyLineItem(item);
      return {
        platform_sku: item.sku || item.skus || null,
        internal_sku: resolved?.internal_sku || null,
        quantity: Number(item.quantity || 0),
        unit_price: item.price || null,
        title: item.title || null
      };
    });

    const saved = saveOrderEventWithItems({
      platform: 'etsy',
      externalEventId,
      externalOrderId,
      orderName: receipt.name || `etsy-${externalOrderId}`,
      orderStatus: receipt.status || null,
      rawPayload: receipt,
      items: normalizedItems
    });

    if (saved.duplicate) {
      results.push({ platform: 'etsy', orderId: externalOrderId, status: 'duplicate' });
      continue;
    }

    const eventResults = [];

    for (const item of normalizedItems) {
      if (!item.internal_sku || item.quantity <= 0) {
        eventResults.push({
          platformSku: item.platform_sku,
          status: 'unresolved',
          message: 'no internal SKU mapping found or invalid quantity'
        });
        continue;
      }

      const applied = await applySaleToInventory({
        platform: 'etsy',
        externalOrderId,
        internalSku: item.internal_sku,
        quantity: item.quantity,
        notes: `Etsy receipt ${externalOrderId}`
      });

      eventResults.push({
        internalSku: item.internal_sku,
        quantity: item.quantity,
        ...applied
      });
    }

    statements.markOrderEventProcessed.run(saved.orderEventId);

    results.push({
      platform: 'etsy',
      orderId: externalOrderId,
      status: 'processed',
      items: eventResults
    });
  }

  return results;
}

function getInventorySnapshot() {
  return statements.listInventorySnapshot.all();
}

function getLowStockItems() {
  return statements.listLowStockItems.all();
}

module.exports = {
  importInventoryRows,
  ingestShopifyOrders,
  ingestEtsyReceipts,
  getInventorySnapshot,
  getLowStockItems
};
