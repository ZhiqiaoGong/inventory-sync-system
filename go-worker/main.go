// Command go-worker is the v2 write-back relay for the inventory system.
//
// Milestone 1 (this file): a read-only "polling publisher" — it opens the same
// SQLite database the Node app writes to, polls the push_jobs outbox for jobs
// that are due, and prints them. No write-backs yet; that comes in M2.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	// The blank identifier "_" imports the driver only for its side effect:
	// on import, the package registers itself with database/sql under the
	// name "sqlite". We never call its functions directly.
	_ "modernc.org/sqlite"
)

// PushJob mirrors one row of the push_jobs outbox table. Go has no classes;
// a struct is just a typed bag of fields. Field names are capitalized because
// in Go, capitalization controls visibility (exported vs package-private).
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

func main() {
	// Command-line flags. flag.Bool returns a *bool (a pointer); the actual
	// value is read later as *once. flag.Parse() populates it from os.Args.
	once := flag.Bool("once", false, "poll a single time and exit (useful for cron / debugging)")
	flag.Parse()

	// Where is the database? Default to the repo's inventory.db (one level up,
	// since this binary runs from go-worker/), overridable by an env var.
	dbPath := os.Getenv("WORKER_DB_PATH")
	if dbPath == "" {
		dbPath = "../inventory.db"
	}

	// sql.Open does NOT connect yet — it just prepares a connection pool.
	// The "sqlite" name is what the driver registered itself as above.
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		// log.Fatalf prints and exits(1). This is Go's explicit error style:
		// functions return an error value, and you check it right away.
		log.Fatalf("open db: %v", err)
	}
	defer db.Close() // defer runs this when main() returns — like a finally block.

	// Ping forces an actual connection so we fail loudly if the path is wrong.
	if err := db.Ping(); err != nil {
		log.Fatalf("cannot reach db at %s: %v", dbPath, err)
	}

	log.Printf("worker started, polling %s every 2s", dbPath)

	// The polling loop. for{} with no condition is Go's infinite loop.
	for {
		jobs, err := findDueJobs(db, time.Now().UnixMilli())
		if err != nil {
			log.Printf("query error: %v", err)
		} else if len(jobs) == 0 {
			log.Printf("no due jobs")
		} else {
			log.Printf("found %d due job(s):", len(jobs))
			for _, j := range jobs {
				fmt.Printf("  job #%d  %-18s %-8s target=%d status=%s attempts=%d/%d\n",
					j.ID, j.InternalSKU, j.Platform, j.TargetQty, j.Status, j.Attempts, j.MaxAttempts)
			}
		}

		// In -once mode, stop after a single poll instead of looping.
		// *once dereferences the pointer to read the bool value.
		if *once {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

// findDueJobs returns pending outbox jobs whose next_attempt_at has passed.
// Returning (result, error) is the idiomatic Go signature.
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
		// Scan copies the columns of the current row into our struct fields,
		// in the same order as the SELECT. &j.ID passes a pointer so Scan can
		// write into it.
		if err := rows.Scan(
			&j.ID, &j.InternalSKU, &j.Platform, &j.TargetQty,
			&j.Status, &j.Attempts, &j.MaxAttempts, &j.NextAttemptAt,
		); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	// rows.Err() surfaces any error that ended the loop early.
	return jobs, rows.Err()
}
