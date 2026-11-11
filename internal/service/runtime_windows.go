//go:build windows

package service

import (
	"context"
	"crypto/rand"
	"debug/buildinfo"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

//go:embed task_windows.ps1
var taskScript string
var kernel = windows.NewLazySystemDLL("kernel32.dll")
var openJob = kernel.NewProc("OpenJobObjectW")
var wts = windows.NewLazySystemDLL("wtsapi32.dll")
var wtsQuery = wts.NewProc("WTSQuerySessionInformationW")
var wtsFree = wts.NewProc("WTSFreeMemory")

type taskState struct {
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	Enabled   bool   `json:"enabled"`
	Task      string `json:"task"`
	Record    *struct {
		MCP     string `json:"mcp"`
		Version int    `json:"version"`
	} `json:"record"`
}

func powershellLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
func taskCommand(ctx context.Context, action string, options Options) (taskState, error) {
	// This source is embedded and passed as a literal script block. No checkout,
	// installed script, modules, profile, or current-directory code is loaded.
	script := "& {\n" + taskScript + "\n} -Action " + powershellLiteral(action) + " -Executable " + powershellLiteral(options.Executable) + " -StateDir " + powershellLiteral(options.StateDir) + fmt.Sprintf(" -Port %d", options.Port)
	if options.MCPConfig != "" {
		script += " -McpConfig " + powershellLiteral(options.MCPConfig)
	}
	encoded, err := powerShellCommand(script)
	if err != nil {
		return taskState{}, err
	}
	systemDirectory, err := windows.GetSystemDirectory()
	if err != nil {
		return taskState{}, err
	}
	windowsDirectory, err := windows.GetWindowsDirectory()
	if err != nil {
		return taskState{}, err
	}
	home, _ := os.UserHomeDir()
	environment := cleanEnvironment("windows", home, os.Environ())
	for i := len(environment) - 1; i >= 0; i-- {
		key, _, _ := strings.Cut(environment[i], "=")
		if strings.EqualFold(key, "SystemRoot") {
			environment = append(environment[:i], environment[i+1:]...)
		}
	}
	environment = append(environment, "SystemRoot="+windowsDirectory)
	out := Run(ctx, Command{Path: filepath.Join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"), Args: []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded}, Dir: systemDirectory, Env: environment, Timeout: 20 * time.Second})
	if out.Err != nil {
		return taskState{}, commandError(out)
	}
	var result taskState
	if json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(out.Stdout), "\uFEFF")), &result) != nil {
		return result, errors.New("invalid Windows service management response")
	}
	return result, nil
}
func ownerSID() (string, error) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}
func mutex(ctx context.Context, name string, timeout time.Duration) (func(), error) {
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;OW)(A;;GA;;;SY)")
	if err != nil {
		return nil, err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateMutex(&attributes, false, pointer)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		status, e := windows.WaitForSingleObject(handle, 0)
		if e != nil {
			windows.CloseHandle(handle)
			return nil, e
		}
		if status == windows.WAIT_OBJECT_0 || status == windows.WAIT_ABANDONED {
			return func() { _ = windows.ReleaseMutex(handle); _ = windows.CloseHandle(handle) }, nil
		}
		if status != uint32(windows.WAIT_TIMEOUT) || !time.Now().Before(deadline) {
			windows.CloseHandle(handle)
			return nil, errors.New("another Nootify service operation is in progress")
		}
		if e = waitContext(ctx, 50*time.Millisecond); e != nil {
			windows.CloseHandle(handle)
			return nil, e
		}
	}
}

type jobRuntime struct {
	Script     string  `json:"script,omitempty"`
	Version    int     `json:"version"`
	SID        string  `json:"sid"`
	Executable string  `json:"executable"`
	State      string  `json:"state"`
	Job        string  `json:"job"`
	Boot       *uint32 `json:"boot,omitempty"`
	Session    *uint32 `json:"terminal_session,omitempty"`
	PID        uint32  `json:"pid"`
	Started    uint64  `json:"started"`
}

