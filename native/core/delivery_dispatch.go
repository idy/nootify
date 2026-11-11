package core

import (
	"context"
	"errors"
)

// The caller holds the session gate. Retryable is the durable proof that no
// adapter submission has started; pending is armed only by a confirmed barrier.
func (c *Core) dispatchDelivery(ctx context.Context, id string) error {
	if err := c.store.FlushUndispatched(); err != nil {
		return err
	}
	d := c.store.Snapshot()
	v, ok := d.Deliveries[id]
	if !ok {
		return fault("not_found", "delivery does not exist")
	}
	record, ok := d.Events[v.EventID]
	if !ok {
		return fault("not_found", "source event is missing")
	}
	if record.Outcome == "deleted" {
		return fault("deleted", "notification session was deleted")
	}
	if v.Status != "retryable" {
		return fault("conflict", "only a proven retryable delivery may be retried")
	}
	e := record.Event
	if err := ctx.Err(); err != nil {
		return err
	}
	// Relays cannot authorize old input using a cached binding while the source
	// is offline. Resolve the original resource status before any local dispatch.
	if e.ChatID != "" && e.Message.OriginNodeID != d.NodeID {
		active, err := c.EventActive(ctx, e)
		if err != nil {
			return err
		}
		if !active {
			return c.store.Update(func(d *State) error { cancelEvent(d, e.ID); return nil })
		}
	}
	err := c.store.Update(func(d *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		v := d.Deliveries[id]
		if v.Status != "retryable" {
			return fault("conflict", "delivery changed before dispatch")
		}
		record := d.Events[v.EventID]
		if record.Outcome == "deleted" || retiredResource(d, record.Event) {
			return fault("deleted", "notification session was deleted")
		}
		if b, ok := d.Bindings[e.Session.key()]; ok && b.Deleted {
			return fault("deleted", "notification session was deleted")
		}
		v.Status, v.Transport, v.Error = "pending", "", ""
		d.Deliveries[id] = v
		return nil
	})
	if err != nil {
		if stateCommitted(err) {
			return errors.Join(err, c.repairDelivery(id))
		}
		return err
	}
	if err := ctx.Err(); err != nil {
		return errors.Join(err, c.repairDelivery(id))
	}
	if c.emit == nil {
		return c.Complete(id, "unconfirmed", "", "")
	}
	if err := c.emit("delivery", map[string]any{"delivery_id": id, "session": e.Session, "message": e.Message, "content": e.Content, "text": e.Content.Plain(), "sender_id": e.SenderID, "chat_id": e.ChatID}); err != nil {
		_ = c.Complete(id, "unconfirmed", "", "")
		return err
	}
	return nil
}

func (c *Core) repairDelivery(id string) error {
	return c.store.RepairUndispatched("delivery:"+id, func(d *State) error {
		v, ok := d.Deliveries[id]
		if !ok || v.Status != "pending" {
			return nil
		}
		v.Status, v.Transport, v.Error = "retryable", "not_submitted", ""
		d.Deliveries[id] = v
		if record := d.Events[v.EventID]; record.Outcome == "deleted" {
			cancelEvent(d, v.EventID)
		}
		return nil
	})
}
