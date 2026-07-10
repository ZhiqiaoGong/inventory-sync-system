// Command go-worker is the v2 write-back relay for the inventory system.
//
// Milestone 2a (this file): the worker now *delivers* the write-backs. It polls
// the push_jobs outbox for due jobs and, for each one, calls the platform
// (mocked here) and advances the job through the same state machine the Node
// dispatcher uses: success, skipped, retry-with-backoff, or dead-letter.
// Concurrency comes in M2b; this version processes jobs sequentially.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"strconv"
	"time"

	// Imported only for its side effect: registers the "sqlite" driver.
	_ "modernc.org/sqlite"
)

// config holds the knobs, read once from the environment at startup. Mirrors
// the same env vars the Node side uses so both behave identically.
type config struct {
	dbPath          string
	enablePush      bool
	retryBaseMs     int64
	maxAttempts     int64 // used only as a fallback; each job carries its own
	failureRate     float64
	shopifyLocation string
}

func loadConfig() config {
	return config{
		dbPath:          getenv("WORKER_DB_PATH", "../inventory.db"),
		enablePush:      getenv("ENABLE_PLATFORM_PUSH", "true") != "false",
		retryBaseMs:     getenvInt("PUSH_RETRY_BASE_MS", 5000),
		maxAttempts:     getenvInt("PUSH_MAX_ATTEMPTS", 5),
		failureRate:     getenvFloat("MOCK_PUSH_FAILURE_RATE", 0),
		shopifyLocation: os.Getenv("SHOPIFY_LOCATION_ID"),
	}
}

// PushJob mirrors one row of the push_jobs outbox table.
type PushJob struct {
	ID            int64
	InternalSKU   string
	Platform      string
	TargetQty     int64
	Status        string
	Attempts      int64
	MaxAttempts   int64
	NextAttemptAt int64 // epoch milliseconds
}

// mapping holds the platform-routing fields we need to decide if a write-back
// is even possible. sql.NullString models a column that may be NULL.
type mapping struct {
	shopifyInventoryItemID sql.NullString
	shopifyLocationID      sql.NullString
	etsyListingID          sql.NullString
	etsyOfferingID         sql.NullString
}

