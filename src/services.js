const { db, statements } = require('./db');
const { setShopifyInventoryAbsolute, updateEtsyListingInventory } = require('./platforms');
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
  const value = String(rawTier || '')
    .trim()
    .toLowerCase();
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
      const syncEnabled =
        row.sync_enabled !== undefined
          ? normalizeBoolean(row.sync_enabled)
          : tier === 'tier1'
            ? 1
            : 0;

      // Snapshot the current units before the upsert so the ledger can record
      // the import as an auditable change (and reconciliation can replay it).
      const existing = statements.findInventoryItemByInternalSku.get(row.internal_sku);

      statements.upsertInventoryItem.run({
        internal_sku: row.internal_sku,
        product_name: row.product_name || null,
        tier,
        sync_enabled: syncEnabled,
        monitoring_enabled:
          row.monitoring_enabled !== undefined ? normalizeBoolean(row.monitoring_enabled, true) : 1,
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

      // Ledger baseline: every unit-level change made by an import is recorded
      // with before/after, same as a sale. Re-importing identical units writes
      // nothing, so imports stay idempotent in the ledger too.
      const newUnits = nullableInt(row.available_units);
      const oldUnits = existing ? existing.available_units : null;
      if (newUnits !== null && newUnits !== oldUnits) {
        statements.insertLedger.run(
          row.internal_sku,
          'import_snapshot',
          null,
          null,
          newUnits - (oldUnits ?? 0),
          oldUnits,
          newUnits,
          existing ? 'import changed units' : 'initial import'
        );
      }
    }
  });

  tx.immediate(rows);
}

// ======================================================
// Reconciliation
//
// The ledger is an append-only chain per SKU: each row records before/after.
// Replaying it gives an independently derived "expected stock", checked two
// ways against the live table:
//   1. chain integrity: before + change === after, and each row's `before`
//      links to the previous row's `after`
//   2. drift: the final `after` in the chain must equal available_units
// Any out-of-band edit (a manual UPDATE, a bug, a missed ledger write) shows
// up as a violation or a drift row.
// ======================================================

function reconcileInventory({ persist = true } = {}) {
  const items = statements.listInventorySnapshot.all();
  const mismatches = [];
  const chainViolations = [];
  let checkedSkus = 0;

  for (const item of items) {
    const rows = statements.listLedgerBySku.all(item.internal_sku);
    if (rows.length === 0) continue; // no history to replay (e.g. tier3 without unit stock)
    checkedSkus++;

    let prevAfter = null;
    for (const row of rows) {
      const before = row.before_units;
      const after = row.after_units;

      if ((before ?? 0) + row.change_units !== after) {
        chainViolations.push({
          internal_sku: item.internal_sku,
          ledger_id: row.id,
          type: 'broken_row',
          detail: `before(${before}) + change(${row.change_units}) != after(${after})`
        });
      }

      // A null `before` is a baseline reset (first import); otherwise the
      // chain must be gapless.
      if (before !== null && prevAfter !== null && before !== prevAfter) {
        chainViolations.push({
          internal_sku: item.internal_sku,
          ledger_id: row.id,
          type: 'chain_gap',
          detail: `row starts at ${before} but previous row ended at ${prevAfter}`
        });
      }

      prevAfter = after;
    }

    const expectedUnits = prevAfter;
    const actualUnits = item.available_units;
    if (expectedUnits !== null && actualUnits !== expectedUnits) {
      mismatches.push({
        internal_sku: item.internal_sku,
        expected_units: expectedUnits,
        actual_units: actualUnits,
        delta: (actualUnits ?? 0) - expectedUnits
      });
    }
  }

  const report = {
    checkedSkus,
    consistent: mismatches.length === 0 && chainViolations.length === 0,
    mismatches,
    chainViolations
  };

  if (persist) {
    statements.insertReconciliationRun.run(
      checkedSkus,
      mismatches.length,
      chainViolations.length,
      JSON.stringify({ mismatches, chainViolations })
    );
  }

  return report;
}

function listReconciliationRuns() {
  return statements.listReconciliationRuns.all();
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
    return (
      statements.findInventoryItemByPlatformSku.get('__NO_SHOPIFY_SKU__', candidateSku) || null
    );
  }
  return null;
}

function saveOrderEventWithItems({
  platform,
  externalEventId,
  externalOrderId,
  orderName,
  orderStatus,
  rawPayload,
  items
}) {
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

  try {
    // IMMEDIATE: take the write lock before inserting, so two processes cannot
    // interleave between the existence check above and the insert.
    return tx.immediate();
  } catch (error) {
    // The check above races with other processes ingesting the same order: both
    // can see "not there yet", but the UNIQUE(platform, external_event_id)
    // constraint arbitrates — the loser lands here and treats it as a duplicate.
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      const winner = statements.findOrderEventByPlatformAndEventId.get(platform, externalEventId);
      return { duplicate: true, orderEventId: winner ? winner.id : null };
    }
    throw error;
  }
}

