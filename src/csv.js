// A minimal CSV parser, so we don't need to pull in a CSV library.
// It is meant for "clean CSV you exported yourself", not for complex CSV with
// heavily nested quotes. Shared by the import script and the demo script to
// avoid duplicating the implementation.
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

module.exports = { parseSimpleCsv };
