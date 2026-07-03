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

// Run one platform's fetch + ingest, isolating any failure so that one platform
// being unconfigured or down does not take the other one down with it.
async function runPlatformSync(fetchFn, ingestFn) {
  try {
    const data = await fetchFn({ limit: 50 });
    const result = await ingestFn(data);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

// Sync both platforms in one call. Each platform is independent: if Etsy is not
// configured (a common case early on), Shopify still syncs successfully.
app.post('/sync/all', async (_req, res) => {
  const [shopify, etsy] = await Promise.all([
    runPlatformSync(fetchShopifyPaidOrders, ingestShopifyOrders),
    runPlatformSync(fetchEtsyReceipts, ingestEtsyReceipts)
  ]);

  res.json({
    ok: shopify.ok || etsy.ok,
    result: { shopify, etsy }
  });
});

app.listen(PORT, () => {
  console.log(`Inventory system server listening on http://localhost:${PORT}`);
});
