package core

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// POSIX mode bits do not secure Windows credentials. Pin the object without
// following reparse points, verify its owner/links, then install a protected
// DACL granting only the current user and SYSTEM access. Directory ACEs are
// inherited by the lock, state snapshots and temporary replacements.
func privateStatePath(path string, directory bool) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;SY)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	if directory {
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	handle, err := windows.CreateFile(name, windows.MAXIMUM_ALLOWED, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory || (!directory && info.NumberOfLinks != 1) {
		return fmt.Errorf("unsafe state object")
	}
	ownerInfo, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := ownerInfo.Owner()
	if err != nil {
		return err
	}
	if owner == nil || (!owner.Equals(user.User.Sid) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid)) {
		return fmt.Errorf("unsafe state owner")
	}
	return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
func replaceStateFile(from, to string) error {
	source, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return retryStateReplacement(func() error {
		return windows.MoveFileEx(source, target, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
	})
}

// MoveFileEx cannot replace an open destination, even when its reader allows
// FILE_SHARE_DELETE. A brief state reader (or scanner) must not strand a delivery
// completion after the adapter has already accepted it. Retry only the atomic
// replacement, keeping the synced temporary file and running the mutation once.
func retryStateReplacement(replace func() error) error {
	deadline := time.Now().Add(time.Second)
	for delay := time.Millisecond; ; {
		err := replace()
		if err == nil || (!errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION)) || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(delay)
		if delay < 16*time.Millisecond {
			delay *= 2
		}
	}
}
