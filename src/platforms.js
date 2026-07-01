require('dotenv').config();
const { mockShopifyOrders, mockEtsyReceipts } = require('./mockData');

// =========================
// This file wraps the platform APIs.
// Goals:
// 1. keep the Shopify / Etsy requests in one place
// 2. keep HTTP details out of the business logic layer
// 3. if the API version changes, only this file changes
// =========================

// When PLATFORM_MODE=mock, use the built-in mock data instead of real APIs,
// so the whole flow runs without any Shopify / Etsy credentials.
// Defaults to mock so the project can be cloned and demoed immediately;
// switch to live to hit the real platforms.
const PLATFORM_MODE = (process.env.PLATFORM_MODE || 'mock').toLowerCase();

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';
const ETSY_API_BASE = process.env.ETSY_API_BASE || 'https://openapi.etsy.com/v3/application';
const ETSY_ACCESS_TOKEN = process.env.ETSY_ACCESS_TOKEN;
const ETSY_SHOP_ID = process.env.ETSY_SHOP_ID;

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${url} => ${text}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

// =========================
// Shopify
// =========================

function getShopifyHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN
  };
}

async function fetchShopifyPaidOrders({ status = 'any', limit = 50 } = {}) {
  if (PLATFORM_MODE === 'mock') {
    return mockShopifyOrders.slice(0, limit);
  }

  // This example pulls orders via the REST API.
  // In production you could also switch to a webhook-driven approach.
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?financial_status=paid&status=${status}&limit=${limit}`;
  const data = await requestJson(url, {
    method: 'GET',
    headers: getShopifyHeaders()
  });

  return data.orders || [];
}

async function setShopifyInventoryAbsolute({ inventoryItemId, locationId, available }) {
  if (PLATFORM_MODE === 'mock') {
    // In mock mode we do not make a real request; return a success-like result
    // and let the business layer record the sync log as usual.
    return { mock: true, inventory_item_id: Number(inventoryItemId), location_id: Number(locationId), available: Number(available) };
  }

  // Note: Shopify has both adjust (delta) and set (absolute) approaches.
  // To keep the system simple we use "set the target quantity as an explicit value".
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`;
  return requestJson(url, {
    method: 'POST',
    headers: getShopifyHeaders(),
    body: JSON.stringify({
      inventory_item_id: Number(inventoryItemId),
      location_id: Number(locationId),
      available: Number(available)
    })
  });
}

// =========================
// Etsy
// =========================

function getEtsyHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ETSY_ACCESS_TOKEN}`
  };
}

async function fetchEtsyReceipts({ limit = 50 } = {}) {
  if (PLATFORM_MODE === 'mock') {
    return mockEtsyReceipts.slice(0, limit);
  }

  // Etsy's exact order fields and pagination vary with how the API is used.
  // This is a runnable framework for the "already have an access token" case.
  const url = `${ETSY_API_BASE}/shops/${ETSY_SHOP_ID}/receipts?limit=${limit}`;
  const data = await requestJson(url, {
    method: 'GET',
    headers: getEtsyHeaders()
  });

  // Etsy commonly returns results under `results`.
  return data.results || [];
}

async function updateEtsyListingInventory({ listingId, productsPayload }) {
  if (PLATFORM_MODE === 'mock') {
    // In mock mode we do not make a real request; return a success-like result.
    return { mock: true, listing_id: Number(listingId), products: productsPayload };
  }

  // Etsy inventory updates target the listing inventory.
  // In a real setup you need to pass `products` matching Etsy's listing
  // inventory structure. This keeps a clear wrapper entry point so you can
  // fill it in later against your shop's actual data.
  const url = `${ETSY_API_BASE}/listings/${listingId}/inventory`;
  return requestJson(url, {
    method: 'PUT',
    headers: getEtsyHeaders(),
    body: JSON.stringify(productsPayload)
  });
}

module.exports = {
  fetchShopifyPaidOrders,
  setShopifyInventoryAbsolute,
  fetchEtsyReceipts,
  updateEtsyListingInventory
};
