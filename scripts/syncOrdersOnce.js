const { initDb } = require('../src/db');
const { fetchShopifyPaidOrders, fetchEtsyReceipts } = require('../src/platforms');
const { ingestShopifyOrders, ingestEtsyReceipts } = require('../src/services');

async function main() {
  initDb();

  console.log('开始同步 Shopify 订单...');
  const shopifyOrders = await fetchShopifyPaidOrders({ limit: 50 });
  const shopifyResult = await ingestShopifyOrders(shopifyOrders);
  console.log('Shopify 同步结果:');
  console.dir(shopifyResult, { depth: null });

  console.log('开始同步 Etsy 订单...');
  const etsyReceipts = await fetchEtsyReceipts({ limit: 50 });
  const etsyResult = await ingestEtsyReceipts(etsyReceipts);
  console.log('Etsy 同步结果:');
  console.dir(etsyResult, { depth: null });
}

main().catch((error) => {
  console.error('同步失败:', error);
  process.exit(1);
});
