require('dotenv').config();
const express = require('express');
const { initDb } = require('./db');
const { fetchShopifyPaidOrders, fetchEtsyReceipts } = require('./platforms');
const {
  ingestShopifyOrders,
  ingestEtsyReceipts,
  getInventorySnapshot,
  getLowStockItems,
  processDuePushJobs,
  listDeadLetterJobs,
  requeueDeadLetterJob,
  reconcileInventory,
  listReconciliationRuns
} = require('./services');
const { verifyShopifyWebhook } = require('./webhooks');

// Initialize the database on startup.
initDb();

const app = express();

// Webhook route FIRST, with a raw body: HMAC verification must run on the
// exact bytes Shopify sent, so this route must not go through express.json().
app.post('/webhooks/shopify', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, message: 'SHOPIFY_WEBHOOK_SECRET not configured' });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const signature = req.get('X-Shopify-Hmac-Sha256');
  if (!verifyShopifyWebhook(rawBody, signature, secret)) {
    return res.status(401).json({ ok: false, message: 'invalid webhook signature' });
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, message: 'invalid JSON payload' });
  }

  try {
    // Replay protection: order_events is idempotent by (platform, event id),
    // so a redelivered or replayed webhook comes back as status "duplicate"
    // and never double-counts stock.
    const result = await ingestShopifyOrders([order]);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

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

// Deliver all due push jobs (also suitable as a cron target).
app.post('/push-jobs/process', async (_req, res) => {
  try {
    const results = await processDuePushJobs();
    res.json({ ok: true, processed: results.length, results });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// Jobs that exhausted their retries and are waiting for a human.
app.get('/push-jobs/dead-letter', (_req, res) => {
  res.json({ ok: true, jobs: listDeadLetterJobs() });
});

// A human decided a dead-lettered job is worth another round of attempts.
app.post('/push-jobs/:id/requeue', (req, res) => {
  const job = requeueDeadLetterJob(Number(req.params.id));
  if (!job) {
    return res.status(404).json({ ok: false, message: 'no dead-letter job with that id' });
  }
  res.json({ ok: true, job });
});

// Replay the ledger and compare against live stock.
app.post('/reconcile', (_req, res) => {
  try {
    res.json({ ok: true, report: reconcileInventory() });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get('/reconciliations', (_req, res) => {
  res.json({ ok: true, runs: listReconciliationRuns() });
});

module.exports = app;
