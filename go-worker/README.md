# go-worker — write-back relay (v2)

A standalone Go service that delivers platform write-backs for the inventory
system. It is the v2 evolution of the in-process Node dispatcher: the write-back
responsibility is pulled out into a separate process that coordinates with the
Node app **only through the `push_jobs` outbox table**.

This is the textbook **Transactional Outbox + Polling Publisher** pattern: the
Node app enqueues a `push_jobs` row in the same transaction that changes stock;
this worker polls the outbox for due jobs and delivers them.

## Status

- **Milestone 1 (done):** read-only poller — connects to the SQLite database,
  polls `push_jobs` for jobs whose `next_attempt_at` has passed, and prints them.
- **Milestone 2a (done):** delivers the write-backs — for each due job it calls
  the platform (mocked) and advances the job through the same state machine as
  the Node dispatcher: success, skipped, retry with exponential backoff, or
  dead-letter. Ported from `attemptPushJob` in `src/services.js`.
- **Milestone 2b (done):** concurrent delivery via a goroutine worker pool, with
  **atomic lease-based job claiming** so delivery is exactly-once even when
  several worker processes run against the same database. Verified by racing two
  worker processes over the same 30 jobs: each delivered exactly once, zero
  duplicates.
- **Milestone 3:** consume events from Kafka instead of polling SQLite.
- **Milestone 4:** containerize and deploy to AWS.

## Run

```bash
go build -o worker .        # compile to a single static binary
./worker                    # poll every 2s, forever
./worker -once              # poll a single time and exit (cron / debugging)

# Point at a different database:
WORKER_DB_PATH=/path/to/inventory.db ./worker
```

The Node side creates due jobs whenever a tier1 write-back fails, e.g. run a sale
with `MOCK_PUSH_FAILURE_RATE=1` from the repo root.

## Notes

- Uses the pure-Go SQLite driver `modernc.org/sqlite` (no CGO), so the binary is
  self-contained and trivial to containerize later.
