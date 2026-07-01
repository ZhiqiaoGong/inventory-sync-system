const fs = require('fs');
const path = require('path');
const { initDb } = require('../src/db');
const { importInventoryRows } = require('../src/services');

// =========================
// 说明：
// 为了不额外引入 CSV 解析库，这里实现了一个简化 CSV 解析器。
// 它适合“你自己导出的干净 CSV”，不适合特别复杂、带大量引号嵌套的 CSV。
// 对当前这个内部工具来说已经够用。
// =========================

function parseSimpleCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map((v) => v.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx] ?? '';
    });
    rows.push(row);
  }

  return rows;
}

function main() {
  initDb();

  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('用法: node scripts/importInventoryCsv.js ./sample_inventory.csv');
    process.exit(1);
  }

  const fullPath = path.resolve(csvPath);
  const text = fs.readFileSync(fullPath, 'utf8');
  const rows = parseSimpleCsv(text);

  importInventoryRows(rows);
  console.log(`导入完成，共 ${rows.length} 行。`);
}

main();
