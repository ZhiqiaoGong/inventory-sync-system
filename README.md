# Tiered Cross-Platform Inventory Sync System

[![CI](https://github.com/ZhiqiaoGong/inventory-sync-system/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhiqiaoGong/inventory-sync-system/actions/workflows/ci.yml)

A prototype inventory system that keeps a single, normalized internal stock table in sync across
multiple sales channels (Shopify and Etsy). Built with Node.js, Express, and SQLite.

## The core idea: tiered sync, not all-or-nothing

Most "sync everything automatically" systems break on the messy 20% of SKUs (bundles, kits,
pack-vs-unit mismatches). This system treats sync as a spectrum instead:

| Tier  | Meaning                    | Behavior on a sale                                                         |
| ----- | -------------------------- | -------------------------------------------------------------------------- |
| tier1 | Standardized SKU           | Decrement central stock, then write the new quantity back to the platforms |
| tier2 | Trackable, not auto-synced | Decrement central stock only; never push to platforms                      |
| tier3 | Complex SKU                | Log the order; keep a manual workflow (no reliable unit-level stock)       |

The internal table is the single source of truth; platforms are downstream. This lets a small team
roll out automation gradually instead of betting the whole catalog on day one.

## Quick start (no credentials needed)

The project ships in `mock` mode by default, so it runs end to end with built-in sample orders and
never calls a real API. You do not need Shopify or Etsy access to see it work.

```bash
npm install
npm run demo
```

`npm run demo` initializes a throwaway database, imports the sample inventory, runs a simulated
Shopify + Etsy sync, and prints the full result: the resolved orders, the updated stock, the change
ledger, and the platform write-back logs. It exercises every tier branch, including an unmatched SKU.

To run it as a live server (still mock mode):

```bash
cp .env.example .env
npm run init-db
npm run import-csv -- ./sample_inventory.csv
npm start            # then: curl -X POST localhost:3000/sync/all
```

## HTTP API

| Method | Path                   | Description                                 |
| ------ | ---------------------- | ------------------------------------------- |
| GET    | `/health`              | Health check                                |
| GET    | `/inventory`           | Current inventory snapshot                  |
| GET    | `/inventory/low-stock` | Items at or below their low-stock threshold |
| POST   | `/sync/shopify`        | Pull and process Shopify orders             |
| POST   | `/sync/etsy`           | Pull and process Etsy receipts              |
| POST   | `/sync/all`            | Pull and process both platforms             |

## Architecture

```
src/
  db.js          SQLite schema + prepared statements
  platforms.js   Shopify/Etsy API wrappers (mock or live)
  mockData.js    Sample orders used in mock mode
  services.js    Business logic: tiering, ledger, write-back
  csv.js         Minimal CSV parser
  server.js      Express app
scripts/
  initDb.js      Create tables
  importInventoryCsv.js  Load the internal inventory table from CSV
  syncOrdersOnce.js      One-shot sync (for cron)
  demo.js        End-to-end demo (npm run demo)
test/
  tiering.test.js        Tier1/2/3 + unresolved + oversell behavior
  idempotency.test.js    Replaying an order does not double-count
```

Data model highlights:

- `inventory_items` / `sku_mappings` map each platform SKU to one `internal_sku`.
- `order_events` deduplicates incoming orders (idempotent by platform + external id).
- `inventory_ledger` records every stock change with before/after values for auditability.
- `sync_push_logs` records each write-back attempt (success / failed / skipped) with a reason.

## Testing

```bash
npm test            # unit tests (Node's built-in test runner)
npm run format:check # Prettier formatting check
```

Tests run against an isolated temporary SQLite database and cover the core business rules: each
tier's behavior on a sale, unmatched-SKU handling, oversell clamping, and order idempotency. CI runs
the tests, the formatting check, and the end-to-end demo on Node 20 and 22.

## Going live

Set `PLATFORM_MODE=live` in `.env` and fill in the Shopify/Etsy credentials. Two things to know:

- Shopify write-back uses the absolute-set inventory endpoint and is ready to go once credentials
  and the inventory-item / location mappings are present.
- Etsy inventory payloads depend on each listing's variant structure. The pull side and the call
  entry point are in place, but `productsPayload` in `services.js` is a placeholder you complete
  against one of your real listings before enabling Etsy write-back.

## Known boundaries

This is a runnable prototype, not a full ERP. Stock decrements are atomic within a single process
(each sale reads and writes in one SQLite transaction), but the following are not included yet:
OAuth token refresh, bundle/kit expansion, cross-instance locking for a multi-process deployment, a
full scheduler, and automatic construction of the Etsy inventory payload. These are natural next
steps.
