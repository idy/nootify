package service

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestTaskSnapshotsKeepPositiveEvidenceAndRetryIncompleteEnumeration(t *testing.T) {
	// Exercise the embedded production functions against in-memory Scheduler
	// objects. Never query or modify the runner's real tasks.
	source := strings.ReplaceAll(taskScript, "\r\n", "\n")
	start := strings.Index(source, "function Get-TaskInstanceCount {")
	end := strings.Index(source, "function Legacy-Run-Arguments(")
	if start < 0 || end <= start {
		t.Fatal("missing task snapshot functions")
	}
	script := `$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
Set-StrictMode -Version 2.0
$taskName='Nootify.Service.synthetic-owner'
` + source[start:end] + `
$global:reads=0
$global:mode='complete'
$global:complete=[pscustomobject]@{Count=3}
$global:complete | Add-Member ScriptMethod Item {
 param($index)
 switch($index){
  1 { return [pscustomobject]@{Path=('\'+$taskName)} }
  2 { return [pscustomobject]@{Path=('\foreign\'+$taskName)} }
  3 { return [pscustomobject]@{Path=('\'+$taskName.ToUpperInvariant())} }
  default { throw 'Unexpected instance index' }
 }
}
$global:incomplete=[pscustomobject]@{Count=2}
$global:incomplete | Add-Member ScriptMethod Item {
 param($index)
 if($index -eq 1){return [pscustomobject]@{Path=('\'+$taskName)}}
 return [pscustomobject]@{Path=''}
}
$global:scheduler=[pscustomobject]@{}
$scheduler | Add-Member ScriptMethod GetRunningTasks {
 param($flags)
 if($flags -ne 1){throw 'Hidden tasks were not included'}
 $global:reads++
 switch($global:mode){
  'complete' { return $global:complete }
  'empty' { return [pscustomobject]@{Count=0} }
  'transient' { if($global:reads -eq 1){return $global:incomplete}; return $global:complete }
  'incomplete' { return $global:incomplete }
  'missing-count' { return [pscustomobject]@{Count=$null} }
  'negative-count' { return [pscustomobject]@{Count=-1} }
  'denied' { throw 'synthetic enumeration denied' }
  default { throw 'Unexpected fixture mode' }
 }
}
# Running/queued are positive evidence only for the already ownership-checked task.
foreach($state in @(4,2)){
 $global:reads=0; $global:mode='denied'
 if(!(Test-OwnedTaskRunning ([pscustomobject]@{State=$state})) -or $global:reads -ne 0){throw 'Positive owned state depended on unrelated tasks'}
}
if(Test-OwnedTaskRunning $null){throw 'Missing task was reported running'}
$global:reads=0; $global:mode='empty'
if((Test-OwnedTaskRunning ([pscustomobject]@{State=3})) -or $global:reads -ne 1){throw 'Complete empty snapshot was not accepted as stopped'}
$global:reads=0; $global:mode='complete'
if((Get-TaskInstanceCount) -ne 2 -or $global:reads -ne 1){throw 'Enumeration lost exact root matching or stable fast path'}
$global:reads=0; $global:mode='transient'
if(!(Test-OwnedTaskRunning ([pscustomobject]@{State=3})) -or $global:reads -ne 2){throw 'Incomplete snapshot was not discarded and reread'}
foreach($mode in @('incomplete','missing-count','negative-count','denied')){
 $global:reads=0; $global:mode=$mode; $refused=$false
 try { $null=Test-OwnedTaskRunning ([pscustomobject]@{State=3}) }
 catch {
  $message=$_.Exception.Message
  if($mode -eq 'denied' -and $message -notlike '*synthetic enumeration denied*'){throw}
  if($mode -eq 'incomplete' -and $message -notlike '*Cannot verify a running Scheduled Task path*'){throw}
  if($mode -in @('missing-count','negative-count') -and $message -notlike '*Cannot verify running Scheduled Task instances*'){throw}
  $refused=$true
 }
 if(!$refused){throw 'Unverified enumeration was accepted as stopped'}
 if($mode -eq 'incomplete' -and $global:reads -lt 2){throw 'Incomplete snapshot was not retried'}
 if($mode -ne 'incomplete' -and $global:reads -ne 1){throw 'Non-transient failure was retried'}
}
Write-Output 'snapshot-probe-pass'
`
	encoded, err := powerShellCommand(script)
	if err != nil {
		t.Fatal(err)
	}
	directory, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	out := Run(context.Background(), Command{
		Path: filepath.Join(directory, "WindowsPowerShell", "v1.0", "powershell.exe"),
		Args: []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded},
		Dir:  directory, Timeout: 20 * time.Second,
	})
	if out.Err != nil || !strings.Contains(out.Stdout, "snapshot-probe-pass") {
		t.Fatalf("snapshot verification failed: %v %s %s", out.Err, out.Stdout, out.Stderr)
	}
}
