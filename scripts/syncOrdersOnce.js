const { initDb } = require('../src/db');
const { fetchShopifyPaidOrders, fetchEtsyReceipts } = require('../src/platforms');
const { ingestShopifyOrders, ingestEtsyReceipts } = require('../src/services');

async function main() {
  initDb();

  console.log('Syncing Shopify orders...');
  const shopifyOrders = await fetchShopifyPaidOrders({ limit: 50 });
  const shopifyResult = await ingestShopifyOrders(shopifyOrders);
  console.log('Shopify sync result:');
  console.dir(shopifyResult, { depth: null });

  console.log('Syncing Etsy orders...');
  const etsyReceipts = await fetchEtsyReceipts({ limit: 50 });
  const etsyResult = await ingestEtsyReceipts(etsyReceipts);
  console.log('Etsy sync result:');
  console.dir(etsyResult, { depth: null });
}

main().catch((error) => {
  console.error('Sync failed:', error);
  process.exit(1);
});
