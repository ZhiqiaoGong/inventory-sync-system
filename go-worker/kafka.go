package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

// StockEvent is the JSON payload published to the stock-changes topic. It is a
// pointer to a job, not the job itself: the consumer re-reads the current row
// by JobID, so the database stays the source of truth even if a message is
// redelivered.
type StockEvent struct {
	JobID       int64  `json:"job_id"`
	InternalSKU string `json:"internal_sku"`
	Platform    string `json:"platform"`
	TargetQty   int64  `json:"target_quantity"`
}

// runRelay is the outbox → Kafka publisher. It polls the push_jobs outbox for
// due jobs, atomically claims each one (so no other relay double-publishes),
// and publishes it to the topic keyed by SKU (so all events for one SKU keep
// their order within a partition). The outbox remains the retry engine: a job
// that later fails is rescheduled by the consumer and re-published here when
// it comes due again.
func runRelay(db *sql.DB, cfg config, broker, topic string, once bool) {
	w := &kafka.Writer{
		Addr:         kafka.TCP(broker),
		Topic:        topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
	defer w.Close()

	log.Printf("relay started: outbox %s -> kafka topic %q", cfg.dbPath, topic)

	for {
		now := time.Now().UnixMilli()
		jobs, err := findDueJobs(db, now)
		if err != nil {
			log.Printf("relay query error: %v", err)
		}

		published := 0
		for _, j := range jobs {
			won, err := claimJob(db, j.ID, now)
			if err != nil {
				log.Printf("relay claim error #%d: %v", j.ID, err)
				continue
			}
			if !won {
				continue // another relay instance already owns this job
			}

			val, _ := json.Marshal(StockEvent{
				JobID: j.ID, InternalSKU: j.InternalSKU, Platform: j.Platform, TargetQty: j.TargetQty,
			})
			if err := w.WriteMessages(context.Background(),
				kafka.Message{Key: []byte(j.InternalSKU), Value: val}); err != nil {
				log.Printf("relay publish error #%d: %v", j.ID, err)
				// Publish failed after claiming — release the lease so the next
				// poll re-picks the job instead of stranding it for 30s.
				mustExec(db, `UPDATE push_jobs SET next_attempt_at=? WHERE id=? AND status='pending'`, now, j.ID)
				continue
			}
			published++
			log.Printf("relay published job #%d %s/%s", j.ID, j.InternalSKU, j.Platform)
		}

		if published == 0 {
			log.Printf("relay: nothing to publish")
		}
		if once {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

// runConsumer reads a topic as part of a named consumer group and calls handle
// for every message. Two different groupIDs on the same topic each receive the
// full stream independently — that is Kafka's fan-out.
func runConsumer(broker, topic, groupID string, handle func(kafka.Message)) {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     []string{broker},
		Topic:       topic,
		GroupID:     groupID,
		StartOffset: kafka.FirstOffset, // used only when the group has no committed offset yet
	})
	defer r.Close()

	log.Printf("consumer[%s] started on topic %q", groupID, topic)
	for {
		m, err := r.ReadMessage(context.Background()) // auto-commits the offset on success
		if err != nil {
			log.Printf("consumer[%s] read error: %v", groupID, err)
			return
		}
		handle(m)
	}
}

// makeWritebackHandler returns a handler that delivers each event by re-reading
// the job from the DB and running the M2 write-back state machine. Re-reading
// (instead of trusting the message) makes redelivery idempotent: a job that is
// already succeeded/skipped/dead-lettered is simply skipped.
func makeWritebackHandler(db *sql.DB, cfg config) func(kafka.Message) {
	return func(m kafka.Message) {
		var ev StockEvent
		if err := json.Unmarshal(m.Value, &ev); err != nil {
			log.Printf("[writeback] bad message skipped: %v", err)
			return
		}
		job, found, err := findJobByID(db, ev.JobID)
		if err != nil {
			log.Printf("[writeback] db error job #%d: %v", ev.JobID, err)
			return
		}
		if !found || job.Status != "pending" {
			log.Printf("[writeback] job #%d not pending (skipped)", ev.JobID)
			return
		}
		outcome := attemptWriteback(db, cfg, job, time.Now().UnixMilli())
		log.Printf("[writeback] job #%d %s/%s -> %s", job.ID, job.InternalSKU, job.Platform, outcome)
	}
}

// auditHandler is a trivial second consumer: it just logs every event, proving
// that an independent consumer group sees the whole stream.
func auditHandler(m kafka.Message) {
	log.Printf("[audit] key=%-8s partition=%d offset=%d value=%s", m.Key, m.Partition, m.Offset, m.Value)
}

// runKafkaDemo is the Milestone 3a hello-world kept for reference: produce a
// few messages, then consume them back. Run via `-mode=kafka-demo`.
func runKafkaDemo(broker, topic string) {
	w := &kafka.Writer{
		Addr:         kafka.TCP(broker),
		Topic:        topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
	defer w.Close()

	msgs := []kafka.Message{
		{Key: []byte("SKU-1"), Value: []byte("SKU-1 -> shopify qty=117")},
		{Key: []byte("SKU-2"), Value: []byte("SKU-2 -> etsy    qty=60")},
		{Key: []byte("SKU-1"), Value: []byte("SKU-1 -> shopify qty=115")},
	}
	if err := w.WriteMessages(context.Background(), msgs...); err != nil {
		log.Fatalf("produce: %v", err)
	}
	log.Printf("produced %d messages to topic %q", len(msgs), topic)

	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     []string{broker},
		Topic:       topic,
		GroupID:     "kafka-demo-consumer",
		StartOffset: kafka.FirstOffset,
	})
	defer r.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for i := 0; i < len(msgs); i++ {
		m, err := r.ReadMessage(ctx)
		if err != nil {
			log.Printf("consume stopped: %v", err)
			return
		}
		log.Printf("consumed  partition=%d offset=%d  key=%-6s value=%q", m.Partition, m.Offset, m.Key, m.Value)
	}
}