// ======================================================
// Platform write-back pipeline (transactional outbox)
//
// A tier1 sale does NOT call the platform APIs directly. Instead it enqueues a
// push job in the same transaction that decrements stock, so "stock changed"
// and "a write-back is owed" commit or roll back together. A dispatcher
// (processDuePushJobs) then delivers the jobs:
//   - transient failure  -> retry with exponential backoff
//   - too many failures  -> dead_letter, waiting for a human
//   - unconfigured route -> skipped (recorded, not retried)
// Every attempt is recorded in sync_push_logs.
// ======================================================

function pushRetryBaseMs() {
  return Number(process.env.PUSH_RETRY_BASE_MS || 5000);
}

function pushMaxAttempts() {
  return Number(process.env.PUSH_MAX_ATTEMPTS || 5);
}

// Enqueue one job per platform. Must be called inside the sale transaction.
// Pushes are absolute ("set stock to N"), so if a job for this SKU+platform is
// already waiting, only its target needs updating (coalescing): delivering the
// latest value once is equivalent to delivering every intermediate value.
function enqueuePushJobs(internalSku, targetQuantity, now = Date.now()) {
  for (const platform of ['shopify', 'etsy']) {
    const pending = statements.findPendingPushJob.get(internalSku, platform);
    if (pending) {
      statements.coalescePendingPushJob.run(targetQuantity, pending.id);
    } else {
      statements.insertPushJob.run(internalSku, platform, targetQuantity, pushMaxAttempts(), now);
    }
  }
}

// Deliver one push job to its platform. Returns what happened so callers
// (dispatcher, demo, tests) can report on it.
async function attemptPushJob(job, now = Date.now()) {
  const attempts = job.attempts + 1;
  const finishSkipped = (message) => {
    statements.markPushJobSkipped.run(attempts, message, job.id);
    statements.insertSyncPushLog.run(
      job.internal_sku,
      job.platform,
      job.target_quantity,
      'skipped',
      message
    );
    return {
      jobId: job.id,
      internalSku: job.internal_sku,
      platform: job.platform,
      outcome: 'skipped',
      message
    };
  };

  if (!ENABLE_PLATFORM_PUSH) {
    return finishSkipped('ENABLE_PLATFORM_PUSH=false');
  }

  const mapping = statements.findSkuMappingByInternalSku.get(job.internal_sku);
  if (!mapping) {
    return finishSkipped('no SKU mapping found');
  }

  try {
    if (job.platform === 'shopify') {
      if (
        !mapping.shopify_inventory_item_id ||
        !(mapping.shopify_location_id || SHOPIFY_LOCATION_ID)
      ) {
        return finishSkipped('missing Shopify inventory mapping');
      }
      await setShopifyInventoryAbsolute({
        inventoryItemId: mapping.shopify_inventory_item_id,
        locationId: mapping.shopify_location_id || SHOPIFY_LOCATION_ID,
        available: job.target_quantity
      });
    } else {
      if (!mapping.etsy_listing_id || !mapping.etsy_offering_id) {
        return finishSkipped('missing Etsy mapping / offering id');
      }
      // This is a placeholder example payload. A real Etsy inventory payload
      // usually needs a fuller products / offerings structure; extend it here
      // against one of your real listings before enabling Etsy write-back.
      await updateEtsyListingInventory({
        listingId: mapping.etsy_listing_id,
        productsPayload: {
          products: [
            {
              offerings: [
                {
                  offering_id: Number(mapping.etsy_offering_id),
                  quantity: Number(job.target_quantity),
                  is_enabled: true
                }
              ]
            }
          ]
        }
      });
    }

    statements.markPushJobSucceeded.run(attempts, job.id);
    statements.insertSyncPushLog.run(
      job.internal_sku,
      job.platform,
      job.target_quantity,
      'success',
      `${job.platform} inventory updated (attempt ${attempts})`
    );
    return {
      jobId: job.id,
      internalSku: job.internal_sku,
      platform: job.platform,
      outcome: 'succeeded',
      attempts
    };
  } catch (error) {
    if (attempts >= job.max_attempts) {
      statements.markPushJobDeadLetter.run(attempts, error.message, job.id);
      statements.insertSyncPushLog.run(
        job.internal_sku,
        job.platform,
        job.target_quantity,
        'failed',
        `dead-lettered after ${attempts} attempts: ${error.message}`
      );
      return {
        jobId: job.id,
        internalSku: job.internal_sku,
        platform: job.platform,
        outcome: 'dead_letter',
        attempts,
        error: error.message
      };
    }

    // Exponential backoff: base * 2^(attempts-1) from now.
    const delayMs = pushRetryBaseMs() * 2 ** (attempts - 1);
    const nextAttemptAt = now + delayMs;
    statements.schedulePushJobRetry.run(attempts, nextAttemptAt, error.message, job.id);
    statements.insertSyncPushLog.run(
      job.internal_sku,
      job.platform,
      job.target_quantity,
      'failed',
      `attempt ${attempts} failed, retry in ${delayMs}ms: ${error.message}`
    );
    return {
      jobId: job.id,
      internalSku: job.internal_sku,
      platform: job.platform,
      outcome: 'retry_scheduled',
      attempts,
      nextAttemptAt,
      error: error.message
    };
  }
}

