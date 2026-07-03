const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

// Create the single SQLite database connection here.
// SQLite is a good fit because:
// 1. no separate database service to install
// 2. very convenient to run locally
// 3. suitable for a small system prototype / MVP
const dbPath = process.env.DB_PATH || './inventory.db';
const db = new Database(path.resolve(dbPath));

// WAL mode behaves better for a web service (more stable reads/writes).
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// When several processes share this database (e.g. the concurrency test, or a
// server plus a cron worker), a writer briefly holds the write lock. Instead of
// failing immediately with SQLITE_BUSY, wait up to 5s for the lock.
db.pragma('busy_timeout = 5000');

// Create the database tables.
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      -- internal primary key
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- internal unified SKU, used as the core identifier across the system
      internal_sku TEXT NOT NULL UNIQUE,

      -- product name, mainly for readable display
      product_name TEXT,

      -- SKU tier:
      -- tier1 = fully_managed, can be auto-synced
      -- tier2 = tracked_not_synced, tracked only, no write-back
      -- tier3 = unmanaged, still handled manually
      tier TEXT NOT NULL CHECK(tier IN ('tier1', 'tier2', 'tier3')),

      -- whether sync is enabled, usually 1 for tier1 and 0 for the rest
      sync_enabled INTEGER NOT NULL DEFAULT 0,

      -- whether monitoring is enabled in the system
      monitoring_enabled INTEGER NOT NULL DEFAULT 1,

      -- the "available units" the system currently believes it has
      available_units INTEGER,

      -- low-stock threshold, used for alerts
      low_stock_threshold INTEGER,

      -- how many units are in one pack, if applicable
      units_per_pack INTEGER,

      -- notes, e.g. why this SKU cannot be auto-synced
      notes TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sku_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_sku TEXT NOT NULL,

      -- Shopify-side mapping
      shopify_sku TEXT,
      shopify_variant_id TEXT,
      shopify_inventory_item_id TEXT,
      shopify_location_id TEXT,

      -- Etsy-side mapping
      etsy_sku TEXT,
      etsy_listing_id TEXT,
      etsy_offering_id TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY(internal_sku) REFERENCES inventory_items(internal_sku) ON DELETE CASCADE,
      UNIQUE(internal_sku)
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- platform: shopify / etsy
      platform TEXT NOT NULL CHECK(platform IN ('shopify', 'etsy')),

      -- platform-side event id or order id
      external_event_id TEXT NOT NULL,
      external_order_id TEXT NOT NULL,
      order_name TEXT,
      order_status TEXT,

      -- raw JSON, kept for troubleshooting
      raw_payload TEXT,

      -- whether it has already been processed (idempotency)
      processed INTEGER NOT NULL DEFAULT 0,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,

      UNIQUE(platform, external_event_id)
    );

    CREATE TABLE IF NOT EXISTS order_event_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_event_id INTEGER NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('shopify', 'etsy')),

      -- raw platform SKU
      platform_sku TEXT,

      -- resolved internal SKU
      internal_sku TEXT,

      quantity INTEGER NOT NULL,
      unit_price TEXT,
      title TEXT,

      FOREIGN KEY(order_event_id) REFERENCES order_events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_sku TEXT NOT NULL,

      -- reason for the change:
      -- sale = order sale
      -- manual_adjustment = manual correction
      -- import_snapshot = imported inventory snapshot
      reason TEXT NOT NULL,

      platform TEXT,
      external_order_id TEXT,
      change_units INTEGER NOT NULL,
      before_units INTEGER,
      after_units INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY(internal_sku) REFERENCES inventory_items(internal_sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_push_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_sku TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('shopify', 'etsy')),
      target_quantity INTEGER,
      status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'skipped')),
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Transactional outbox for platform write-backs. A sale enqueues a push job
    -- in the same transaction that decrements stock, so "stock changed" and
    -- "write-back is owed" can never diverge. A dispatcher then delivers jobs
    -- with retries; sync_push_logs above stays as the per-attempt log.
    CREATE TABLE IF NOT EXISTS push_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_sku TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('shopify', 'etsy')),

      -- absolute quantity to set on the platform; coalescing keeps only the
      -- latest value per (sku, platform) while a job is still pending
      target_quantity INTEGER NOT NULL,

      -- pending -> succeeded / skipped, or dead_letter after max_attempts
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'succeeded', 'skipped', 'dead_letter')),

      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,

      -- epoch milliseconds; exponential backoff pushes this into the future
      next_attempt_at INTEGER NOT NULL,

      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_push_jobs_due
      ON push_jobs(status, next_attempt_at);

    -- One row per reconciliation run: the ledger is replayed per SKU and
    -- compared against the live inventory table.
    CREATE TABLE IF NOT EXISTS reconciliation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_skus INTEGER NOT NULL,
      mismatch_count INTEGER NOT NULL,
      chain_violation_count INTEGER NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// The prepared statements below require the tables to exist, so create the
