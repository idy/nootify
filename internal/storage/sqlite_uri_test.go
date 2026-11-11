package storage

import (
	"database/sql"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func TestSQLiteReadOnlyURLKeepsDriveAndReservedCharactersInPath(t *testing.T) {
	for _, test := range []struct{ input, path string }{
		{`C:\Users\Runner\state #100%?.sqlite`, `/C:/Users/Runner/state #100%?.sqlite`},
		{`D:/folder with spaces/数据库.sqlite`, `/D:/folder with spaces/数据库.sqlite`},
		{`\\server\share\state.sqlite`, `//server/share/state.sqlite`},
	} {
		t.Run(test.input, func(t *testing.T) {
			u, err := SQLiteReadOnlyURL(test.input)
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := url.Parse(u.String())
			if err != nil {
				t.Fatal(err)
			}
			if parsed.Host != "" || parsed.Opaque != "" || parsed.Path != test.path || parsed.Fragment != "" || parsed.Query().Get("mode") != "ro" {
				t.Fatalf("bad SQLite filename URI: %+v", parsed)
			}
			if !strings.HasPrefix(u.String(), "file:///") {
				t.Fatal("drive became a URI authority", u.String())
			}
		})
	}
}
func TestSQLiteURIIsReadableButCannotMutateOrCreateMetadata(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state #100%.sqlite")
	writable, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writable.Exec("CREATE TABLE metadata(value TEXT); INSERT INTO metadata(value) VALUES('original')"); err != nil {
		t.Fatal(err)
	}
	if err = writable.Close(); err != nil {
		t.Fatal(err)
	}
	u, err := SQLiteReadOnlyURL(file)
	if err != nil {
		t.Fatal(err)
	}
	readonly, err := sql.Open("sqlite", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer readonly.Close()
	var value string
	if err = readonly.QueryRow("SELECT value FROM metadata").Scan(&value); err != nil || value != "original" {
		t.Fatalf("could not read URI filename: %q %v", value, err)
	}
	if _, err = readonly.Exec("UPDATE metadata SET value='changed'"); err == nil {
		t.Fatal("metadata connection lost read-only mode")
	}
	if err = readonly.QueryRow("SELECT value FROM metadata").Scan(&value); err != nil || value != "original" {
		t.Fatal("read-only mutation changed metadata", value, err)
	}
	missingURL, err := SQLiteReadOnlyURL(filepath.Join(t.TempDir(), "missing.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	missing, err := sql.Open("sqlite", missingURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Close()
	if err = missing.Ping(); err == nil {
		t.Fatal("read-only URI silently created missing metadata")
	}
}
