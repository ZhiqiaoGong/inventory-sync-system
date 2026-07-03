// =========================
// Mock platform data
// =========================
// When there are no real Shopify / Etsy credentials, these "fake orders" drive
// the whole tiered inventory flow so the system runs out of the box and can be
// demoed end to end.
//
// The SKUs here all match sample_inventory.csv and deliberately cover all four
// branches:
//   - tier1 (BALLOON-RED-STD)   -> decrement stock and "write back" to platforms (mock only logs)
//   - tier2 (BALLOON-PINK-PACK) -> record internal stock only, no write-back
//   - tier3 (CUSTOM-BUNDLE-01)  -> no unit-level stock, just log the order
//   - unmatched (MYSTERY-SKU)   -> no internal SKU found, marked as unresolved

const mockShopifyOrders = [
  {
    id: 1001,
    name: '#1001',
    financial_status: 'paid',
    line_items: [
      // tier1: matched by variant_id, decrement + write back
      {
        sku: 'BALLOON-RED-STD',
        variant_id: 111111111,
        quantity: 5,
        price: '9.90',
        title: 'Red Balloon Standard'
      }
    ]
  },
  {
    id: 1002,
    name: '#1002',
    financial_status: 'paid',
    line_items: [
      // tier2: matched by sku, tracked only, no write back
      {
        sku: 'BALLOON-PINK-PACK',
        variant_id: null,
        quantity: 4,
        price: '12.00',
        title: 'Pink Balloon Pack'
      }
    ]
  },
  {
    id: 1003,
    name: '#1003',
    financial_status: 'paid',
    line_items: [
      // unmatched: no mapping for this SKU in the warehouse
      { sku: 'MYSTERY-SKU', variant_id: null, quantity: 1, price: '5.00', title: 'Unknown item' }
    ]
  },
  {
    id: 1004,
    name: '#1004',
    financial_status: 'paid',
    line_items: [
      // tier1: sale pushes stock 12 -> 7, below its threshold of 10 (triggers low-stock)
      {
        sku: 'BALLOON-BLUE-STD',
        variant_id: 666666666,
        quantity: 5,
        price: '7.50',
        title: 'Blue Balloon Standard'
      }
    ]
  }
];

const mockEtsyReceipts = [
  {
    receipt_id: 9001,
    status: 'paid',
    transactions: [
      // tier3: no reliable unit-level stock, only log the order
      { sku: 'CUSTOM-BUNDLE-01', quantity: 1, price: '30.00', title: 'Custom Bundle 01' }
    ]
  },
  {
    receipt_id: 9002,
    status: 'paid',
    transactions: [
      // tier1: also sold on Etsy, decrement + write back
      { sku: 'BALLOON-RED-STD', quantity: 2, price: '9.90', title: 'Red Balloon Standard' }
    ]
  }
];

module.exports = { mockShopifyOrders, mockEtsyReceipts };