// tables here first. This avoids errors when any file does require('./db')
// before the tables have been created.
initDb();

const statements = {
  upsertInventoryItem: db.prepare(`
    INSERT INTO inventory_items (
      internal_sku, product_name, tier, sync_enabled, monitoring_enabled,
      available_units, low_stock_threshold, units_per_pack, notes, updated_at
    ) VALUES (
      @internal_sku, @product_name, @tier, @sync_enabled, @monitoring_enabled,
      @available_units, @low_stock_threshold, @units_per_pack, @notes, datetime('now')
    )
    ON CONFLICT(internal_sku) DO UPDATE SET
      product_name = excluded.product_name,
      tier = excluded.tier,
      sync_enabled = excluded.sync_enabled,
      monitoring_enabled = excluded.monitoring_enabled,
      available_units = excluded.available_units,
      low_stock_threshold = excluded.low_stock_threshold,
      units_per_pack = excluded.units_per_pack,
      notes = excluded.notes,
      updated_at = datetime('now')
  `),

  upsertSkuMapping: db.prepare(`
    INSERT INTO sku_mappings (
      internal_sku, shopify_sku, shopify_variant_id, shopify_inventory_item_id, shopify_location_id,
      etsy_sku, etsy_listing_id, etsy_offering_id, updated_at
    ) VALUES (
      @internal_sku, @shopify_sku, @shopify_variant_id, @shopify_inventory_item_id, @shopify_location_id,
      @etsy_sku, @etsy_listing_id, @etsy_offering_id, datetime('now')
    )
    ON CONFLICT(internal_sku) DO UPDATE SET
      shopify_sku = excluded.shopify_sku,
      shopify_variant_id = excluded.shopify_variant_id,
      shopify_inventory_item_id = excluded.shopify_inventory_item_id,
      shopify_location_id = excluded.shopify_location_id,
      etsy_sku = excluded.etsy_sku,
      etsy_listing_id = excluded.etsy_listing_id,
      etsy_offering_id = excluded.etsy_offering_id,
      updated_at = datetime('now')
  `),

  findInventoryItemByInternalSku: db.prepare(`
    SELECT * FROM inventory_items WHERE internal_sku = ?
  `),

  findInventoryItemByPlatformSku: db.prepare(`
    SELECT ii.*, sm.*
    FROM inventory_items ii
    JOIN sku_mappings sm ON ii.internal_sku = sm.internal_sku
    WHERE sm.shopify_sku = ? OR sm.etsy_sku = ?
    LIMIT 1
  `),

  findInventoryItemByShopifyVariantId: db.prepare(`
    SELECT ii.*, sm.*
    FROM inventory_items ii
    JOIN sku_mappings sm ON ii.internal_sku = sm.internal_sku
    WHERE sm.shopify_variant_id = ?
    LIMIT 1
  `),

  findSkuMappingByInternalSku: db.prepare(`
    SELECT * FROM sku_mappings WHERE internal_sku = ?
  `),

  insertOrderEvent: db.prepare(`
    INSERT INTO order_events (
      platform, external_event_id, external_order_id, order_name, order_status, raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?)
  `),

  findOrderEventByPlatformAndEventId: db.prepare(`
    SELECT * FROM order_events WHERE platform = ? AND external_event_id = ?
  `),

  insertOrderEventItem: db.prepare(`
    INSERT INTO order_event_items (
      order_event_id, platform, platform_sku, internal_sku, quantity, unit_price, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  markOrderEventProcessed: db.prepare(`
    UPDATE order_events
    SET processed = 1, processed_at = datetime('now')
    WHERE id = ?
  `),

  updateInventoryUnits: db.prepare(`
    UPDATE inventory_items
    SET available_units = ?, updated_at = datetime('now')
    WHERE internal_sku = ?
  `),

  insertLedger: db.prepare(`
    INSERT INTO inventory_ledger (
      internal_sku, reason, platform, external_order_id, change_units,
      before_units, after_units, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  insertSyncPushLog: db.prepare(`
    INSERT INTO sync_push_logs (
      internal_sku, platform, target_quantity, status, message
    ) VALUES (?, ?, ?, ?, ?)
  `),

  listLowStockItems: db.prepare(`
    SELECT *
    FROM inventory_items
    WHERE monitoring_enabled = 1
      AND available_units IS NOT NULL
      AND low_stock_threshold IS NOT NULL
      AND available_units <= low_stock_threshold
    ORDER BY available_units ASC
  `),

  listInventorySnapshot: db.prepare(`
    SELECT ii.*, sm.shopify_sku, sm.etsy_sku
    FROM inventory_items ii
    LEFT JOIN sku_mappings sm ON ii.internal_sku = sm.internal_sku
    ORDER BY ii.internal_sku ASC
  `),

  // ----- push job queue (outbox) -----

  findPendingPushJob: db.prepare(`
    SELECT * FROM push_jobs
    WHERE internal_sku = ? AND platform = ? AND status = 'pending'
    LIMIT 1
  `),

  insertPushJob: db.prepare(`
    INSERT INTO push_jobs (internal_sku, platform, target_quantity, max_attempts, next_attempt_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  coalescePendingPushJob: db.prepare(`
    UPDATE push_jobs
    SET target_quantity = ?, updated_at = datetime('now')
    WHERE id = ?
  `),

  listDuePushJobs: db.prepare(`
    SELECT * FROM push_jobs
    WHERE status = 'pending' AND next_attempt_at <= ?
    ORDER BY next_attempt_at ASC
    LIMIT ?
  `),

  getPushJobById: db.prepare(`
    SELECT * FROM push_jobs WHERE id = ?
  `),

  markPushJobSucceeded: db.prepare(`
    UPDATE push_jobs
    SET status = 'succeeded', attempts = ?, last_error = NULL, updated_at = datetime('now')
    WHERE id = ?
  `),

  markPushJobSkipped: db.prepare(`
    UPDATE push_jobs
    SET status = 'skipped', attempts = ?, last_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `),

  schedulePushJobRetry: db.prepare(`
    UPDATE push_jobs
    SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `),

  markPushJobDeadLetter: db.prepare(`
    UPDATE push_jobs
    SET status = 'dead_letter', attempts = ?, last_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `),

  listDeadLetterPushJobs: db.prepare(`
    SELECT * FROM push_jobs WHERE status = 'dead_letter' ORDER BY updated_at DESC
  `),

  requeuePushJob: db.prepare(`
    UPDATE push_jobs
    SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `),

  // ----- reconciliation -----

  listLedgerBySku: db.prepare(`
    SELECT * FROM inventory_ledger WHERE internal_sku = ? ORDER BY id ASC
  `),

  insertReconciliationRun: db.prepare(`
    INSERT INTO reconciliation_runs (checked_skus, mismatch_count, chain_violation_count, details)
    VALUES (?, ?, ?, ?)
  `),

  listReconciliationRuns: db.prepare(`
    SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 20
  `)
};

module.exports = {
  db,
  initDb,
  statements
};
