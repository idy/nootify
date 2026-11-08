package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
)

type feishuAPIError struct{ Code, HTTPStatus int }

func (*feishuAPIError) Error() string { return "Feishu rejected the request" }

// Feishu's newer groups expose Docx announcements. Both representations are
// read for adoption, but neither is rewritten or replaced by the core.
func (p *feishuProvider) readAnnouncement(ctx context.Context, chat string) (json.RawMessage, error) {
	var raw json.RawMessage
	err := p.api(ctx, "GET", "/open-apis/im/v1/chats/"+url.PathEscape(chat)+"/announcement", nil, &raw)
	if err == nil {
		return raw, nil
	}
	var apiErr *feishuAPIError
	if !errors.As(err, &apiErr) || apiErr.Code != 232097 {
		return nil, err
	}
	path := "/open-apis/docx/v1/chats/" + url.PathEscape(chat) + "/announcement"
	var metadata struct {
		Revision int `json:"revision_id"`
	}
	if err = p.api(ctx, "GET", path, nil, &metadata); err != nil {
		return nil, err
	}
	blocks := []json.RawMessage{}
	seen := map[string]bool{}
	pageToken := ""
	total := 0
	for pages := 0; pages < 100; pages++ {
		query := url.Values{"page_size": []string{"500"}, "revision_id": []string{strconv.Itoa(metadata.Revision)}}
		if pageToken != "" {
			query.Set("page_token", pageToken)
		}
		var page struct {
			Items     []json.RawMessage `json:"items"`
			HasMore   bool              `json:"has_more"`
			PageToken string            `json:"page_token"`
		}
		if err = p.api(ctx, "GET", path+"/blocks?"+query.Encode(), nil, &page); err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			total += len(item)
		}
		if total > maxPayload {
			return nil, fault("resource_exhausted", "announcement exceeds size limit")
		}
		blocks = append(blocks, page.Items...)
		if !page.HasMore {
			return json.Marshal(blocks)
		}
		if page.PageToken == "" || seen[page.PageToken] {
			return nil, fault("unavailable", "invalid announcement pagination")
		}
		seen[page.PageToken] = true
		pageToken = page.PageToken
	}
	return nil, fault("resource_exhausted", "announcement exceeds page limit")
}
