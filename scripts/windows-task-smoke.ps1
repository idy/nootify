#requires -Version 5.1
# Exercise the actual Go executable and per-user Scheduled Task on a disposable runner.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or !$env:RUNNER_TEMP) {
    throw 'This probe controls a real user task and requires a disposable Windows GitHub Actions runner.'
}
$repository = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:RUNNER_TEMP ('Nootify Go task ' + [guid]::NewGuid().ToString('N'))
$output = Join-Path $repository '.cache\windows-task-smoke'
$null = [IO.Directory]::CreateDirectory($output)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "Nootify.Service.$sid"
$scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect()
function Get-ProbeTask {
    try { return $scheduler.GetFolder('\').GetTask($taskName) }
    catch {
        $failure = $_.Exception
        while ($failure) { if ($failure.HResult -eq -2147024894) { return $null }; $failure = $failure.InnerException }
        throw
    }
}
if (Get-ProbeTask) { throw 'Refusing to replace a pre-existing Nootify task' }
$null = [IO.Directory]::CreateDirectory($work)
$executable = Join-Path $work 'Nootify.exe'
$state = Join-Path $work 'state'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
$port = $listener.LocalEndpoint.Port; $listener.Stop()
$results = New-Object 'Collections.Generic.List[object]'
$failure = $null
function Invoke-Service([string]$Action,[int]$Expected = 0) {
    $stdout = Join-Path $output ($Action + '.stdout.log')
    $stderr = Join-Path $output ($Action + '.stderr.log')
    $arguments = 'service-' + $Action + ' --state-dir "' + $state + '" --port ' + $port
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (!$process.WaitForExit(170000)) { $process.Kill(); throw "$Action timed out" }
    $process.WaitForExit()
    if ($process.ExitCode -ne $Expected) { throw "$Action exited $($process.ExitCode), expected $Expected" }
    if ($Expected -eq 0) { return (Get-Content -LiteralPath $stdout -Raw | ConvertFrom-Json) }
}
function Assert-Task {
    $task = Get-ProbeTask
    if (!$task) { throw 'Task is missing' }
    $definition = $task.Definition
    if ($definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1) { throw 'Task principal/action changed' }
    $entry = $definition.Actions.Item(1)
    if ($entry.Path -cne $executable -or $entry.Arguments -notmatch '^serve --service-managed --state-dir ') { throw 'Task must launch the Go executable directly' }
    if ($entry.Arguments -match 'node|server\.js|service\.ps1') { throw 'Obsolete runtime appeared in task arguments' }
    return $task
}
try {
    Push-Location $repository
    try { & go build -mod=readonly -o $executable ./desktop; if ($LASTEXITCODE -ne 0) { throw 'Go fixture build failed' } }
    finally { Pop-Location }
    $null = Invoke-Service 'install'
    $task = Assert-Task
    $status = Invoke-Service 'status'
    if (!$status.installed -or !$status.running -or !$status.enabled) { throw 'Installed task is not enabled and running' }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
    if ($health.backend -cne 'go') { throw 'Task is not serving the Go backend' }
    $record = Get-Content -LiteralPath (Join-Path $state 'windows-runtime.json') -Raw | ConvertFrom-Json
    $original = Get-Process -Id $record.pid; $null = $original.Handle
    $results.Add(@{ name = 'install-direct-executable'; result = 'passed' })
    $null = Invoke-Service 'restart'
    if (!$original.WaitForExit(5000)) { throw 'Restart returned before the original process exited' }
    $null = Assert-Task
    $results.Add(@{ name = 'restart-drains-original-job'; result = 'passed' })
    $task = Get-ProbeTask
    $definition = $task.Definition
    $originalArguments = $definition.Actions.Item(1).Arguments
    $definition.Actions.Item(1).Arguments = $originalArguments + ' --foreign'
    $null = $scheduler.GetFolder('\').RegisterTaskDefinition($taskName,$definition,4,$sid,$null,3,$null)
    try { $null = Invoke-Service 'stop' 1 }
    finally {
        $definition.Actions.Item(1).Arguments = $originalArguments
        $null = $scheduler.GetFolder('\').RegisterTaskDefinition($taskName,$definition,4,$sid,$null,3,$null)
    }
    $results.Add(@{ name = 'foreign-arguments-refused'; result = 'passed' })
    $stopped = Invoke-Service 'stop'
    if (!$stopped.was_running) { throw 'Stop lost the prior running state' }
    $status = Invoke-Service 'status'
    if ($status.running -or $status.enabled) { throw 'Stop left a running/enabled task' }
    if (Test-Path -LiteralPath (Join-Path $state 'windows-runtime.json')) { throw 'Stop retained a drained runtime record' }
    $null = Invoke-Service 'uninstall'
    if (Get-ProbeTask) { throw 'Uninstall retained the owned task' }
    if (!(Test-Path -LiteralPath (Join-Path $state 'auth-token'))) { throw 'Uninstall removed private state' }
    $results.Add(@{ name = 'stop-uninstall-preserve-private-state'; result = 'passed' })
} catch { $failure = $_.Exception.Message }
finally {
    try { if (Get-ProbeTask) { $null = Assert-Task; $null = Invoke-Service 'uninstall' } }
    catch { if (!$failure) { $failure = $_.Exception.Message } }
    @{ result = $(if ($failure) { 'failed' } else { 'passed' }); error = $failure; cases = @($results.ToArray()) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'diagnostics.json') -Encoding UTF8
    if (!(Get-ProbeTask)) { Remove-Item -LiteralPath $work -Recurse -Force }
}
if ($failure) { throw $failure }
Write-Host 'Go Scheduled Task install, restart, ownership, drain and uninstall probes passed.'
