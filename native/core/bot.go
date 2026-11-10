package main

import "context"

func (p *feishuProvider) GetMetadata(ctx context.Context, b Binding) (map[string]any, error) {
	return p.Metadata(ctx, b, nil, false)
}
func (p *feishuProvider) SetMetadata(ctx context.Context, b Binding, m map[string]any) (map[string]any, error) {
	return p.Metadata(ctx, b, m, true)
}
func (p *remoteProvider) GetMetadata(ctx context.Context, b Binding) (map[string]any, error) {
	return p.Metadata(ctx, b, nil, false)
}
func (p *remoteProvider) SetMetadata(ctx context.Context, b Binding, m map[string]any) (map[string]any, error) {
	return p.Metadata(ctx, b, m, true)
}

var _ Bot = (*feishuProvider)(nil)
var _ Bot = (*remoteProvider)(nil)