func main() {
	once := flag.Bool("once", false, "poll a single time and exit (useful for cron / debugging)")
	flag.Parse()

	cfg := loadConfig()

	db, err := sql.Open("sqlite", cfg.dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("cannot reach db at %s: %v", cfg.dbPath, err)
	}

	log.Printf("worker started, delivering write-backs from %s (push=%v, failureRate=%.2f)",
		cfg.dbPath, cfg.enablePush, cfg.failureRate)

	for {
		jobs, err := findDueJobs(db, time.Now().UnixMilli())
		if err != nil {
			log.Printf("query error: %v", err)
		} else if len(jobs) == 0 {
			log.Printf("no due jobs")
		} else {
			for _, j := range jobs {
				outcome := attemptWriteback(db, cfg, j, time.Now().UnixMilli())
				log.Printf("job #%d %s/%s -> %s", j.ID, j.InternalSKU, j.Platform, outcome)
			}
		}

		if *once {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

// attemptWriteback runs one delivery attempt for a job and advances its state.
// It returns a short outcome string for logging. This is a direct port of
// attemptPushJob() in src/services.js — same order of checks, same backoff.
func attemptWriteback(db *sql.DB, cfg config, job PushJob, nowMs int64) string {
	attempts := job.Attempts + 1

	// A skip is terminal but non-fatal: the job cannot be delivered as
	// configured, so we mark it skipped (no retry) and move on.
	skip := func(reason string) string {
		mustExec(db,
			`UPDATE push_jobs SET status='skipped', attempts=?, last_error=?, updated_at=datetime('now') WHERE id=?`,
			attempts, reason, job.ID)
		logPush(db, job, "skipped", reason)
		return "skipped: " + reason
	}

	if !cfg.enablePush {
		return skip("ENABLE_PLATFORM_PUSH=false")
	}

	m, err := findMapping(db, job.InternalSKU)
	if err != nil {
		return fmt.Sprintf("db error: %v", err)
	}
	if m == nil {
		return skip("no SKU mapping found")
	}

	// Per-platform routing completeness — same conditions as the Node side.
	if job.Platform == "shopify" {
		if !has(m.shopifyInventoryItemID) || !(has(m.shopifyLocationID) || cfg.shopifyLocation != "") {
			return skip("missing Shopify inventory mapping")
		}
	} else {
		if !has(m.etsyListingID) || !has(m.etsyOfferingID) {
			return skip("missing Etsy mapping / offering id")
		}
	}

	// The actual platform call (mocked). nil means delivered.
	if callErr := callPlatform(cfg); callErr == nil {
		mustExec(db,
			`UPDATE push_jobs SET status='succeeded', attempts=?, last_error=NULL, updated_at=datetime('now') WHERE id=?`,
			attempts, job.ID)
		logPush(db, job, "success", fmt.Sprintf("%s inventory updated (attempt %d)", job.Platform, attempts))
		return fmt.Sprintf("succeeded (attempt %d)", attempts)
	} else {
		// Delivery failed.
		if attempts >= job.MaxAttempts {
			mustExec(db,
				`UPDATE push_jobs SET status='dead_letter', attempts=?, last_error=?, updated_at=datetime('now') WHERE id=?`,
				attempts, callErr.Error(), job.ID)
			logPush(db, job, "failed", fmt.Sprintf("dead-lettered after %d attempts: %v", attempts, callErr))
			return fmt.Sprintf("dead-lettered after %d attempts", attempts)
		}

		// Exponential backoff: base * 2^(attempts-1), scheduled from now.
		delayMs := cfg.retryBaseMs * (int64(1) << uint(attempts-1))
		nextAt := nowMs + delayMs
		mustExec(db,
			`UPDATE push_jobs SET attempts=?, next_attempt_at=?, last_error=?, updated_at=datetime('now') WHERE id=?`,
			attempts, nextAt, callErr.Error(), job.ID)
		logPush(db, job, "failed", fmt.Sprintf("attempt %d failed, retry in %dms: %v", attempts, delayMs, callErr))
		return fmt.Sprintf("failed (attempt %d), retry in %dms", attempts, delayMs)
	}
}

// callPlatform simulates the platform write-back. In mock mode it fails with a
// simulated 503 at the configured probability, otherwise succeeds. (Real HTTP
// calls to Shopify/Etsy would live here in live mode.)
func callPlatform(cfg config) error {
	if cfg.failureRate > 0 && rand.Float64() < cfg.failureRate {
		return fmt.Errorf("mock transient failure: HTTP 503 (simulated platform outage)")
	}
	return nil
}

// findMapping loads the routing fields for a SKU, or nil if there is no mapping.
func findMapping(db *sql.DB, sku string) (*mapping, error) {
	const q = `SELECT shopify_inventory_item_id, shopify_location_id, etsy_listing_id, etsy_offering_id
	           FROM sku_mappings WHERE internal_sku = ?`
	var m mapping
	err := db.QueryRow(q, sku).Scan(
		&m.shopifyInventoryItemID, &m.shopifyLocationID, &m.etsyListingID, &m.etsyOfferingID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func findDueJobs(db *sql.DB, nowMs int64) ([]PushJob, error) {
	const query = `
		SELECT id, internal_sku, platform, target_quantity,
		       status, attempts, max_attempts, next_attempt_at
		FROM push_jobs
		WHERE status = 'pending' AND next_attempt_at <= ?
		ORDER BY next_attempt_at ASC
		LIMIT 50`

	rows, err := db.Query(query, nowMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []PushJob
	for rows.Next() {
		var j PushJob
		if err := rows.Scan(
			&j.ID, &j.InternalSKU, &j.Platform, &j.TargetQty,
			&j.Status, &j.Attempts, &j.MaxAttempts, &j.NextAttemptAt,
		); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

// logPush records one attempt in sync_push_logs, mirroring the Node side.
func logPush(db *sql.DB, job PushJob, status, message string) {
	mustExec(db,
		`INSERT INTO sync_push_logs (internal_sku, platform, target_quantity, status, message)
		 VALUES (?, ?, ?, ?, ?)`,
		job.InternalSKU, job.Platform, job.TargetQty, status, message)
}

// --- small helpers ---

// mustExec runs a write and logs (does not crash) on error, so one bad job
// doesn't take the whole worker down.
func mustExec(db *sql.DB, query string, args ...any) {
	if _, err := db.Exec(query, args...); err != nil {
		log.Printf("exec error: %v", err)
	}
}

// has reports whether a nullable column is present and non-empty.
func has(ns sql.NullString) bool { return ns.Valid && ns.String != "" }

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func getenvFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
