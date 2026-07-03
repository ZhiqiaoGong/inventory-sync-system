const { initDb } = require('../src/db');
const { fetchShopifyPaidOrders, fetchEtsyReceipts } = require('../src/platforms');
const { ingestShopifyOrders, ingestEtsyReceipts } = require('../src/services');

// Run one platform's fetch + ingest, isolating failures so one platform being
// unconfigured or down does not abort the other.
async function syncPlatform(label, fetchFn, ingestFn) {
  console.log(`Syncing ${label} orders...`);
  try {
    const data = await fetchFn({ limit: 50 });
    const result = await ingestFn(data);
    console.log(`${label} sync result:`);
    console.dir(result, { depth: null });
  } catch (error) {
    console.error(`${label} sync failed (skipped): ${error.message}`);
  }
}

async function main() {
  initDb();
  await syncPlatform('Shopify', fetchShopifyPaidOrders, ingestShopifyOrders);
  await syncPlatform('Etsy', fetchEtsyReceipts, ingestEtsyReceipts);
}

main().catch((error) => {
  console.error('Sync failed:', error);
  process.exit(1);
});
