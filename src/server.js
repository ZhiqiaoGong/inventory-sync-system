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

// Initialize the database on startup.
initDb();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '2mb' }));

// Health check.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Current inventory snapshot.
app.get('/inventory', (_req, res) => {
  res.json({
    ok: true,
    items: getInventorySnapshot()
  });
});

// Low-stock items.
app.get('/inventory/low-stock', (_req, res) => {
  res.json({
    ok: true,
    items: getLowStockItems()
  });
});

// Manually trigger a Shopify order sync.
app.post('/sync/shopify', async (_req, res) => {
  try {
    const orders = await fetchShopifyPaidOrders({ limit: 50 });
    const result = await ingestShopifyOrders(orders);
    res.json({ ok: true, source: 'shopify', result });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// Manually trigger an Etsy order sync.
app.post('/sync/etsy', async (_req, res) => {
  try {
    const receipts = await fetchEtsyReceipts({ limit: 50 });
    const result = await ingestEtsyReceipts(receipts);
    res.json({ ok: true, source: 'etsy', result });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// Sync both platforms in one call.
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
