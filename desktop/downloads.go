package main

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/egoist/mygo"
)

var logExportName = regexp.MustCompile(`^nootify-logs-\d{4}-\d{2}-\d{2}\.ndjson$`)
var blobObjectPath = regexp.MustCompile(`^/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

// Let MyGo save the UI's log export in Downloads, with its normal unique-name
// handling. Other downloads stay blocked, including blobs from another origin.
func (p urlPolicy) download(document string, event *mygo.DownloadEvent) {
	if p.allowed(document) && logExportName.MatchString(event.SuggestedName) && strings.HasPrefix(event.URL, "blob:") {
		page, _ := url.Parse(document)
		blob, err := url.Parse(strings.TrimPrefix(event.URL, "blob:"))
		if err == nil && blob.User == nil && blob.Scheme == page.Scheme && blob.Host == page.Host &&
			blob.RawQuery == "" && !blob.ForceQuery && blob.Fragment == "" && !strings.Contains(event.URL, "#") &&
			blobObjectPath.MatchString(blob.EscapedPath()) {
			return
		}
	}
	event.PreventDefault()
}
