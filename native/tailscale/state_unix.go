//go:build !windows

package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// The stable lock file is never unlinked: tailscaled.state is atomically
// replaced by tsnet, so locking that inode would not exclude another process.
// The caller must keep the returned descriptor open until tsnet.Close returns.
func prepareStateDir(path string) (*os.File, error) {
	if !validStateDir(path) {
		return nil, errors.New("invalid_state_dir")
	}
	path = filepath.Clean(path)
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	root := os.NewFile(uintptr(fd), path)
	defer root.Close()
	if err := privateStateFile(root, true); err != nil {
		return nil, err
	}

	fd, err = unix.Openat(int(root.Fd()), stateLockName, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	lock := os.NewFile(uintptr(fd), filepath.Join(path, stateLockName))
	locked := false
	defer func() {
		if !locked {
			lock.Close()
		}
	}()
	// Validate before chmod or flock; in particular, never change a linked file.
	if err := privateStateFile(lock, false); err != nil {
		return nil, err
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil, errStateLocked
		}
		return nil, err
	}
	if err := privateStateTree(root); err != nil {
		return nil, err
	}
	locked = true
	return lock, nil
}

// Open children relative to a pinned directory, without following symlinks.
// Chmod uses that same descriptor, so replacing a pathname cannot redirect a
// permission repair to another daemon's credentials or an unrelated file.
func privateStateTree(dir *os.File) error {
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && !entry.Type().IsRegular() {
			return errors.New("unsafe_state_file")
		}
		fd, err := unix.Openat(int(dir.Fd()), entry.Name(), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), entry.Name())
		err = privateStateFile(file, entry.IsDir())
		if err == nil && entry.IsDir() {
			err = privateStateTree(file)
		}
		file.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func privateStateFile(file *os.File, directory bool) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return errors.New("unsafe_state_file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("unsafe_state_owner")
	}
	if info.Mode().IsRegular() && stat.Nlink != 1 {
		return errors.New("unsafe_state_link")
	}
	mode := fs.FileMode(0600)
	if info.IsDir() {
		mode = 0700
	}
	return file.Chmod(mode)
}
