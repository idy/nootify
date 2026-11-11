package updater

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const maxExpanded = 2 << 30
const maxArchiveEntries = 100000

type archiveLimits struct {
	bytes   int64
	entries int
}

var defaultArchiveLimits = archiveLimits{maxExpanded, maxArchiveEntries}

// Extraction happens in a new private sibling directory on the installation
// filesystem. Links are deferred until all files are written, so no tar member can
// traverse a link created by another member. Every link must resolve inside app.
func extractApp(ctx context.Context, archive, destination string, limits archiveLimits) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed := bufio.NewReader(file)
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return errors.New("invalid app archive")
	}
	defer gz.Close()
	gz.Multistream(false)
	// Count tar headers/padding as well as payloads to bound metadata/padding bombs.
	bounded := &io.LimitedReader{R: &contextReader{ctx: ctx, reader: gz}, N: limits.bytes + int64(limits.entries)*1024 + 1024}
	tr := tar.NewReader(bounded)
	seen := map[string]bool{}
	type link struct{ name, target string }
	var links []link
	var expanded int64
	count := 0
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		header, nextErr := tr.Next()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			return fmt.Errorf("read app archive: %w", nextErr)
		}
		count++
		if count > limits.entries {
			return errors.New("app archive has too many entries")
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" || strings.ContainsAny(name, "\\\x00:") || strings.HasPrefix(name, "/") || path.Clean(name) != name || (name != "Nootify.app" && !strings.HasPrefix(name, "Nootify.app/")) {
			return errors.New("unsafe app archive path")
		}
		folded := strings.ToLower(name)
		if seen[folded] {
			return errors.New("duplicate app archive path")
		}
		seen[folded] = true
		target := filepath.Join(destination, filepath.FromSlash(name))
		if header.Mode&07000 != 0 {
			return errors.New("privileged app archive permissions")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err = os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || header.Size > limits.bytes-expanded {
				return errors.New("app archive exceeds expanded size limit")
			}
			expanded += header.Size
			if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			mode := os.FileMode(0644)
			if header.Mode&0111 != 0 {
				mode = 0755
			}
			output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return err
			}
			_, copyErr := io.CopyN(output, tr, header.Size)
			if copyErr == nil {
				copyErr = output.Sync()
			}
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			if name == "Nootify.app" || header.Linkname == "" || strings.ContainsAny(header.Linkname, "\\\x00:") || path.IsAbs(header.Linkname) {
				return errors.New("unsafe app archive symlink")
			}
			resolved := path.Clean(path.Join(path.Dir(name), header.Linkname))
			if resolved != "Nootify.app" && !strings.HasPrefix(resolved, "Nootify.app/") {
				return errors.New("app archive symlink escapes bundle")
			}
			links = append(links, link{name, header.Linkname})
		default:
			return errors.New("unsupported app archive entry type")
		}
	}
	if bounded.N <= 0 {
		return errors.New("app archive exceeds stream limit")
	}
	// Consume the gzip trailer to verify CRC and reject nonzero hidden tar data.
	// LimitedReader prevents an all-zero tail from inflating without a bound.
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := bounded.Read(buffer)
		for _, b := range buffer[:n] {
			if b != 0 {
				return errors.New("unexpected data after app archive")
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return fmt.Errorf("finish app archive: %w", readErr)
		}
	}
	if bounded.N <= 0 {
		return errors.New("app archive exceeds stream limit")
	}
	// A second gzip member or trailing bytes must not hide another archive.
	if _, err = compressed.ReadByte(); err != io.EOF {
		return errors.New("unexpected trailing compressed app data")
	}
	for _, entry := range links {
		name := filepath.Join(destination, filepath.FromSlash(entry.name))
		if err = mkdirWithoutLinks(destination, filepath.Dir(name)); err != nil {
			return err
		}
		if err = os.Symlink(filepath.FromSlash(entry.target), name); err != nil {
			return errors.New("conflicting app archive symlink")
		}
	}
	root, err := filepath.EvalSymlinks(filepath.Join(destination, "Nootify.app"))
	if err != nil {
		return errors.New("app archive has no bundle directory")
	}
	for _, entry := range links {
		resolved, err := filepath.EvalSymlinks(filepath.Join(destination, filepath.FromSlash(entry.name)))
		if err != nil || !within(root, resolved) {
			return errors.New("unresolved or escaping app archive symlink")
		}
	}
	return validateBundle(root)
}

func mkdirWithoutLinks(root, directory string) error {
	rel, err := filepath.Rel(root, directory)
	if err != nil || !within(root, directory) {
		return errors.New("unsafe extraction directory")
	}
	current := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			if err = os.Mkdir(current, 0755); err != nil {
				return err
			}
			continue
		}
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("app archive traverses a symlink or file")
		}
	}
	return nil
}

func within(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func validateBundle(root string) error {
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return errors.New("cannot resolve app bundle directory")
	}
	root = canonical
	for _, name := range []string{"Contents/MacOS/Nootify", "Contents/Resources/licenses/third-party-notices.txt", "Contents/Info.plist"} {
		file := filepath.Join(root, filepath.FromSlash(name))
		info, err := os.Lstat(file)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return fmt.Errorf("app bundle is missing regular file %s", name)
		}
		resolved, err := filepath.EvalSymlinks(file)
		if err != nil || !within(root, resolved) {
			return errors.New("app bundle file escapes installation")
		}
		if strings.HasPrefix(name, "Contents/MacOS/") && info.Mode()&0111 == 0 {
			return errors.New("app bundle executable has no execute permission")
		}
	}
	file, err := os.Open(filepath.Join(root, "Contents", "Info.plist"))
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > 1<<20 {
		return errors.New("invalid app bundle metadata size")
	}
	decoder := xml.NewDecoder(io.LimitReader(file, 1<<20))
	values := map[string]string{}
	current := ""
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("invalid app bundle metadata")
		}
		if start, ok := token.(xml.StartElement); ok {
			if start.Name.Local == "key" {
				if err = decoder.DecodeElement(&current, &start); err != nil {
					return errors.New("invalid app bundle metadata")
				}
			}
			if start.Name.Local == "string" {
				var value string
				if err = decoder.DecodeElement(&value, &start); err != nil {
					return errors.New("invalid app bundle metadata")
				}
				values[current] = value
				current = ""
			}
		}
	}
	if values["CFBundleIdentifier"] != "dev.idy.nootify" || values["CFBundleExecutable"] != "Nootify" {
		return errors.New("app bundle identity does not match Nootify")
	}
	return nil
}
