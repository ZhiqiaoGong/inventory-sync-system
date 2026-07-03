// =========================
// Reproducible benchmark: npm run bench
// =========================
// Everything runs locally against a throwaway SQLite database with mock
// platforms — no credentials, no network. Three measurements:
//
//   A. Order ingestion (tier2, no write-back): per-order latency percentiles
//      and sustained single-process throughput.
//   B. Full tier1 sale: ingest + transactional-outbox enqueue + mock platform
//      write-back to two platforms, end to end.
//   C. Multi-process contention: 4 worker processes race the SAME order set
//      against one database; verifies exactly-once and measures effective
//      throughput under write contention.
//
// Numbers depend on the machine; the point is that anyone can re-run them.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `inv-bench-${process.pid}-${Math.random().toString(36).slice(2)}.db`
);
process.env.PLATFORM_MODE = 'mock';
process.env.ENABLE_PLATFORM_PUSH = 'true';
process.env.MOCK_PUSH_FAILURE_RATE = '0';

const { db } = require('../src/db');
const { importInventoryRows, ingestShopifyOrders } = require('../src/services');

process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(process.env.DB_PATH + suffix);
    } catch {
      // ignore
    }
  }
});

const SKUS = 200;
const SINGLE_ORDERS = 2000;
const TIER1_ORDERS = 1000;
const WORKERS = 4;
const CONTENDED_ORDERS = 2000;

function seed(prefix, tier, withMappings) {
  const rows = [];
  for (let i = 0; i < SKUS; i++) {
    rows.push({
      internal_sku: `${prefix}-${i}`,
      product_name: `Bench ${prefix} ${i}`,
      tier,
      sync_enabled: tier === 'tier1' ? '1' : '0',
      available_units: '100000',
      low_stock_threshold: '10',
      shopify_sku: `${prefix}-${i}`,
      ...(withMappings
        ? {
            shopify_variant_id: `${prefix}-v-${i}`,
            shopify_inventory_item_id: String(1000000 + i),
            shopify_location_id: '1',
            etsy_sku: `${prefix}-${i}`,
            etsy_listing_id: String(2000000 + i),
            etsy_offering_id: String(3000000 + i)
          }
        : {})
    });
  }
  importInventoryRows(rows);
}

function order(id, prefix) {
  return {
    id,
    name: `#${id}`,
    financial_status: 'paid',
    line_items: [{ sku: `${prefix}-${id % SKUS}`, quantity: 1 }]
  };
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function fmt(n) {
  return n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2);
}

async function benchSingleProcess() {
  const latencies = [];
  const t0 = process.hrtime.bigint();
  for (let id = 1; id <= SINGLE_ORDERS; id++) {
    const s = process.hrtime.bigint();
    await ingestShopifyOrders([order(id, 'BENCH-A')]);
    latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;

  latencies.sort((a, b) => a - b);
  return {
    throughput: SINGLE_ORDERS / seconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99)
  };
}

async function benchTier1EndToEnd() {
  const t0 = process.hrtime.bigint();
  for (let id = 100001; id <= 100000 + TIER1_ORDERS; id++) {
    await ingestShopifyOrders([order(id, 'BENCH-B')]);
  }
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;

  const delivered = db
    .prepare("SELECT COUNT(*) AS n FROM push_jobs WHERE status = 'succeeded'")
    .get().n;
  return { throughput: TIER1_ORDERS / seconds, delivered };
}

function runWorker() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        path.join(__dirname, 'benchWorker.js'),
        String(200001),
        String(200000 + CONTENDED_ORDERS),
        String(SKUS)
      ],
      { env: process.env, timeout: 120000 },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout.trim())))
    );
  });
}

async function benchContended() {
  const before = db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n;
  const t0 = process.hrtime.bigint();
  const counts = await Promise.all(Array.from({ length: WORKERS }, runWorker));
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;

  const processed = counts.reduce((s, c) => s + (c.processed || 0), 0);
  const attempts = WORKERS * CONTENDED_ORDERS;
  const events = db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n - before;

  // Exactly-once verification, same as the test suite.
  const stockOk = db
    .prepare(
      "SELECT COUNT(*) AS n FROM inventory_items WHERE internal_sku LIKE 'BENCH-A-%' AND available_units != 100000 - (SELECT COUNT(*) FROM inventory_ledger l WHERE l.internal_sku = inventory_items.internal_sku AND l.reason = 'sale')"
    )
    .get().n;

  return {
    seconds,
    uniquePerSec: CONTENDED_ORDERS / seconds,
    attemptsPerSec: attempts / seconds,
    exactlyOnce: processed === CONTENDED_ORDERS && events === CONTENDED_ORDERS && stockOk === 0
  };
}

async function main() {
  console.log('Seeding throwaway database ...');
  seed('BENCH-A', 'tier2', false);
  seed('BENCH-B', 'tier1', true);

  console.log(`\nA. Order ingestion, single process (${SINGLE_ORDERS} orders, ${SKUS} SKUs)`);
  const a = await benchSingleProcess();
  console.log(`   throughput : ${fmt(a.throughput)} orders/sec sustained`);
  console.log(
    `   latency    : p50 ${a.p50.toFixed(2)}ms · p95 ${a.p95.toFixed(2)}ms · p99 ${a.p99.toFixed(2)}ms per order`
  );

  console.log(
    `\nB. Full tier1 sale incl. outbox + write-back to 2 platforms (${TIER1_ORDERS} orders)`
  );
  const b = await benchTier1EndToEnd();
  console.log(`   throughput : ${fmt(b.throughput)} sales/sec end-to-end`);
  console.log(`   delivered  : ${b.delivered} platform write-backs (mock)`);

  console.log(
    `\nC. Contention: ${WORKERS} processes racing the same ${CONTENDED_ORDERS} orders on one database`
  );
  const c = await benchContended();
  console.log(
    `   wall time  : ${c.seconds.toFixed(2)}s for ${WORKERS * CONTENDED_ORDERS} ingest attempts`
  );
  console.log(
    `   throughput : ${fmt(c.uniquePerSec)} unique orders/sec (${fmt(c.attemptsPerSec)} attempts/sec)`
  );
  console.log(`   exactly-once verified: ${c.exactlyOnce ? 'YES' : 'NO — INVESTIGATE'}`);

  console.log(
    `\nEnvironment: Node ${process.version} · ${os.cpus()[0].model} · ${os.cpus().length} cores`
  );

  if (!c.exactlyOnce) process.exit(1);
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
