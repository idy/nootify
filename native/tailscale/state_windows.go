package main

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Keep one stable lock file, as on Unix. All opens refuse reparse points and
// share no delete access, so validation/ACL repair acts on pinned objects.
func prepareStateDir(path string) (*os.File, error) {
	if !validStateDir(path) {
		return nil, errors.New("invalid_state_dir")
	}
	path = filepath.Clean(path)
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	// New tsnet files inherit access only for this user and SYSTEM. POSIX file
	// modes do not protect credentials on Windows.
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;SY)")
	if err != nil {
		return nil, err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(name, &attributes); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, err
	}
	// MAXIMUM_ALLOWED prevents SetSecurityInfo from propagating inheritable
	// ACEs to existing children before they have been checked for links.
	// https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
	handle, err := windows.CreateFile(name, windows.MAXIMUM_ALLOWED,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	root := os.NewFile(uintptr(handle), path)
	defer root.Close()
	if err := privateWindowsStateFile(root, true, user.User.Sid, dacl); err != nil {
		return nil, err
	}
	lock, err := openWindowsStateChild(root, stateLockName, false, true)
	if err != nil {
		return nil, err
	}
	locked := false
	defer func() {
		if !locked {
			lock.Close()
		}
	}()
	if err := privateWindowsStateFile(lock, false, user.User.Sid, dacl); err != nil {
		return nil, err
	}
	var overlap windows.Overlapped
	if err := windows.LockFileEx(windows.Handle(lock.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlap); err != nil {
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, errStateLocked
		}
		return nil, err
	}
	if err := privateWindowsStateTree(root, user.User.Sid, dacl); err != nil {
		return nil, err
	}
	locked = true
	return lock, nil
}

// NtCreateFile resolves one filename relative to an already-open directory.
// No ancestor can be swapped to redirect credential permission repair.
func openWindowsStateChild(dir *os.File, name string, directory, create bool) (*os.File, error) {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
		return nil, errors.New("unsafe_state_file")
	}
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return nil, err
	}
	attributes := windows.OBJECT_ATTRIBUTES{
		Length: uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})), RootDirectory: windows.Handle(dir.Fd()),
		ObjectName: objectName, Attributes: windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	access := uint32(windows.GENERIC_READ | windows.READ_CONTROL | windows.WRITE_DAC | windows.SYNCHRONIZE)
	disposition := uint32(windows.FILE_OPEN)
	options := uint32(windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if directory {
		// Suppress automatic ACL propagation here too; validate each child first.
		access = windows.MAXIMUM_ALLOWED | windows.SYNCHRONIZE
		options |= windows.FILE_DIRECTORY_FILE
	} else {
		options |= windows.FILE_NON_DIRECTORY_FILE
	}
	if create {
		access |= windows.GENERIC_WRITE
		disposition = windows.FILE_OPEN_IF
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	if err := windows.NtCreateFile(&handle, access, &attributes, &status, nil, windows.FILE_ATTRIBUTE_NORMAL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, disposition, options, 0, 0); err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), filepath.Join(dir.Name(), name)), nil
}

func privateWindowsStateFile(file *os.File, directory bool, user *windows.SID, dacl *windows.ACL) error {
	handle := windows.Handle(file.Fd())
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		(info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
		return errors.New("unsafe_state_file")
	}
	if !directory && info.NumberOfLinks != 1 {
		return errors.New("unsafe_state_link")
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	// Elevated Windows processes can create files owned by Administrators.
	// Administrators already have take-ownership privilege; still replace the
	// DACL with access for only this user and SYSTEM before reading credentials.
	if owner == nil || (!owner.Equals(user) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid)) {
		return errors.New("unsafe_state_owner")
	}
	return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func privateWindowsStateTree(dir *os.File, user *windows.SID, dacl *windows.ACL) error {
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && !entry.Type().IsRegular() {
			return errors.New("unsafe_state_file")
		}
		file, err := openWindowsStateChild(dir, entry.Name(), entry.IsDir(), false)
		if err != nil {
			return err
		}
		err = privateWindowsStateFile(file, entry.IsDir(), user, dacl)
		if err == nil && entry.IsDir() {
			err = privateWindowsStateTree(file, user, dacl)
		}
		file.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
