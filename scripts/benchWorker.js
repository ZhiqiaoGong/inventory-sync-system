// Worker for the multi-process benchmark: ingest a range of orders against the
// shared database (DB_PATH inherited from the parent) and print how many were
// processed vs deduplicated.
const { ingestShopifyOrders } = require('../src/services');

const start = Number(process.argv[2]);
const end = Number(process.argv[3]);
const skuCount = Number(process.argv[4]);

async function main() {
  const orders = [];
  for (let id = start; id <= end; id++) {
    const skuIndex = id % skuCount;
    orders.push({
      id,
      name: `#${id}`,
      financial_status: 'paid',
      line_items: [{ sku: `BENCH-A-${skuIndex}`, quantity: 1 }]
    });
  }

  const results = await ingestShopifyOrders(orders);
  const counts = { processed: 0, duplicate: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(JSON.stringify(counts));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
