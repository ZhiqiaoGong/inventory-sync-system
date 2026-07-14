// Command go-worker is the v2 write-back relay for the inventory system.
//
// It polls the push_jobs outbox for due jobs and delivers them to the platforms
// (mocked here), advancing each job through the same state machine as the Node
// dispatcher: success, skipped, retry-with-backoff, or dead-letter.
//
// Delivery is concurrent (a pool of goroutines) and exactly-once even across
// multiple worker processes: each job is atomically claimed via a lease before
// it is worked, so no two workers deliver the same job. See runBatch/claimJob.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"strconv"
	"sync"
	"time"

	// Imported only for its side effect: registers the "sqlite" driver.
	_ "modernc.org/sqlite"
)

// leaseMs is the visibility timeout: when a worker claims a job it hides the
// job for this long, so no other worker (in this process or another) picks it
// up while it is being delivered. If the worker crashes mid-delivery, the lease
// expires and the still-pending job becomes due again — safe because platform
// write-backs are idempotent absolute sets.
const leaseMs int64 = 30_000

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
	mode := flag.String("mode", "poll", "poll | kafka-demo (relay/consumer added in M3b)")
	once := flag.Bool("once", false, "poll a single time and exit (useful for cron / debugging)")
	workers := flag.Int("workers", 4, "number of concurrent delivery goroutines")
	flag.Parse()

	// kafka-demo is a standalone hello-world that needs no database.
	if *mode == "kafka-demo" {
		runKafkaDemo(getenv("KAFKA_BROKER", "localhost:9092"), getenv("KAFKA_TOPIC", "go-demo"))
		return
	}

	cfg := loadConfig()

	// busy_timeout makes a connection WAIT (up to 5s) for the SQLite write lock
	// instead of failing with "database is locked" — essential when several
	// worker processes hit the same file.
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", cfg.dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("cannot reach db at %s: %v", cfg.dbPath, err)
	}

	log.Printf("worker started: %d goroutines, db=%s (push=%v, failureRate=%.2f)",
		*workers, cfg.dbPath, cfg.enablePush, cfg.failureRate)

	for {
		n := runBatch(db, cfg, *workers)
		if n == 0 {
			log.Printf("no due jobs")
		}
		if *once {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

// runBatch delivers all currently-due jobs using a pool of numWorkers
// goroutines. It returns how many jobs were claimed and handed off.
//
// Shape: one producer (this goroutine) finds due jobs and atomically claims
// each one, sending the winners into a channel; numWorkers consumer goroutines
// read from the channel and deliver. A WaitGroup lets us block until every
// worker has drained the channel.
func runBatch(db *sql.DB, cfg config, numWorkers int) int {
	now := time.Now().UnixMilli()
	jobs, err := findDueJobs(db, now)
	if err != nil {
		log.Printf("query error: %v", err)
		return 0
	}
	if len(jobs) == 0 {
		return 0
	}

	// jobsCh is the hand-off pipe from producer to workers. An unbuffered
	// channel means a send blocks until some worker is ready to receive —
	// natural backpressure.
	jobsCh := make(chan PushJob)
	var wg sync.WaitGroup

	// Start the worker pool. Each goroutine ranges over the channel until it
	// is closed, delivering whatever jobs it receives.
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for job := range jobsCh {
				outcome := attemptWriteback(db, cfg, job, time.Now().UnixMilli())
				log.Printf("[w%d] job #%d %s/%s -> %s",
					workerID, job.ID, job.InternalSKU, job.Platform, outcome)
			}
		}(i)
	}

	// Producer: claim each due job atomically; only the winner sends it on.
	claimed := 0
	for _, j := range jobs {
		won, err := claimJob(db, j.ID, now)
		if err != nil {
			log.Printf("claim error on job #%d: %v", j.ID, err)
			continue
		}
		if won {
			claimed++
			jobsCh <- j // blocks until a worker takes it
		}
		// If we did not win the claim, another worker already owns this job —
		// we simply move on. This is the exactly-once guarantee in action.
	}

	close(jobsCh) // no more jobs → workers finish their range loop and exit
	wg.Wait()     // block until every worker has returned
	return claimed
}

// claimJob atomically leases a due, pending job by pushing its next_attempt_at
// into the future. RowsAffected == 1 means THIS caller won the claim; 0 means
// another worker got there first. Because the UPDATE's WHERE clause re-checks
// status='pending' AND next_attempt_at<=now, the database — not application
// code — arbitrates the race, exactly like the ingestion path's UNIQUE
// constraint. This is what makes delivery exactly-once even across processes.
func claimJob(db *sql.DB, id, nowMs int64) (bool, error) {
	res, err := db.Exec(
		`UPDATE push_jobs SET next_attempt_at = ?
		 WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
		nowMs+leaseMs, id, nowMs)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
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
