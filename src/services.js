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
// 这个文件是整个系统的“业务逻辑层”。
// 也就是说：
// - 平台 API 只是工具
// - 数据库只是存储
// - 真正的业务规则在这里
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
  // 这里提供一个批量导入库存 CSV 的逻辑。
  // 每一行代表一个内部 SKU。
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
  // 优先按 Shopify variant_id 匹配，因为它比名称更稳定。
  if (item.variant_id != null) {
    const hit = statements.findInventoryItemByShopifyVariantId.get(String(item.variant_id));
    if (hit) return hit;
  }

  // 如果 variant_id 没配好，再退化到按 SKU 匹配。
  const sku = (item.sku || '').trim();
  if (sku) {
    return statements.findInventoryItemByPlatformSku.get(sku, '__NO_ETSY_SKU__') || null;
  }

  return null;
}

function resolveInternalSkuForEtsyLineItem(item) {
  // 这里尽量兼容不同 Etsy 数据字段命名。
  const candidateSku = (item.sku || item.skus || '').toString().trim();
  if (candidateSku) {
    return statements.findInventoryItemByPlatformSku.get('__NO_SHOPIFY_SKU__', candidateSku) || null;
  }
  return null;
}

function saveOrderEventWithItems({ platform, externalEventId, externalOrderId, orderName, orderStatus, rawPayload, items }) {
  // 幂等：如果这个事件之前已经处理过，就不重复写入。
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
    statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'skipped', '找不到 SKU mapping');
    statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'skipped', '找不到 SKU mapping');
    return;
  }

  if (!ENABLE_PLATFORM_PUSH) {
    statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'skipped', 'ENABLE_PLATFORM_PUSH=false');
    statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'skipped', 'ENABLE_PLATFORM_PUSH=false');
    return;
  }

  // ----------------------
  // Shopify 推送
  // ----------------------
  try {
    if (mapping.shopify_inventory_item_id && (mapping.shopify_location_id || SHOPIFY_LOCATION_ID)) {
      await setShopifyInventoryAbsolute({
        inventoryItemId: mapping.shopify_inventory_item_id,
        locationId: mapping.shopify_location_id || SHOPIFY_LOCATION_ID,
        available: targetQuantity
      });
      statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'success', 'Shopify 库存更新成功');
    } else {
      statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'skipped', '缺少 Shopify inventory mapping');
    }
  } catch (error) {
    statements.insertSyncPushLog.run(internalSku, 'shopify', targetQuantity, 'failed', error.message);
  }

  // ----------------------
  // Etsy 推送
  // ----------------------
  // 这里提供了一个“接口入口”，但 Etsy inventory payload 在不同 listing 结构下会更复杂。
  // 所以这里采取最稳妥的做法：
  // - 如果你已经整理好了 listing inventory payload 结构，可以直接替换 productsPayload
  // - 如果暂时还没整理好，先记日志，不硬推送
  try {
    if (mapping.etsy_listing_id && mapping.etsy_offering_id) {
      const productsPayload = {
        // 这里是一个占位示例。
        // 真实 Etsy inventory payload 通常需要更完整的 products / offerings 结构。
        // 如果你的店里 listing 结构统一，你可以在这里扩展成真实 payload。
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
      statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'success', 'Etsy 库存更新成功');
    } else {
      statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'skipped', '缺少 Etsy mapping / offering id');
    }
  } catch (error) {
    statements.insertSyncPushLog.run(internalSku, 'etsy', targetQuantity, 'failed', error.message);
  }
}

async function applySaleToInventory({ platform, externalOrderId, internalSku, quantity, notes }) {
  // 销售逻辑：订单来了，库存 -= quantity。
  const item = statements.findInventoryItemByInternalSku.get(internalSku);
  if (!item) {
    throw new Error(`internal_sku 不存在: ${internalSku}`);
  }

  // 如果这个 SKU 没有件级库存，就不能自动扣减。
  // 这正对应 tier2 / tier3 的情况。
  if (item.available_units === null || item.available_units === undefined) {
    return {
      status: 'tracked_only',
      message: '该 SKU 目前没有可靠件级库存，仅记录订单，不自动扣减'
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

  // 只有 tier1 且 sync_enabled=1，才执行平台回写。
  if (item.tier === 'tier1' && Number(item.sync_enabled) === 1) {
    await pushInventoryToPlatforms(internalSku, afterUnits);
    return {
      status: 'synced',
      message: 'tier1 SKU 已扣减库存并尝试回写平台',
      beforeUnits,
      afterUnits
    };
  }

  // tier2：只记录变化，不回写平台。
  if (item.tier === 'tier2') {
    return {
      status: 'tracked_only',
      message: 'tier2 SKU 已记录内部库存/趋势，不回写平台',
      beforeUnits,
      afterUnits
    };
  }

  // tier3：保留人工流程。
  return {
    status: 'manual',
    message: 'tier3 SKU 保留人工流程，不回写平台',
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
          message: '没有找到 internal SKU mapping 或数量无效'
        });
        continue;
      }

      const applied = await applySaleToInventory({
        platform: 'shopify',
        externalOrderId,
        internalSku: item.internal_sku,
        quantity: item.quantity,
        notes: `Shopify 订单 ${order.name || order.id}`
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
          message: '没有找到 internal SKU mapping 或数量无效'
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
