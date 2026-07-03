// Test helper: give each test file its own isolated SQLite database.
// `node --test` runs each test file in a separate process, so setting DB_PATH
// here (before requiring the app modules) keeps test files fully isolated.
const os = require('os');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(
  os.tmpdir(),
  `inv-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`
);
process.env.DB_PATH = dbPath;
process.env.PLATFORM_MODE = 'mock';
process.env.ENABLE_PLATFORM_PUSH = 'true';

const dbModule = require('../src/db');
const services = require('../src/services');

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore
    }
  }
}

module.exports = {
  db: dbModule.db,
  cleanup,
  ...services
};