// Dispatcher: deliver every job whose next_attempt_at has passed. `now` is
// injectable so tests and the demo can fast-forward through backoff windows
// instead of sleeping.
async function processDuePushJobs({ now = Date.now(), limit = 50 } = {}) {
  const due = statements.listDuePushJobs.all(now, limit);
  const results = [];
  for (const job of due) {
    results.push(await attemptPushJob(job, now));
  }
  return results;
}

function listDeadLetterJobs() {
  return statements.listDeadLetterPushJobs.all();
}

// Give a dead-lettered job a fresh set of attempts (a human decided to retry).
function requeueDeadLetterJob(jobId, now = Date.now()) {
  const job = statements.getPushJobById.get(jobId);
  if (!job || job.status !== 'dead_letter') return null;
  statements.requeuePushJob.run(now, jobId);
  return statements.getPushJobById.get(jobId);
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

  // Decrement stock atomically inside a single transaction: re-read the current
  // value, clamp at zero to avoid negative stock (oversell), and write the
  // ledger. The transaction is IMMEDIATE so it takes the write lock up front:
  // with several processes on the same database, a deferred read-then-write
  // could base its decrement on a stale snapshot.
  const requested = Number(quantity);
  const shouldPush = item.tier === 'tier1' && Number(item.sync_enabled) === 1;
  const { beforeUnits, afterUnits, oversold } = db
    .transaction(() => {
      const current = statements.findInventoryItemByInternalSku.get(internalSku);
      const before = Number(current.available_units);
      const after = Math.max(0, before - requested);
      const isOversell = before - requested < 0;
      const ledgerNotes = isOversell
        ? `${notes ? notes + ' ' : ''}[oversell: requested ${requested}, only ${before} available]`
        : notes || null;

      statements.updateInventoryUnits.run(after, internalSku);
      statements.insertLedger.run(
        internalSku,
        'sale',
        platform,
        externalOrderId,
        after - before, // actual change applied, so before + change === after always holds
        before,
        after,
        ledgerNotes
      );

      // Transactional outbox: the write-back obligation commits atomically
      // with the stock change itself.
      if (shouldPush) {
        enqueuePushJobs(internalSku, after);
      }

      return { beforeUnits: before, afterUnits: after, oversold: isOversell };
    })
    .immediate();

  // Only tier1 with sync_enabled=1 writes back to the platforms.
  if (shouldPush) {
    await processDuePushJobs();
    return {
      status: 'synced',
      message: oversold
        ? 'tier1 SKU: oversold, stock clamped to 0 and write-back attempted'
        : 'tier1 SKU: stock decremented and write-back attempted',
      beforeUnits,
      afterUnits,
      oversold
    };
  }

  // tier2: record the change only, no write-back.
  if (item.tier === 'tier2') {
    return {
      status: 'tracked_only',
      message: 'tier2 SKU: internal stock/trend recorded, no write-back',
      beforeUnits,
      afterUnits,
      oversold
    };
  }

  // tier3: keep the manual workflow.
  return {
    status: 'manual',
    message: 'tier3 SKU: manual workflow kept, no write-back',
    beforeUnits,
    afterUnits,
    oversold
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
      : Array.isArray(receipt.Transactions)
        ? receipt.Transactions
        : [];

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

function getRecentLedger(limit = 50) {
  return statements.listRecentLedger.all(limit);
}

function getRecentPushJobs(limit = 50) {
  return statements.listRecentPushJobs.all(limit);
}

module.exports = {
  importInventoryRows,
  ingestShopifyOrders,
  ingestEtsyReceipts,
  getInventorySnapshot,
  getLowStockItems,
  getRecentLedger,
  getRecentPushJobs,
  processDuePushJobs,
  listDeadLetterJobs,
  requeueDeadLetterJob,
  reconcileInventory,
  listReconciliationRuns
};
