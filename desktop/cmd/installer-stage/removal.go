package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// remove is called only after the owned CLI has successfully uninstalled its
// task and drained its service job. Keep uninstall.exe and registration at their
// original paths until every other payload root is removed. A locked independent
// UI gateway is allowed to outlive that job; its payload lock must remain a
// retryable removal failure, never a reason to kill an unrelated process.
func (t transaction) remove() (result error) {
	t.diagnostics.begin("remove", "")
	defer func() { t.diagnostics.end("remove", "", result) }()
	if exists(t.dir()) {
		if err := t.recover(); err != nil {
			return err
		}
	}
	if !exists(t.dir()) {
		if err := t.prepare(); err != nil {
			return err
		}
		j := journal{Version: 1, Target: t.target, Phase: "quarantining"}
		for _, root := range payloadRoots {
			if root == "uninstall.exe" {
				continue
			}
			if exists(filepath.Join(t.target, root)) {
				if err := regularTree(filepath.Join(t.target, root)); err != nil {
					return err
				}
				j.Previous = append(j.Previous, root)
			}
		}
		if err := t.write(j); err != nil {
			return err
		}
	}
	j, err := t.read()
	if err != nil {
		return err
	}
	if j.Phase != "removing" && j.Phase != "quarantining" || j.FreshToken != "" || contains(j.Previous, "uninstall.exe") {
		return errors.New("invalid uninstall removal journal")
	}
	// First move every root out of the installed layout. No irreversible deletion
	// occurs until quarantine succeeds in full. On a sharing error reverse every
	// successful move; both the uninstaller and normal management CLI survive.
	for _, root := range j.Previous {
		installed := filepath.Join(t.target, root)
		if !exists(installed) {
			continue
		}
		if exists(t.dir("old", root)) {
			return errors.New("uninstall root exists in both installed and quarantine locations")
		}
		err := t.observe("backup", root, func() error {
			if err := regularTree(installed); err != nil {
				return err
			}
			if err := t.check("remove-backup:" + root); err != nil {
				return err
			}
			return renamePayload(installed, t.dir("old", root))
		})
		if err != nil {
			for _, restore := range j.Previous {
				if exists(t.dir("old", restore)) && !exists(filepath.Join(t.target, restore)) {
					if rollback := renamePayload(t.dir("old", restore), filepath.Join(t.target, restore)); rollback != nil {
						return fmt.Errorf("%w; uninstall quarantine rollback needs retry", err)
					}
				}
			}
			if cleanup := t.cleanup(); cleanup != nil {
				return fmt.Errorf("%w; uninstall journal cleanup needs retry", err)
			}
			return err
		}
		if err := t.check("remove-backed-up:" + root); err != nil {
			return err
		}
	}
	j.Phase = "removing"
	if err := t.write(j); err != nil {
		return err
	}
	for _, root := range j.Previous {
		if err := t.observe("remove", root, func() error {
			if err := t.check("remove-delete:" + root); err != nil {
				return err
			}
			if exists(t.dir("old", root)) {
				if err := regularTree(t.dir("old", root)); err != nil {
					return err
				}
				if err := os.RemoveAll(t.dir("old", root)); err != nil {
					return err
				}
			}
			return t.check("remove-deleted:" + root)
		}); err != nil {
			return err
		}
	}
	return t.cleanup()
}

func (t transaction) restoreQuarantine(j journal) error {
	for _, root := range j.Previous {
		if !exists(t.dir("old", root)) {
			continue
		}
		if exists(filepath.Join(t.target, root)) {
			return errors.New("uninstall quarantine root has an unexpected installed replacement")
		}
		if err := regularTree(t.dir("old", root)); err != nil {
			return err
		}
		if err := t.observe("restore", root, func() error { return renamePayload(t.dir("old", root), filepath.Join(t.target, root)) }); err != nil {
			return err
		}
	}
	return t.cleanup()
}
