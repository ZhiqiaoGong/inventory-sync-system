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
- **Milestone 3a (done):** Kafka is up (Redpanda via `docker-compose.kafka.yml`)
  and the worker can produce/consume through it — see `-mode=kafka-demo`.
  Learned topics, partitions, offsets, consumer groups, key-based partitioning.
- **Milestone 3b (done):** Kafka wired into the real flow. An outbox **relay**
  (`-mode=relay`) atomically claims due jobs and publishes them (keyed by SKU)
  to the `stock-changes` topic; a **consumer** (`-mode=consumer`, group
  `writeback`) re-reads each job from the DB and delivers it via the M2 state
  machine. The outbox stays the retry engine and the DB stays the source of
  truth, so redelivered messages are idempotent. A second consumer group
  (`-mode=audit`) proves **fan-out** — it sees every event independently.
  Verified end-to-end: 8 jobs relayed → delivered exactly once, both groups saw
  all 8.
- **Milestone 4:** containerize and deploy to AWS.

## Kafka (local)

```bash
docker compose -f ../docker-compose.kafka.yml up -d   # start Redpanda on :9092
docker exec inventory-redpanda rpk topic create stock-changes -p 3

# The real pipeline (each in its own terminal, from the repo root DB):
./worker -mode=consumer      # group "writeback": deliver events
./worker -mode=audit         # group "audit": independently log every event (fan-out)
./worker -mode=relay         # claim due outbox jobs and publish them to Kafka

./worker -mode=kafka-demo     # standalone produce/consume hello-world
docker compose -f ../docker-compose.kafka.yml down    # stop
```

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

## Test

```bash
go test -race ./...
```

`TestConcurrentDeliveryIsExactlyOnce` races 6 worker instances over the same 50
jobs and asserts each is delivered exactly once (zero duplicates); `-race` also
proves there are no data races. `TestRetryThenDeadLetter` locks the retry →
dead-letter state machine. Each test builds its own throwaway SQLite database.

## Notes

- Uses the pure-Go SQLite driver `modernc.org/sqlite` (no CGO), so the binary is
  self-contained and trivial to containerize later.
