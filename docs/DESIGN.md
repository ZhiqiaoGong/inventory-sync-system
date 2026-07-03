# Design decisions

This document records _why_ the system is shaped the way it is — the problems, the options
considered, and what each decision costs. The README describes what the system does; this is the
reasoning behind it.

The context throughout: a small e-commerce team selling on Shopify and Etsy, previously tracking
stock in spreadsheets, with a catalog where most SKUs are simple but a meaningful minority are
bundles, kits, or pack-vs-unit mismatches.

---

## 1. Tiered sync instead of all-or-nothing automation

**Problem.** "Sync everything automatically" systems fail on the messy minority of SKUs. A bundle
that decrements three component SKUs, or a listing sold by the pack but stocked by the unit, will
silently corrupt stock counts. Once trust is lost, teams turn the automation off entirely — for
every SKU.

**Decision.** Treat sync as a spectrum with three tiers: tier1 (fully managed: decrement + write
back), tier2 (tracked internally, never pushed), tier3 (order logged, stock managed manually).
Each SKU opts into exactly the level of automation it can support.

**Alternatives considered.** Full automation with bundle-expansion rules was rejected as a first
step: the rules are the hard part, and getting one wrong corrupts stock silently. Manual-only
(status quo) was what the team was escaping.

**Cost.** Tier2/tier3 SKUs keep their manual workload, and the tier assignment itself is a human
judgment that can be wrong. The bet is that trustworthy automation for 80% beats untrustworthy
automation for 100%.

## 2. The internal table is the single source of truth

**Problem.** With two sales channels plus a stockroom, "how many do we actually have?" needs one
authoritative answer.

**Decision.** All stock truth lives in `inventory_items`. Platforms are downstream projections:
orders flow in, absolute quantities flow out. Data flows in one direction.

**Alternatives considered.** Bidirectional sync (platforms can also be edited, changes merge) was
rejected: it requires conflict resolution (two channels sell the last unit at the same minute —
who wins?), and conflict resolution bugs corrupt the very number the system exists to protect.

**Cost.** Stock edited directly on a platform is overwritten by the next push. That is by design,
but it surprises people used to editing Shopify directly — mitigated by the audit ledger and
reconciliation, which make any drift visible instead of silent.

## 3. Exactly-once order processing via an idempotent event store

**Problem.** The same order arrives many times: polling overlaps, webhooks redeliver, a cron job
and a manual sync race each other, a process crashes mid-batch and the batch is re-run. Stock must
be decremented exactly once per order regardless.

**Decision.** Every incoming order is recorded in `order_events`, idempotent by
`(platform, external_event_id)`. Processing is keyed off that insert. The UNIQUE constraint — not
application code — is the final arbiter: two processes can both pass the "have we seen this?"
check, but only one insert commits; the loser handles the constraint violation as "duplicate".

**Alternatives considered.** A check-then-insert without constraint handling has a race window
(this was a real bug found while building the concurrency test). Trusting platform-side "sent
once" guarantees contradicts both platforms' documented redelivery behavior.

**Cost.** Raw payloads are stored per event (disk), and every ingest pays a uniqueness check. Both
are cheap next to a double-decremented SKU. Verified by a test racing 4 processes over the same 60
orders, and by `npm run bench` at larger scale.

## 4. Oversell clamps to zero instead of erroring

**Problem.** An order for 5 units arrives when the table says 3. What now?

**Decision.** Decrement to zero, flag the sale as oversold, record the requested-vs-available gap
in the ledger, and keep going.

**Why not reject the order?** The sale already happened on the platform; the customer paid.
Refusing to record it doesn't undo reality — it just makes the database wrong AND the team
uninformed. Negative stock was also rejected: it reads as nonsense to humans and breaks the
"available units" contract with the platforms.

**Cost.** During an oversell the table says 0 while physical reality may differ; the ledger's
oversell annotation is what routes a human to recount. This is a deliberate "record reality,
alert, continue" posture.

## 5. Transactional outbox for platform write-backs

