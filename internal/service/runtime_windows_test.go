package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestEnableMigratesLegacyWithoutStartingIdleTask(t *testing.T) {
	for _, failure := range []string{"", "stop", "Migrate", "Enable"} {
		t.Run(failure, func(t *testing.T) {
			var calls []string
			call := func(action string) error {
				calls = append(calls, action)
				if action == failure {
					return errors.New("injected failure")
				}
				return nil
			}
			state := taskState{Installed: true, Enabled: true}
			state.Record = &struct {
				MCP     string `json:"mcp"`
				Version int    `json:"version"`
			}{Version: 1}
			_, err := manageWindowsTask("enable", windowsTaskControl{
				command: func(action string) (taskState, error) { return state, call(action) },
				stop:    func() error { return call("stop") },
				start:   func() error { t.Fatal("enabled idle task was started"); return nil },
			})
			want := []string{"Status", "stop", "Migrate", "Enable"}
			if failure != "" {
				for i, action := range want {
					if action == failure {
						want = want[:i+1]
						break
					}
				}
			}
			if (err != nil) != (failure != "") || !reflect.DeepEqual(calls, want) {
				t.Fatal(calls, err)
			}
		})
	}
}

func TestGoActionsRefuseRestoredOldDesktopExecutable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Nootify.exe")
	if err := os.WriteFile(path, []byte("legacy desktop fixture, never execute"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"install", "start", "restart", "enable"} {
		_, err := Manage(context.Background(), action, Options{Executable: path})
		if err == nil || !strings.Contains(err.Error(), "current Nootify Go executable") {
			t.Fatalf("%s passed the old desktop to task controls: %v", action, err)
		}
	}
}

