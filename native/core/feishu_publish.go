package core

import (
	"context"
	"time"
)

// Only publication starts this finite recovery. Input can arrive between the
// invitation and the create response, before live ingress has a binding.
func (p *feishuProvider) PublishedBinding(b Binding) {
	if b.HistoryStart == 0 {
		return
	}
	p.mu.Lock()
	if !p.connected || p.ctx.Err() != nil {
		p.mu.Unlock()
		return
	}
	p.historyWG.Add(1)
	end := time.Now().UnixMilli()
	p.mu.Unlock()
	go func() {
		defer p.historyWG.Done()
		backoff := 250 * time.Millisecond
		for {
			ctx, cancel := context.WithTimeout(p.ctx, 45*time.Second)
			err := p.reconcileResources(ctx, end, []Binding{b})
			cancel()
			if err == nil || p.ctx.Err() != nil {
				return
			}
			p.core.log("feishu_history_reconciliation_failed", p.config.ID, "")
			if waitForReconnect(p.ctx, backoff) != nil {
				return
			}
			backoff = min(backoff*2, 30*time.Second)
		}
	}()
}
