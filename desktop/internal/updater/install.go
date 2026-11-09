package updater

import (
	"context"
	"debug/pe"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func appRoot(executable string) (string, error) {
	if !filepath.IsAbs(executable) {
		return "", errors.New("update executable must be an installed absolute path")
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", errors.New("cannot resolve installed executable")
	}
	root := filepath.Dir(filepath.Dir(filepath.Dir(resolved)))
	if filepath.Base(root) != "Nootify.app" || resolved != filepath.Join(root, "Contents", "MacOS", "Nootify") {
		return "", errors.New("updating requires an installed Nootify.app")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("invalid installed app directory")
	}
	return root, nil
}

func (m *Manager) installMac(ctx context.Context, archive string) error {
	root, err := appRoot(m.options.Executable)
	if err != nil {
		return err
	}
	original, err := os.Stat(root)
	if err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Dir(root), ".nootify-update-*")
	if err != nil {
		return fmt.Errorf("stage app beside installation: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(staging)
		}
	}()
	if err = extractApp(ctx, archive, staging, defaultArchiveLimits); err != nil {
		return err
	}
	replacement := filepath.Join(staging, "Nootify.app")
	current, err := os.Stat(root)
	if err != nil || !os.SameFile(original, current) {
		return errors.New("installed app changed while preparing update")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// Staging and validation precede service interruption, as does signature checking
	// in Manager.install. The host only stops the service belonging to this bundle.
	if m.options.BeforeInstall != nil {
		if err = m.options.BeforeInstall(ctx); err != nil {
			return fmt.Errorf("prepare update: %w", err)
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// The ownership-checked service stop can take minutes. Revalidate the directory
	// entry now, immediately before exchange, rather than trusting its earlier inode.
	current, err = os.Lstat(root)
	if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(original, current) {
		return errors.New("installed app changed while stopping background service")
	}
	// Darwin atomically exchanges both directory entries on the same filesystem.
	// The original app remains at replacement until successful lifecycle handoff.
	if err = m.swap(replacement, root); err != nil {
		return fmt.Errorf("replace installed app: %w", err)
	}
	rollback := func(cause error) error {
		if m.options.BeforeRollback != nil {
			if stopErr := m.options.BeforeRollback(); stopErr != nil {
				cleanup = false
				return fmt.Errorf("%w; rollback blocked because replacement could not be quiesced; original app retained at %s: %v", cause, replacement, stopErr)
			}
		}
		if restoreErr := m.swap(replacement, root); restoreErr != nil {
			cleanup = false // preserve the original bundle for recovery, never delete it
			return fmt.Errorf("%w; rollback failed, original app retained at %s: %v", cause, replacement, restoreErr)
		}
		return cause
	}
	if err = ctx.Err(); err != nil {
		return rollback(err)
	}
	m.publish("restarting", 0, nil, nil)
	if m.options.AfterInstall != nil {
		if err = m.options.AfterInstall(); err != nil {
			return rollback(fmt.Errorf("relaunch updated app: %w", err))
		}
	}
	if m.options.ConfirmGUI {
		installed, statErr := os.Lstat(root)
		if statErr != nil {
			return rollback(fmt.Errorf("inspect replacement before GUI handoff: %w", statErr))
		}
		stageInfo, statErr := os.Lstat(staging)
		if statErr != nil {
			return rollback(statErr)
		}
		targetVersion := ""
		m.mu.Lock()
		if m.pending != nil {
			targetVersion = m.pending.Version
		}
		m.mu.Unlock()
		m.guiPending = &macPending{root: root, replacement: replacement, staging: staging, original: original, installed: installed, stageInfo: stageInfo, version: targetVersion}
		cleanup = false
	}
	return nil
}

func validatePE(path string) error {
	file, err := pe.Open(path)
	if err != nil {
		return errors.New("verified artifact is not a Windows installer executable")
	}
	defer file.Close()
	// NSIS commonly uses a 32-bit loader even for an x64 application payload.
	if file.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 || file.Characteristics&pe.IMAGE_FILE_DLL != 0 {
		return errors.New("verified installer is not a Windows executable")
	}
	switch file.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		if file.Machine != pe.IMAGE_FILE_MACHINE_I386 {
			return errors.New("unsupported Windows installer architecture")
		}
	case *pe.OptionalHeader64:
		if file.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
			return errors.New("unsupported Windows installer architecture")
		}
	default:
		return errors.New("verified installer has invalid executable headers")
	}
	return nil
}
