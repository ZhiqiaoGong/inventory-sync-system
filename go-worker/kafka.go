package main

import (
	"context"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

// runKafkaDemo is a self-contained hello-world (Milestone 3a): produce a few
// messages to a topic, then consume them back. It exists to learn the Go
// producer/consumer API; the real relay/consumer wiring comes in M3b.
func runKafkaDemo(broker, topic string) {
	// --- Producer ---
	// A Writer sends messages to a topic. Balancer decides the partition:
	// Hash routes by key hash, so all messages with the same key land in the
	// same partition and therefore stay ordered relative to each other.
	w := &kafka.Writer{
		Addr:         kafka.TCP(broker),
		Topic:        topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll, // wait for all in-sync replicas before ack (durability)
	}
	defer w.Close()

	msgs := []kafka.Message{
		{Key: []byte("SKU-1"), Value: []byte("SKU-1 -> shopify qty=117")},
		{Key: []byte("SKU-2"), Value: []byte("SKU-2 -> etsy    qty=60")},
		{Key: []byte("SKU-1"), Value: []byte("SKU-1 -> shopify qty=115")}, // same key as #1
	}
	if err := w.WriteMessages(context.Background(), msgs...); err != nil {
		log.Fatalf("produce: %v", err)
	}
	log.Printf("produced %d messages to topic %q", len(msgs), topic)

	// --- Consumer ---
	// A Reader in a consumer group reads messages and tracks its offset. Starting
	// at FirstOffset means "from the beginning" the first time this group runs.
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
		m, err := r.ReadMessage(ctx) // auto-commits the offset on success
		if err != nil {
			log.Printf("consume stopped: %v", err)
			return
		}
		log.Printf("consumed  partition=%d offset=%d  key=%-6s value=%q",
			m.Partition, m.Offset, m.Key, m.Value)
	}
	log.Printf("note: the two SKU-1 messages share a partition (same key) — ordered")
}
