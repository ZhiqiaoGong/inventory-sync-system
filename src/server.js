require('dotenv').config();
const express = require('express');
const { initDb } = require('./db');
const { fetchShopifyPaidOrders, fetchEtsyReceipts } = require('./platforms');
const {
  ingestShopifyOrders,
  ingestEtsyReceipts,
  getInventorySnapshot,
  getLowStockItems
} = require('./services');

// 服务启动时先初始化数据库。
initDb();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '2mb' }));

// 健康检查接口。
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// 查看当前库存快照。
app.get('/inventory', (_req, res) => {
  res.json({
    ok: true,
    items: getInventorySnapshot()
  });
});

// 查看低库存商品。
app.get('/inventory/low-stock', (_req, res) => {
  res.json({
    ok: true,
    items: getLowStockItems()
  });
});

// 手动触发一次 Shopify 订单同步。
app.post('/sync/shopify', async (_req, res) => {
  try {
    const orders = await fetchShopifyPaidOrders({ limit: 50 });
    const result = await ingestShopifyOrders(orders);
    res.json({ ok: true, source: 'shopify', result });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// 手动触发一次 Etsy 订单同步。
app.post('/sync/etsy', async (_req, res) => {
  try {
    const receipts = await fetchEtsyReceipts({ limit: 50 });
    const result = await ingestEtsyReceipts(receipts);
    res.json({ ok: true, source: 'etsy', result });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// 一次性同步两个平台。
app.post('/sync/all', async (_req, res) => {
  try {
    const [shopifyOrders, etsyReceipts] = await Promise.all([
      fetchShopifyPaidOrders({ limit: 50 }),
      fetchEtsyReceipts({ limit: 50 })
    ]);

    const shopifyResult = await ingestShopifyOrders(shopifyOrders);
    const etsyResult = await ingestEtsyReceipts(etsyReceipts);

    res.json({
      ok: true,
      result: {
        shopify: shopifyResult,
        etsy: etsyResult
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Inventory system server listening on http://localhost:${PORT}`);
});
