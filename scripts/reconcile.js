// One-shot reconciliation: replay the ledger per SKU and compare against the
// live inventory table. Exits non-zero when drift or a broken ledger chain is
// found, so it can gate a cron alert or a CI check.
const { reconcileInventory } = require('../src/services');

const report = reconcileInventory();

console.log(`Checked ${report.checkedSkus} SKU(s) with ledger history.`);

if (report.consistent) {
  console.log('Ledger and live inventory agree. No drift detected.');
  process.exit(0);
}

if (report.mismatches.length > 0) {
  console.log('\nDrift between ledger replay and live stock:');
  console.table(report.mismatches);
}

if (report.chainViolations.length > 0) {
  console.log('\nLedger chain violations:');
  console.table(report.chainViolations);
}

process.exit(1);