func runtimePath(options Options) string {
	return filepath.Join(options.StateDir, "windows-runtime.json")
}
func completionPath(options Options, record jobRuntime) string {
	return filepath.Join(options.StateDir, "windows-job-"+record.Job[strings.LastIndex(record.Job, ".")+1:]+".complete")
}
func bootSequence() *uint32 {
	data := make([]byte, 0x2c8)
	var read uintptr
	if windows.ReadProcessMemory(windows.CurrentProcess(), 0x7ffe0000, &data[0], uintptr(len(data)), &read) != nil || read != uintptr(len(data)) {
		return nil
	}
	architecture := binary.LittleEndian.Uint16(data[0x26a:])
	if architecture != 0 && architecture != 9 && architecture != 12 {
		return nil
	}
	if binary.LittleEndian.Uint32(data[0x26c:]) != 10 || binary.LittleEndian.Uint32(data[0x270:]) != 0 || binary.LittleEndian.Uint32(data[0x260:]) < 10240 {
		return nil
	}
	value := binary.LittleEndian.Uint32(data[0x2c4:])
	return &value
}
func terminalSessionEnded(session uint32) bool {
	if session == 0 {
		return false
	}
	var data uintptr
	var size uint32
	found, _, failure := wtsQuery.Call(0, uintptr(session), 8, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&size)))
	if data != 0 {
		wtsFree.Call(data)
	}
	return found == 0 && errors.Is(failure, syscall.Errno(7022))
}
func processStarted(handle windows.Handle) (uint64, error) {
	var created, exited, kernelTime, user windows.Filetime
	err := windows.GetProcessTimes(handle, &created, &exited, &kernelTime, &user)
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), err
}
func rootExited(record jobRuntime) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, record.PID)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return true
	}
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	started, err := processStarted(handle)
	if err != nil {
		return false
	}
	if started != record.Started {
		return true
	}
	status, err := windows.WaitForSingleObject(handle, 0)
	return err == nil && status == windows.WAIT_OBJECT_0
}
func processAbsent(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err == nil {
		windows.CloseHandle(h)
	}
	return errors.Is(err, windows.ERROR_INVALID_PARAMETER)
}

type jobAccounting struct {
	User, Kernel, PeriodUser, PeriodKernel int64
	Faults, Total, Active, Terminated      uint32
}

