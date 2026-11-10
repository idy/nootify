package updater

import (
	"golang.org/x/sys/windows"
	"strings"
)

// ShellExecute honors an installer's elevation manifest (including UAC when
// required) without a shell, a batch file, or a lingering desktop child handle.
func launchInstaller(path string, args []string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	escaped := make([]string, len(args))
	for i, arg := range args {
		escaped[i] = windows.EscapeArg(arg)
	}
	parameters, err := windows.UTF16PtrFromString(strings.Join(escaped, " "))
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, file, parameters, nil, windows.SW_SHOWNORMAL)
}
