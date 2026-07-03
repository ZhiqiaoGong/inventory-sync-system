// Worker for the concurrency test: ingest a range of orders against the shared
// database and report per-status counts as JSON on stdout. DB_PATH,
// PLATFORM_MODE and ENABLE_PLATFORM_PUSH are inherited from the parent test.
const { ingestShopifyOrders } = require('../src/services');

const start = Number(process.argv[2]);
const end = Number(process.argv[3]);

async function main() {
  const orders = [];
  for (let id = start; id <= end; id++) {
    orders.push({
      id,
      name: `#${id}`,
      financial_status: 'paid',
      line_items: [{ sku: 'C1', variant_id: 3001, quantity: 1 }]
    });
  }

  const results = await ingestShopifyOrders(orders);
  const counts = {};
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  console.log(JSON.stringify(counts));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
