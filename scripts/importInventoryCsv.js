const fs = require('fs');
const path = require('path');
const { initDb } = require('../src/db');
const { importInventoryRows } = require('../src/services');
const { parseSimpleCsv } = require('../src/csv');

function main() {
  initDb();

  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/importInventoryCsv.js ./sample_inventory.csv');
    process.exit(1);
  }

  const fullPath = path.resolve(csvPath);
  const text = fs.readFileSync(fullPath, 'utf8');
  const rows = parseSimpleCsv(text);

  importInventoryRows(rows);
  console.log(`Import complete: ${rows.length} rows.`);
}

main();
