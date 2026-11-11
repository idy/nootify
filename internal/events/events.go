package events

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/idy/nootify/internal/storage"
)

type Log struct {
	mu        sync.Mutex
	directory string
	entries   []map[string]any
	output    io.Writer
}

var bearer = regexp.MustCompile(`(?i)Bearer\s+[^\s"']+`)
var fields = []string{"status", "source", "session_id", "session_name", "chat_id", "message_id", "reply_id", "sender_open_id", "reason", "error", "preview"}

func Open(directory string, output io.Writer) (*Log, error) {
	l := &Log{directory: directory, entries: []map[string]any{}, output: output}
	for _, name := range []string{"events.ndjson", "stdout.log"} {
		file, err := os.Open(filepath.Join(directory, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			return nil, err
		}
		start := max(int64(0), info.Size()-1024*1024)
		_, err = file.Seek(start, io.SeekStart)
		if err != nil {
			file.Close()
			return nil, err
		}
		data, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			return nil, err
		}
		lines := bytes.Split(data, []byte{'\n'})
		if start > 0 && len(lines) > 0 {
			lines = lines[1:]
		}
		for _, line := range lines {
			var entry map[string]any
			if json.Unmarshal(line, &entry) == nil {
				if _, ok := entry["status"].(string); ok {
					l.entries = append(l.entries, sanitize(entry))
				}
			}
		}
		if len(l.entries) > 1000 {
			l.entries = l.entries[len(l.entries)-1000:]
		}
		break
	}
	return l, nil
}
func sanitize(record map[string]any) map[string]any {
	id, _ := record["id"].(string)
	if id == "" {
		raw := make([]byte, 16)
		_, _ = rand.Read(raw)
		id = hex.EncodeToString(raw)
	}
	at, _ := record["time"].(string)
	if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
		at = time.Now().UTC().Format(time.RFC3339Nano)
	}
	entry := map[string]any{"id": id, "time": at, "status": "event"}
	for _, key := range fields {
		value, ok := record[key].(string)
		if !ok {
			continue
		}
		limit := 700
		if key == "preview" {
			limit = 240
		}
		runes := []rune(value)
		if len(runes) > limit {
			runes = runes[:limit]
		}
		entry[key] = bearer.ReplaceAllString(string(runes), "Bearer [redacted]")
	}
	return entry
}
func (l *Log) Report(record map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := sanitize(record)
	l.entries = append(l.entries, entry)
	if len(l.entries) > 1000 {
		l.entries = l.entries[len(l.entries)-1000:]
	}
	var output bytes.Buffer
	for _, entry := range l.entries {
		_ = json.NewEncoder(&output).Encode(entry)
	}
	if err := storage.WritePrivate(filepath.Join(l.directory, "events.ndjson"), output.Bytes()); err != nil && l.output != nil {
		_, _ = io.WriteString(l.output, "nootify: unable to persist event log\n")
	}
	if l.output != nil {
		_ = json.NewEncoder(l.output).Encode(entry)
	}
}
func (l *Log) Recent() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	result := make([]map[string]any, 0, len(l.entries))
	for i := len(l.entries) - 1; i >= 0; i-- {
		clone := map[string]any{}
		for k, v := range l.entries[i] {
			clone[k] = v
		}
		result = append(result, clone)
	}
	return result
}
