const crypto = require('crypto');

// Shopify signs each webhook delivery: the header X-Shopify-Hmac-Sha256 holds
// base64(HMAC-SHA256(raw_request_body, webhook_secret)). Verification must run
// on the RAW body bytes — any JSON re-serialization would change the digest.

function computeShopifyHmac(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

function verifyShopifyWebhook(rawBody, headerValue, secret) {
  if (!headerValue || !secret) return false;

  const expected = Buffer.from(computeShopifyHmac(rawBody, secret));
  const provided = Buffer.from(String(headerValue));

  // timingSafeEqual prevents timing attacks but requires equal lengths;
  // a length mismatch is already a failed verification.
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

module.exports = { computeShopifyHmac, verifyShopifyWebhook };