func TestLegacyRestoreValidatesExactRegistrationWithoutRealTaskWrites(t *testing.T) {
	// Use Scheduler only as an in-memory XML definition factory. All folder,
	// registration and running-task APIs below are fake; no real task is touched.
	for _, mutation := range []string{"", "script", "node", "server", "state", "sid", "port", "action", "principal", "extra-action", "current-action"} {
		t.Run(mutation, func(t *testing.T) {
			root := t.TempDir()
			for _, name := range []string{"node.exe", "service/windows/service.ps1", "service/dist/src/server.js"} {
				path := filepath.Join(root, filepath.FromSlash(name))
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("fixture; never executed"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Git checkouts on Windows may embed CRLF source. Use one normalized
			// copy for both function extraction and the actual controller below.
			source := strings.ReplaceAll(taskScript, "\r\n", "\n")
			functions, _, ok := strings.Cut(source[strings.Index(source, "function Full-Path"):], "\ntry {\n    $Executable")
			if !ok {
				t.Fatal("missing task controller entry")
			}
			fixture := `$ErrorActionPreference='Stop'
$ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName='Nootify.Service.'+$ownerSid
$Executable=` + powershellLiteral(filepath.Join(root, "Nootify.exe")) + `
$StateDir=` + powershellLiteral(filepath.Join(root, "state")) + `
$Port=9417; $McpConfig=''; $descriptionPrefix='Nootify per-user service v2: '
$powerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
` + functions + `
$global:definitionFactory=New-Object -ComObject 'Schedule.Service'; $definitionFactory.Connect()
$old=$definitionFactory.NewTask(0)
$old.Principal.UserId=$ownerSid; $old.Principal.LogonType=3; $old.Principal.RunLevel=0
$old.Settings.Enabled=$true; $old.Settings.Hidden=$true; $old.Settings.ExecutionTimeLimit='PT0S'
$trigger=$old.Triggers.Create(9); $trigger.UserId=$ownerSid
$r=[ordered]@{version=1;sid=$ownerSid;script=(Join-Path (Split-Path $Executable) 'service\windows\service.ps1');node=(Join-Path (Split-Path $Executable) 'node.exe');server=(Join-Path (Split-Path $Executable) 'service\dist\src\server.js');state=$StateDir;port=$Port;mcp=''}
$mutation=` + powershellLiteral(mutation) + `
if(@('script','node','server','state') -contains $mutation){$r[$mutation]='C:\foreign\payload'}
if($mutation -eq 'sid'){$r.sid='S-1-5-18'}
if($mutation -eq 'port'){$r.port=9418}
$old.RegistrationInfo.Description='Nootify per-user service v1: '+($r | ConvertTo-Json -Compress)
$a=$old.Actions.Create(0); $a.Path=$powerShell; $a.Arguments=Legacy-Run-Arguments $r; $a.WorkingDirectory=$StateDir
if($mutation -eq 'action'){$a.Arguments+=' -Unexpected'}
if($mutation -eq 'principal'){$old.Principal.RunLevel=1}
if($mutation -eq 'extra-action'){$extra=$old.Actions.Create(0);$extra.Path=$Executable}
$receipt=$old.XmlText
$old.Settings.Enabled=$false
$expected=$old.XmlText
$current=$definitionFactory.NewTask(0); $current.XmlText=$old.XmlText
$current.Principal.RunLevel=0
$current.RegistrationInfo.Description=$descriptionPrefix+(@{version=2;sid=$ownerSid;executable=$Executable;state=$StateDir;port=$Port;mcp=''} | ConvertTo-Json -Compress)
$current.Actions.Clear(); $a=$current.Actions.Create(0); $a.Path=$Executable; $a.Arguments='serve --service-managed --state-dir '+(Quote-Argument $StateDir)+' --port 9417'; $a.WorkingDirectory=$StateDir
if($mutation -eq 'current-action'){$a.Path='C:\foreign\Nootify.exe'}
$global:fixtureTask=[pscustomobject]@{Definition=$current;Enabled=$false;State=3}
$global:writes=0
$global:fixtureFolder=[pscustomobject]@{}
$fixtureFolder | Add-Member ScriptMethod GetTask { param($name) return $global:fixtureTask }
$fixtureFolder | Add-Member ScriptMethod RegisterTaskDefinition {
 param($name,$definition,$flags,$sid,$password,$logon,$sddl)
 if($flags -ne 4 -or $name -ne $taskName -or $sid -ne $ownerSid -or $logon -ne 3){throw 'Unexpected registration'}
 $global:writes++
 $global:fixtureTask=[pscustomobject]@{Definition=$definition;Enabled=$definition.Settings.Enabled;State=3}
 return $global:fixtureTask
}
$fixtureScheduler=[pscustomobject]@{}
$fixtureScheduler | Add-Member ScriptMethod Connect {}
$fixtureScheduler | Add-Member ScriptMethod GetFolder { param($path) return $global:fixtureFolder }
$fixtureScheduler | Add-Member ScriptMethod NewTask { param($flags) return $global:definitionFactory.NewTask($flags) }
$fixtureScheduler | Add-Member ScriptMethod GetRunningTasks { param($flags) return [pscustomobject]@{Count=0} }
`
			// Execute the actual Restore branch with fake Scheduler access. The
			// production catch still exits nonzero on every ownership refusal.
			controller := strings.ReplaceAll(source, "New-Object -ComObject 'Schedule.Service'", "$fixtureScheduler")
			script := fixture + "\n[Console]::Error.WriteLine('fixture-ready')\n$restoreWatch=[Diagnostics.Stopwatch]::StartNew()\n& {\n" + controller + "\n} -Action Restore -Executable $Executable -StateDir $StateDir -Registration $receipt\n" + `
if($restoreWatch.Elapsed.TotalSeconds -ge 20){throw 'Restore controller exceeded its 20-second action budget'}
if($mutation -eq ''){
 if($global:writes -ne 1 -or $global:fixtureTask.Enabled -or $global:fixtureTask.Definition.XmlText -cne $expected){throw 'Original XML was not restored disabled'}
}else{throw 'Modified identity was accepted'}
`
			encoded, err := powerShellCommand(script)
			if err != nil {
				t.Fatal(err)
			}
			directory, err := windows.GetSystemDirectory()
			if err != nil {
				t.Fatal(err)
			}
			// This process also cold-starts PowerShell/COM and builds multiple XML
			// fixtures. Give setup its own headroom; the actual Restore assertion
			// above retains the production action's 20-second budget.
			out := Run(context.Background(), Command{Path: filepath.Join(directory, "WindowsPowerShell", "v1.0", "powershell.exe"), Args: []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded}, Dir: directory, Timeout: time.Minute})
			if mutation == "" && out.Err != nil {
				t.Fatalf("restore failed: %v %s", out.Err, out.Stderr)
			}
			if mutation != "" && (out.Err == nil || !strings.Contains(out.Stderr, "Refusing to control a Scheduled Task")) {
				t.Fatalf("expected exact ownership refusal, got %v %s", out.Err, out.Stderr)
			}
		})
	}
}
