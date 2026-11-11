package storage

import (
	"net/url"
	"path/filepath"
	"strings"
)

// SQLiteReadOnlyURL produces an authority-free file URI on every platform.
// A Windows drive must be a path segment (/C:/...), not the URI authority (C:).
// Keep query/fragment characters escaped so filenames cannot change read mode.
func SQLiteReadOnlyURL(file string) (*url.URL, error) {
	path := file
	drive := len(path) >= 3 && ((path[0] >= 'a' && path[0] <= 'z') || (path[0] >= 'A' && path[0] <= 'Z')) && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
	switch {
	case drive:
		path = "/" + strings.ReplaceAll(path, "\\", "/")
	case strings.HasPrefix(path, `\\`):
		path = strings.ReplaceAll(path, "\\", "/")
	default:
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		path = filepath.ToSlash(absolute)
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
	}
	u := &url.URL{Scheme: "file", Path: path}
	query := url.Values{"mode": {"ro"}}
	u.RawQuery = query.Encode()
	return u, nil
}
