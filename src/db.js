const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

// 这里统一创建 SQLite 数据库连接。
// SQLite 的好处是：
// 1. 不需要额外安装数据库服务
// 2. 本地运行非常方便
// 3. 适合小型系统原型 / MVP
const dbPath = process.env.DB_PATH || './inventory.db';
const db = new Database(path.resolve(dbPath));

// WAL 模式更适合 Web 服务场景，读写表现更稳。
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 初始化数据库表。
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      -- 系统内部主键
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- 内部统一 SKU，整个系统用它作为核心标识
      internal_sku TEXT NOT NULL UNIQUE,

      -- 商品名称，主要用于可读性展示
      product_name TEXT,

      -- SKU 层级：
      -- tier1 = fully_managed，可自动同步
      -- tier2 = tracked_not_synced，只做跟踪，不回写平台
      -- tier3 = unmanaged，继续人工处理
      tier TEXT NOT NULL CHECK(tier IN ('tier1', 'tier2', 'tier3')),

      -- 是否开启同步，通常 tier1 会是 1，其余多半是 0
      sync_enabled INTEGER NOT NULL DEFAULT 0,

      -- 是否在系统中启用监控
      monitoring_enabled INTEGER NOT NULL DEFAULT 1,

      -- 当前系统内部认定的“可用件数”
      available_units INTEGER,

      -- 低库存阈值，用于告警
      low_stock_threshold INTEGER,

      -- 如果一个商品一包有多少件，可以记录在这里
      units_per_pack INTEGER,

      -- 备注，用来记录为什么这个 SKU 不能自动同步之类的信息
      notes TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sku_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_sku TEXT NOT NULL,

      -- Shopify 侧映射
      shopify_sku TEXT,
      shopify_variant_id TEXT,
      shopify_inventory_item_id TEXT,
      shopify_location_id TEXT,

      -- Etsy 侧映射
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

      -- 平台：shopify / etsy
      platform TEXT NOT NULL CHECK(platform IN ('shopify', 'etsy')),

      -- 平台侧事件 ID 或订单 ID
      external_event_id TEXT NOT NULL,
      external_order_id TEXT NOT NULL,
      order_name TEXT,
      order_status TEXT,

      -- 原始 JSON，便于排查问题
      raw_payload TEXT,

      -- 是否已经处理过（幂等）
      processed INTEGER NOT NULL DEFAULT 0,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,

      UNIQUE(platform, external_event_id)
    );

    CREATE TABLE IF NOT EXISTS order_event_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_event_id INTEGER NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('shopify', 'etsy')),

      -- 平台原始 SKU
      platform_sku TEXT,

      -- 解析后对应的内部 SKU
      internal_sku TEXT,

      quantity INTEGER NOT NULL,
      unit_price TEXT,
      title TEXT,

      FOREIGN KEY(order_event_id) REFERENCES order_events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_sku TEXT NOT NULL,

      -- 变更原因：
      -- sale = 订单销售
      -- manual_adjustment = 人工修正
      -- import_snapshot = 导入库存快照
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
  `);
}

// 预编译语句依赖表已存在，所以在这里先建好表，
// 避免任何文件 require('./db') 时因为表还没建而报错。
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
  `)
};

module.exports = {
  db,
  initDb,
  statements
};