func activeProcesses(job windows.Handle) (uint32, error) {
	var accounting jobAccounting
	err := windows.QueryInformationJobObject(job, 1, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
	return accounting.Active, err
}
func privateJob(options Options, sid string, active bool) (windows.Handle, *jobRuntime, error) {
	data, err := os.ReadFile(runtimePath(options))
	if errors.Is(err, os.ErrNotExist) && !active {
		return 0, nil, nil
	}
	if err != nil {
		return 0, nil, errors.New("cannot verify the active Nootify task job runtime record")
	}
	var record jobRuntime
	prefix := "Global\\Nootify.Service.Job." + sid + "."
	if len(data) > 4096 || json.Unmarshal(data, &record) != nil {
		return 0, nil, errors.New("cannot verify the Nootify job runtime record")
	}
	legacy := record.Version >= 2 && record.Version <= 4
	own := record.Version == 5 && strings.EqualFold(record.Executable, options.Executable) && strings.EqualFold(record.State, options.StateDir) && record.PID > 0 && record.Started > 0
	if legacy {
		own = strings.EqualFold(record.Script, filepath.Join(filepath.Dir(options.Executable), "service", "windows", "service.ps1"))
	}
	if !own || record.SID != sid || !strings.HasPrefix(record.Job, prefix) || len(record.Job) != len(prefix)+32 {
		return 0, nil, errors.New("cannot verify the Nootify job runtime record")
	}

	if _, err = hex.DecodeString(strings.TrimPrefix(record.Job, prefix)); err != nil {
		return 0, nil, errors.New("invalid Nootify job identity")
	}
	name, _ := windows.UTF16PtrFromString(record.Job)
	handle, _, failure := openJob.Call(0x2000c, 0, uintptr(unsafe.Pointer(name)))
	if handle != 0 {
		h := windows.Handle(handle)
		sd, e := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if e != nil {
			windows.CloseHandle(h)
			return 0, nil, e
		}
		owner, _, e := sd.Owner()
		if e != nil || owner.String() != sid {
			windows.CloseHandle(h)
			return 0, nil, errors.New("refusing a service job owned by another user")
		}
		return h, &record, nil
	}
	if !errors.Is(failure, windows.ERROR_FILE_NOT_FOUND) {
		return 0, nil, failure
	}
	if current := bootSequence(); record.Boot != nil && current != nil && *current != *record.Boot {
		return 0, &record, nil
	}
	if record.Session != nil && terminalSessionEnded(*record.Session) {
		return 0, &record, nil
	}
	receipt, e := os.ReadFile(completionPath(options, record))
	if e == nil && string(receipt) == record.Job && (legacy || rootExited(record)) {
		return 0, &record, nil
	}
	return 0, nil, errors.New("cannot verify Nootify shutdown: the missing job has no completed drain, deleted terminal session or changed kernel boot sequence; private state was retained")
}
func removeRuntime(options Options, record *jobRuntime) error {
	if record == nil {
		return nil
	}
	if err := os.Remove(runtimePath(options)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(completionPath(options, *record))
	return nil
}
func terminateAndWait(ctx context.Context, handle windows.Handle) error {
	if err := windows.TerminateJobObject(handle, 1); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		count, err := activeProcesses(handle)
		if err != nil {
			return err
		}
		if count == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("timed out draining the Nootify service job")
		}
		if err = waitContext(ctx, 50*time.Millisecond); err != nil {
			return err
		}
	}
}
func stopTask(ctx context.Context, options Options, sid string) error {
	if _, err := taskCommand(ctx, "Disable", options); err != nil {
		return err
	}
	unlock, err := mutex(ctx, "Global\\Nootify.Service.Creation."+sid, 30*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	snapshot, err := taskCommand(ctx, "Status", options)
	if err != nil {
		return err
	}
	handle, record, err := privateJob(options, sid, snapshot.Running)
	if err != nil {
		return err
	}
	if handle != 0 {
		defer windows.CloseHandle(handle)
	}
	if _, err = taskCommand(ctx, "Stop", options); err != nil {
		return err
	}
	if handle != 0 {
		if err = terminateAndWait(ctx, handle); err != nil {
			return err
		}
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		state, e := taskCommand(ctx, "Status", options)
		if e != nil {
			return e
		}
		if !state.Running {
			break
		}
		if time.Now().After(deadline) {
			return errors.New("timed out waiting for the Nootify task to stop")
		}
		if e = waitContext(ctx, 100*time.Millisecond); e != nil {
			return e
		}
	}
	return removeRuntime(options, record)
}
func startTask(ctx context.Context, options Options) error {
	if _, err := taskCommand(ctx, "Start", options); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := CheckHealth(ctx, HealthClient(), fmt.Sprintf("http://127.0.0.1:%d/", options.Port)); err == nil {
			state, e := taskCommand(ctx, "Status", options)
			if e == nil && state.Running {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return errors.New("Nootify task started but health is not ready; inspect stderr.log")
		}
		if err := waitContext(ctx, 150*time.Millisecond); err != nil {
			return err
		}
	}
}
func manageWindows(ctx context.Context, action string, options Options) (any, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	sid, err := ownerSID()
	if err != nil {
		return nil, err
	}
	if action == "install" || action == "start" || action == "restart" {
		metadata, e := buildinfo.ReadFile(options.Executable)
		if e != nil || metadata.Main.Path != "github.com/idy/nootify" {
			return nil, errors.New("the replacement must be a current Nootify Go executable; service registration and private state were retained")
		}
	}
	if action != "status" {
		unlock, err := mutex(ctx, "Global\\Nootify.Service.Management."+sid, 60*time.Second)
		if err != nil {
			return nil, err
		}
		defer unlock()
	}
	state, err := taskCommand(ctx, "Status", options)
	if err != nil {
		return nil, err
	}
	result := Result{Installed: state.Installed, Running: boolPointer(state.Running), Enabled: boolPointer(state.Enabled), Task: state.Task}
	if action == "status" {
		return result, nil
	}
	if action == "install" {
		state, err = taskCommand(ctx, "Install", options)
		if err != nil {
			return nil, err
		}
		result.Installed = state.Installed
		if state.Record != nil && state.Record.Version == 1 {
			err = stopTask(ctx, options, sid)
			if err == nil {
				_, err = taskCommand(ctx, "Migrate", options)
			}
		}
		if err == nil {
			err = startTask(ctx, options)
		}
	} else if action == "start" || action == "restart" {
		if !state.Installed {
			return nil, errors.New("Nootify is not installed; use service-install")
		}
		if action == "restart" || state.Record != nil && state.Record.Version == 1 {
			err = stopTask(ctx, options, sid)
			if err == nil && state.Record != nil && state.Record.Version == 1 {
				_, err = taskCommand(ctx, "Migrate", options)
			}
		}
		if err == nil {
			err = startTask(ctx, options)
		}
	} else if action == "stop" || action == "uninstall" {
		result.WasRunning = boolPointer(state.Running)
		err = stopTask(ctx, options, sid)
		if err == nil && action == "uninstall" {
			_, err = taskCommand(ctx, "Uninstall", options)
			result.Installed = false
		}
	} else {
		_, err = taskCommand(ctx, strings.ToUpper(action[:1])+action[1:], options)
	}
	if err != nil {
		return nil, err
	}
	result.Running = nil
	result.Enabled = nil
	result.Status = map[string]string{"install": "installed", "start": "started", "restart": "restarted", "stop": "stopped", "uninstall": "uninstalled", "enable": "enabled", "disable": "disabled"}[action]
	return result, nil
}

// PrepareServe runs before the managed service can open private state or spawn
// subprocesses. Stop holds the same creation mutex until the entire job drains.
func PrepareServe(ctx context.Context, options Options) (func() error, error) {
	options, err := normalize(options)
	if err != nil {
		return nil, err
	}
	runtime.LockOSThread()
	handedOff := false
	defer func() {
		if !handedOff {
			runtime.UnlockOSThread()
		}
	}()
	fail := func(err error) (func() error, error) { return nil, err }
	sid, err := ownerSID()
	if err != nil {
		return fail(err)
	}
	runUnlock, err := mutex(ctx, "Global\\Nootify.Service.Run."+sid, 0)
	if err != nil {
		return fail(err)
	}
	creationUnlock, err := mutex(ctx, "Global\\Nootify.Service.Creation."+sid, 30*time.Second)
	if err != nil {
		runUnlock()
		return fail(err)
	}
	defer creationUnlock()
	state, err := taskCommand(ctx, "Status", options)
	if err != nil || !state.Installed || !state.Enabled || state.Record == nil || state.Record.MCP != options.MCPConfig {
		runUnlock()
		if err == nil {
			err = errors.New("managed serve does not match an enabled owned task")
		}
		return fail(err)
	}
	allowed := map[string]bool{}
	for _, entry := range managedEnvironment(os.Environ()) {
		key, _, _ := strings.Cut(entry, "=")
		allowed[strings.ToUpper(key)] = true
	}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !allowed[strings.ToUpper(key)] {
			_ = os.Unsetenv(key)
		}
	}
	old, record, err := privateJob(options, sid, false)
	if err != nil {
		runUnlock()
		return fail(err)
	}
	if old != 0 {
		err = terminateAndWait(ctx, old)
		windows.CloseHandle(old)
		if err != nil {
			runUnlock()
			return fail(err)
		}
	}
	if err = removeRuntime(options, record); err != nil {
		runUnlock()
		return fail(err)
	}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		runUnlock()
		return fail(err)
	}
	jobName := "Global\\Nootify.Service.Job." + sid + "." + hex.EncodeToString(nonce)
	descriptor, err := windows.SecurityDescriptorFromString("O:" + sid + "D:P(A;;GA;;;" + sid + ")(A;;GA;;;SY)")
	if err != nil {
		runUnlock()
		return fail(err)
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	name, _ := windows.UTF16PtrFromString(jobName)
	job, err := windows.CreateJobObject(&attributes, name)
	if err != nil {
		if job != 0 {
			windows.CloseHandle(job)
		}
		runUnlock()
		return fail(err)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		runUnlock()
		return fail(err)
	}
	started, err := processStarted(windows.CurrentProcess())
	if err != nil {
		windows.CloseHandle(job)
		runUnlock()
		return fail(err)
	}
	var session uint32
	var sessionPtr *uint32
	if windows.ProcessIdToSessionId(uint32(os.Getpid()), &session) == nil {
		sessionPtr = &session
	}
	current := jobRuntime{Version: 5, SID: sid, Executable: options.Executable, State: options.StateDir, Job: jobName, Boot: bootSequence(), Session: sessionPtr, PID: uint32(os.Getpid()), Started: started}
	data, _ := json.Marshal(current)
	temporary := runtimePath(options) + "." + hex.EncodeToString(nonce) + ".tmp"
	if err = os.WriteFile(temporary, data, 0600); err == nil {
		err = os.Rename(temporary, runtimePath(options))
	}
	if err != nil {
		_ = os.Remove(temporary)
		windows.CloseHandle(job)
		runUnlock()
		return fail(err)
	}
	if err = windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		_ = removeRuntime(options, &current)
		windows.CloseHandle(job)
		runUnlock()
		return fail(err)
	}
	handedOff = true
	return func() error {
		defer runtime.UnlockOSThread()
		defer runUnlock()
		// Keep the job handle until process exit: closing KILL_ON_JOB_CLOSE would kill
		// this goroutine before its final return. A receipt alone never proves exit;
		// control also verifies the original root PID/start time has exited.
		count, err := activeProcesses(job)
		if err != nil {
			return err
		}
		if count != 1 {
			return errors.New("managed service still has child processes; drain receipt was retained")
		}
		return os.WriteFile(completionPath(options, current), []byte(jobName), 0600)
	}, nil
}
