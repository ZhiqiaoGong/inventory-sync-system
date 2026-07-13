package main

import (
	"database/sql"
	"fmt"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
)

// setupTestDB creates a throwaway SQLite database with just the tables the
// worker touches, seeded with numSKUs SKUs × 2 platforms of due pending jobs.
// t.TempDir() and t.Cleanup() give each test its own DB, auto-removed at the end.
func setupTestDB(t *testing.T, numSKUs int) *sql.DB {
	t.Helper()

	dbPath := t.TempDir() + "/test.db"
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	const schema = `
	CREATE TABLE push_jobs (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  internal_sku TEXT NOT NULL,
	  platform TEXT NOT NULL,
	  target_quantity INTEGER NOT NULL,
	  status TEXT NOT NULL DEFAULT 'pending',
	  attempts INTEGER NOT NULL DEFAULT 0,
	  max_attempts INTEGER NOT NULL DEFAULT 5,
	  next_attempt_at INTEGER NOT NULL,
	  last_error TEXT,
	  created_at TEXT DEFAULT (datetime('now')),
	  updated_at TEXT DEFAULT (datetime('now'))
	);
	CREATE TABLE sku_mappings (
	  internal_sku TEXT UNIQUE,
	  shopify_inventory_item_id TEXT, shopify_location_id TEXT,
	  etsy_listing_id TEXT, etsy_offering_id TEXT
	);
	CREATE TABLE sync_push_logs (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  internal_sku TEXT, platform TEXT, target_quantity INTEGER,
	  status TEXT, message TEXT, created_at TEXT DEFAULT (datetime('now'))
	);`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}

	for i := 0; i < numSKUs; i++ {
		sku := fmt.Sprintf("SKU-%d", i)
		if _, err := db.Exec(
			`INSERT INTO sku_mappings
			 (internal_sku, shopify_inventory_item_id, shopify_location_id, etsy_listing_id, etsy_offering_id)
			 VALUES (?, ?, '1', ?, ?)`,
			sku, fmt.Sprint(800000+i), fmt.Sprint(700000+i), fmt.Sprint(600000+i)); err != nil {
			t.Fatalf("seed mapping: %v", err)
		}
		for _, p := range []string{"shopify", "etsy"} {
			if _, err := db.Exec(
				`INSERT INTO push_jobs
				 (internal_sku, platform, target_quantity, status, attempts, max_attempts, next_attempt_at)
				 VALUES (?, ?, 100, 'pending', 0, 5, 0)`, sku, p); err != nil {
				t.Fatalf("seed job: %v", err)
			}
		}
	}
	return db
}

func readJob(t *testing.T, db *sql.DB, id int64) PushJob {
	t.Helper()
	var j PushJob
	err := db.QueryRow(
		`SELECT id, internal_sku, platform, target_quantity, status, attempts, max_attempts, next_attempt_at
		 FROM push_jobs WHERE id = ?`, id).
		Scan(&j.ID, &j.InternalSKU, &j.Platform, &j.TargetQty, &j.Status, &j.Attempts, &j.MaxAttempts, &j.NextAttemptAt)
	if err != nil {
		t.Fatalf("read job %d: %v", id, err)
	}
	return j
}

func count(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// TestConcurrentDeliveryIsExactlyOnce is the headline test: several worker
// instances race the same outbox at once, and every job must be delivered
// exactly once. Run with `go test -race` to also prove there are no data races.
func TestConcurrentDeliveryIsExactlyOnce(t *testing.T) {
	const numSKUs = 25 // 25 SKUs × 2 platforms = 50 jobs
	const instances = 6
	totalJobs := numSKUs * 2

	db := setupTestDB(t, numSKUs)
	cfg := config{enablePush: true, retryBaseMs: 100, maxAttempts: 5, failureRate: 0}

	// Each goroutine simulates a separate worker process racing the same DB.
	var wg sync.WaitGroup
	for i := 0; i < instances; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runBatch(db, cfg, 4)
		}()
	}
	wg.Wait()

	// 1. Every job reached the terminal succeeded state.
	if got := count(t, db, `SELECT COUNT(*) FROM push_jobs WHERE status='succeeded'`); got != totalJobs {
		t.Fatalf("succeeded jobs = %d, want %d", got, totalJobs)
	}

	// 2. No job was delivered more than once (the exactly-once guarantee).
	dupes := count(t, db, `
		SELECT COUNT(*) FROM (
			SELECT internal_sku, platform FROM sync_push_logs
			WHERE status='success' GROUP BY internal_sku, platform HAVING COUNT(*) > 1
		)`)
	if dupes != 0 {
		t.Fatalf("found %d double-delivered jobs, want 0", dupes)
	}

	// 3. Exactly one success log per job — no more, no fewer.
	if got := count(t, db, `SELECT COUNT(*) FROM sync_push_logs WHERE status='success'`); got != totalJobs {
		t.Fatalf("success logs = %d, want %d", got, totalJobs)
	}
}

// TestRetryThenDeadLetter locks the failure state machine: a job that always
// fails is retried until it exhausts max_attempts, then dead-lettered.
func TestRetryThenDeadLetter(t *testing.T) {
	db := setupTestDB(t, 1) // job id 1 = SKU-0 / shopify, max_attempts=5
	cfg := config{enablePush: true, retryBaseMs: 10, maxAttempts: 5, failureRate: 1}

	const id = int64(1)
	for i := 0; i < 5; i++ {
		job := readJob(t, db, id) // re-read to pick up the incremented attempts
		attemptWriteback(db, cfg, job, int64(i))
	}

	final := readJob(t, db, id)
	if final.Status != "dead_letter" {
		t.Fatalf("status = %q, want dead_letter", final.Status)
	}
	if final.Attempts != 5 {
		t.Fatalf("attempts = %d, want 5", final.Attempts)
	}
	// Every attempt should have left a failure log.
	if got := count(t, db, `SELECT COUNT(*) FROM sync_push_logs WHERE status='failed'`); got != 5 {
		t.Fatalf("failed logs = %d, want 5", got)
	}
}
