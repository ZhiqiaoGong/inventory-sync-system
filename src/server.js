require('dotenv').config();
const fs = require('fs');
const path = require('path');
const app = require('./app');

// For hosted demos (ephemeral disk): if enabled and the database is empty,
// import the sample inventory so the dashboard has data on first visit.
if (String(process.env.SEED_SAMPLE_ON_START).toLowerCase() === 'true') {
  const { getInventorySnapshot, importInventoryRows } = require('./services');
  const { parseSimpleCsv } = require('./csv');
  if (getInventorySnapshot().length === 0) {
    const csvText = fs.readFileSync(path.join(__dirname, '..', 'sample_inventory.csv'), 'utf8');
    importInventoryRows(parseSimpleCsv(csvText));
    console.log('Seeded sample inventory (SEED_SAMPLE_ON_START=true, database was empty).');
  }
}

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`Inventory system server listening on http://localhost:${PORT}`);
});
