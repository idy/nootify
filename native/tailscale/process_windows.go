package main

import "os"

// Go's Windows pipe implementation cancels pending reads on Close. The parent
// owns this redirected handle; EOF shuts down the helper when the task exits.
func openProcessStdin() (*os.File, error) { return os.Stdin, nil }

// Windows file privacy is enforced with a protected inheritable DACL in
// prepareStateDir; POSIX umask and SIGPIPE do not apply.
func prepareProcess() {}
