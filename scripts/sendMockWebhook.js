// Send a signed mock Shopify webhook to a locally running server, three ways:
//   1. correctly signed          -> 200, order processed
//   2. the exact same delivery   -> 200, deduplicated (replay protection)
//   3. signed with a wrong key   -> 401, rejected
// Usage: npm start (in one terminal), then: npm run send-mock-webhook
require('dotenv').config();
const { computeShopifyHmac } = require('../src/webhooks');

const BASE_URL = process.env.WEBHOOK_TARGET || `http://localhost:${process.env.PORT || 3000}`;
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('SHOPIFY_WEBHOOK_SECRET is not set; add it to .env first.');
  process.exit(1);
}

// A fresh order id each run so the first delivery is always new.
const orderId = Number(process.argv[2]) || Date.now();
const body = JSON.stringify({
  id: orderId,
  name: `#${orderId}`,
  financial_status: 'paid',
  line_items: [
    {
      sku: 'BALLOON-RED-STD',
      variant_id: 111111111,
      quantity: 1,
      price: '9.90',
      title: 'Red Balloon Standard'
    }
  ]
});

async function send(label, signature) {
  const res = await fetch(`${BASE_URL}/webhooks/shopify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': signature
    },
    body
  });
  const data = await res.json().catch(() => ({}));
  const summary = res.status === 200 ? data.result?.[0]?.status : data.message || 'rejected';
  console.log(`${label}: HTTP ${res.status} -> ${summary}`);
}

async function main() {
  console.log(`Sending mock webhook for order #${orderId} to ${BASE_URL} ...`);
  await send('1. valid signature   ', computeShopifyHmac(body, SECRET));
  await send('2. replayed delivery ', computeShopifyHmac(body, SECRET));
  await send('3. wrong signature   ', computeShopifyHmac(body, 'not-the-real-secret'));
}

main().catch((error) => {
  console.error('Webhook demo failed (is the server running? try `npm start`):', error.message);
  process.exit(1);
});