**Problem.** After a tier1 sale decrements stock, the new quantity must reach Shopify and Etsy —
but platform APIs fail, rate-limit, and time out. Calling them inline couples a local transaction
to remote availability; calling them after commit means a crash in between silently loses the
write-back.

**Decision.** The same SQLite transaction that decrements stock also inserts a `push_jobs` row
("write-back owed"). A dispatcher delivers jobs with exponential backoff; after max attempts a job
dead-letters for a human. Because pushes are absolute ("set stock to N"), a pending job for the
same SKU+platform is coalesced to the latest value rather than queued behind stale ones.

**Alternatives considered.** A message broker (Redis/RabbitMQ/Kafka) provides the same pattern but
adds an infrastructure dependency this deployment size cannot justify — the outbox table gives
at-least-once delivery with zero new moving parts. Fire-and-forget with logging (the first
version) records failures but never repairs them.

**Cost.** Delivery is at-least-once, not exactly-once — safe here only because pushes are
idempotent absolute sets, which is also why coalescing is sound. Dead-letter requeue is a human
decision by design; the system does not guess when an outage is over.

## 6. Append-only ledger + reconciliation instead of full event sourcing

**Problem.** When stock is wrong, "wrong since when, and why?" must be answerable. And any code
path (or human) that mutates stock without leaving a trace creates silent drift.

**Decision.** Every stock change — sales and imports alike — appends a ledger row with
`before`, `change`, `after`. Reconciliation replays each SKU's chain and cross-checks two
invariants: the chain is internally consistent (`before + change == after`, links are gapless),
and the chain's final value equals live stock. Runs are persisted as an audit trail.

**Alternatives considered.** Full event sourcing (live stock derived _only_ from events) gives
stronger guarantees but complicates every read and rebuild. The table+ledger pair keeps reads
trivial while reconciliation supplies the "would the events reproduce this state?" check — most of
the benefit at a fraction of the complexity.

**Cost.** The ledger grows forever (fine at this scale; archivable later), and drift detection is
periodic rather than preventive — reconciliation tells you _that_ and _where_ stock diverged, not
_who_ did it.

## 7. SQLite + better-sqlite3, single host

**Problem.** Pick a datastore for a system whose real-world load is a few orders per minute, run
by a team with no ops staff.

**Decision.** SQLite in WAL mode via better-sqlite3. Multi-process safety (server + cron workers)
comes from IMMEDIATE transactions — taking the write lock up front, so read-then-write decrements
never operate on a stale snapshot — plus a `busy_timeout` so writers queue instead of failing.

**Why it holds.** better-sqlite3's synchronous API makes transactions trivially correct to reason
about (no interleaving inside a transaction), and the benchmark shows the ceiling is thousands of
orders/sec — several orders of magnitude above the workload. Zero-config also serves the project's
demo goal: `npm install && npm run demo` with no database service.

**Cost.** Single-machine by nature: no multi-host deployment, no managed backups/replication.
Growing past one host means Postgres (row locks replace IMMEDIATE transactions, `SELECT ... FOR
UPDATE` replaces the write-lock discipline) — the seams are the prepared-statement layer in
`db.js`, which is why all SQL lives there.

## 8. Webhooks verified on raw bytes, coexisting with polling

**Problem.** Push-based ingestion (webhooks) is fresher than polling, but a webhook endpoint is an
open door: anyone who finds the URL can POST a fake order.

**Decision.** `POST /webhooks/shopify` verifies Shopify's HMAC-SHA256 signature over the **raw
request body** with a timing-safe comparison, before any parsing. Replay protection needs no extra
machinery: a replayed delivery is a duplicate event id, which the idempotent event store already
rejects. Polling remains as backfill — webhooks miss deliveries; the poll catches what push missed,
and idempotency makes the overlap free.

**Cost.** The raw-body requirement forces careful middleware ordering (the webhook route must
bypass the JSON body parser), which is easy to get wrong silently — one reason it is covered by
tests over real HTTP.
