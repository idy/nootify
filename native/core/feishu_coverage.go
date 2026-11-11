package core

import (
	"context"
	"time"
)

type historyReplayKey struct{}

func historyReplay(ctx context.Context) bool { v, _ := ctx.Value(historyReplayKey{}).(bool); return v }

type feishuCoverage struct {
	through int64
	cancel  context.CancelFunc
}

// Live input triggers bounded per-chat coverage, coalescing bursts into one
// finite interval. No recurring timer scans an idle synchronized connection.
func (p *feishuProvider) scheduleCoverage(b Binding, end int64) {
	p.mu.Lock()
	if !p.connected || p.ctx.Err() != nil {
		p.mu.Unlock()
		return
	}
	if p.coverage == nil {
		p.coverage = map[string]*feishuCoverage{}
	}
	if existing := p.coverage[b.ChatID]; existing != nil {
		existing.through = max(existing.through, end)
		p.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(p.ctx)
	entry := &feishuCoverage{through: end, cancel: cancel}
	p.coverage[b.ChatID] = entry
	p.historyWG.Add(1)
	p.mu.Unlock()
	go func() {
		defer p.historyWG.Done()
		defer cancel()
		defer func() {
			p.mu.Lock()
			if p.coverage[b.ChatID] == entry {
				delete(p.coverage, b.ChatID)
			}
			p.mu.Unlock()
		}()
		for {
			if waitForReconnect(ctx, 100*time.Millisecond) != nil {
				return
			}
			p.mu.Lock()
			if p.recovering {
				p.mu.Unlock()
				continue
			}
			through := entry.through
			p.mu.Unlock()
			backoff := 250 * time.Millisecond
			for {
				attempt, stop := context.WithTimeout(ctx, 45*time.Second)
				err := p.reconcileResources(attempt, through, []Binding{b})
				stop()
				if ctx.Err() != nil {
					return
				}
				if err == nil {
					break
				}
				p.core.log("feishu_history_reconciliation_failed", p.config.ID, "")
				if waitForReconnect(ctx, backoff) != nil {
					return
				}
				backoff = min(backoff*2, 30*time.Second)
			}
			p.mu.Lock()
			if entry.through <= through {
				delete(p.coverage, b.ChatID)
				p.mu.Unlock()
				return
			}
			p.mu.Unlock()
		}
	}()
}
