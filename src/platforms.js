require('dotenv').config();

// =========================
// 这个文件专门负责“平台 API 封装”。
// 目的：
// 1. 把 Shopify / Etsy 的请求写在一起
// 2. 业务逻辑层不需要关心太多 HTTP 细节
// 3. 以后如果换 API 版本，也只改这里
// =========================

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
// Shopify 部分
// =========================

function getShopifyHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN
  };
}

async function fetchShopifyPaidOrders({ status = 'any', limit = 50 } = {}) {
  // 这里示例用 REST API 拉订单。
  // 实际上线时，你也可以换成 webhook 驱动。
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?financial_status=paid&status=${status}&limit=${limit}`;
  const data = await requestJson(url, {
    method: 'GET',
    headers: getShopifyHeaders()
  });

  return data.orders || [];
}

async function setShopifyInventoryAbsolute({ inventoryItemId, locationId, available }) {
  // 注意：Shopify 有 adjust（增量）和 set（绝对值）两种思路。
  // 这里为了简化系统，我们采用“把目标库存写成明确值”的方式。
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
// Etsy 部分
// =========================

function getEtsyHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ETSY_ACCESS_TOKEN}`
  };
}

async function fetchEtsyReceipts({ limit = 50 } = {}) {
  // Etsy 的具体订单字段和分页逻辑会随 API 使用方式略有不同。
  // 这里提供一个“已拿到 access token 后”的可运行框架。
  const url = `${ETSY_API_BASE}/shops/${ETSY_SHOP_ID}/receipts?limit=${limit}`;
  const data = await requestJson(url, {
    method: 'GET',
    headers: getEtsyHeaders()
  });

  // Etsy 常见返回结构可能是 results。
  return data.results || [];
}

async function updateEtsyListingInventory({ listingId, productsPayload }) {
  // Etsy 的库存更新通常是针对 listing inventory。
  // 真实场景里，你需要按 Etsy 的 listing inventory 结构传入 products。
  // 这里保留一个清晰的封装入口，方便你以后按店铺实际数据补全。
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
