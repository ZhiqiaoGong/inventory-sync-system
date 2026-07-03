const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_WEBHOOK_SECRET = 'test-webhook-secret';

const { cleanup, importInventoryRows, getInventorySnapshot } = require('./helpers');
const { computeShopifyHmac } = require('../src/webhooks');
const app = require('../src/app');

process.on('exit', cleanup);

let server;
let baseUrl;

function orderPayload(id, quantity) {
  return JSON.stringify({
    id,
    name: `#${id}`,
    financial_status: 'paid',
    line_items: [{ sku: 'W1', variant_id: 4001, quantity, price: '9.90', title: 'Webhook item' }]
  });
}

function postWebhook(body, signature) {
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== undefined) headers['X-Shopify-Hmac-Sha256'] = signature;
  return fetch(`${baseUrl}/webhooks/shopify`, { method: 'POST', headers, body });
}

function stockOf(sku) {
  return getInventorySnapshot().find((i) => i.internal_sku === sku).available_units;
}

before(async () => {
  importInventoryRows([
    {
      internal_sku: 'W1',
      product_name: 'Webhook 1',
      tier: 'tier1',
      sync_enabled: '1',
      available_units: '100',
      low_stock_threshold: '10',
      shopify_sku: 'W1',
      shopify_variant_id: '4001',
      shopify_inventory_item_id: '11',
      shopify_location_id: '22'
    }
  ]);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

test('a correctly signed webhook is ingested and decrements stock', async () => {
  const body = orderPayload(800, 2);
  const signature = computeShopifyHmac(body, process.env.SHOPIFY_WEBHOOK_SECRET);

  const res = await postWebhook(body, signature);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.result[0].status, 'processed');
  assert.equal(stockOf('W1'), 98);
});

test('replaying the same delivery is deduplicated, not double-counted', async () => {
  const body = orderPayload(800, 2);
  const signature = computeShopifyHmac(body, process.env.SHOPIFY_WEBHOOK_SECRET);

  const res = await postWebhook(body, signature);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.result[0].status, 'duplicate');
  assert.equal(stockOf('W1'), 98, 'stock unchanged on replay');
});

test('a wrong signature is rejected with 401 and nothing is ingested', async () => {
  const body = orderPayload(801, 5);

  const res = await postWebhook(body, computeShopifyHmac(body, 'wrong-secret'));
  assert.equal(res.status, 401);
  assert.equal(stockOf('W1'), 98);
});

test('a missing signature is rejected with 401', async () => {
  const res = await postWebhook(orderPayload(802, 5));
  assert.equal(res.status, 401);
  assert.equal(stockOf('W1'), 98);
});

test('a tampered body no longer matches its signature', async () => {
  const original = orderPayload(803, 1);
  const signature = computeShopifyHmac(original, process.env.SHOPIFY_WEBHOOK_SECRET);
  const tampered = orderPayload(803, 99); // attacker inflates the quantity

  const res = await postWebhook(tampered, signature);
  assert.equal(res.status, 401);
  assert.equal(stockOf('W1'), 98);
});
