#requires -Version 5.1
# Exercise the source service's real task, without building or loading the application.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or !$env:RUNNER_TEMP -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This probe controls the real per-user task and is restricted to disposable Windows GitHub Actions runners.'
}
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')

function Resolve-NodePath {
    # Application discovery can return every PATH match. Passing Source[] to a string
    # parameter joins the paths, producing one invalid Windows path with multiple drive colons.
    return @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
}

$repository = Split-Path -Parent $PSScriptRoot
$serviceScript = (Resolve-Path -LiteralPath (Join-Path $repository 'windows\service.ps1')).Path
$node = Resolve-NodePath
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (![IO.Path]::IsPathRooted($env:RUNNER_TEMP)) { throw 'RUNNER_TEMP must be an absolute path' }
$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$fixtureDir = Join-Path $runnerTemp 'Nootify task smoke'
$server = Join-Path $fixtureDir 'server.cjs'
$stateDir = Join-Path $fixtureDir 'state'
$mcpConfig = Join-Path $fixtureDir 'empty-mcp.json'
$markerPath = Join-Path $fixtureDir 'fixture-id'
$fixtureId = [guid]::NewGuid().ToString('N')
$outputDir = Join-Path $repository '.cache\windows-task-smoke'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "Nootify.Service.$sid"
$taskPath = '\' + $taskName
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$port = 0
$ownsFixture = $false
$phase = 'preflight'
$failure = $null
$cleanupFailure = $null
$results = New-Object 'Collections.Generic.List[object]'
$observations = New-Object 'Collections.Generic.List[object]'
$fixtureProcesses = New-Object 'Collections.Generic.List[Diagnostics.Process]'

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\'), [IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function Quote-Argument([string]$Value) {
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
function Get-ProbeTask {
    try { return $scheduler.GetFolder('\').GetTask($taskName) }
    catch {
        $exception = $_.Exception
        while ($exception) {
            if ($exception.HResult -eq -2147024894) { return $null } # ERROR_FILE_NOT_FOUND only.
            $exception = $exception.InnerException
        }
        throw # Access denied/unknown is never absence.
    }
}
function Service-Arguments([string]$Action) {
    # Explicit source/runtime/state/config paths; never the real CLI, server or user configuration.
    return (@('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', (Quote-Argument $serviceScript), '-Action', $Action, '-NodePath', (Quote-Argument $node),
        '-ServerPath', (Quote-Argument $server), '-StateDir', (Quote-Argument $stateDir), '-Port', [string]$port,
        '-McpConfig', (Quote-Argument $mcpConfig)) -join ' ')
}
function Assert-ProbeTask($Task) {
    if (!$Task -or $Task.Path -cne $taskPath) { throw 'Expected the exact fixture task registration' }
    $definition = $Task.Definition
    $prefix = 'Nootify per-user service v1: '
    $description = [string]$definition.RegistrationInfo.Description
    if (!$description.StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'Refusing cleanup/control of an unrelated Nootify task' }
    $record = $description.Substring($prefix.Length) | ConvertFrom-Json
    if ($record.version -ne 1 -or $record.sid -cne $sid -or $record.port -ne $port -or
        !(Same-Path $record.script $serviceScript) -or !(Same-Path $record.node $node) -or
        !(Same-Path $record.server $server) -or !(Same-Path $record.state $stateDir) -or
        !(Same-Path $record.mcp $mcpConfig)) { throw 'Refusing cleanup/control of a task owned by another installation' }
    $principal = $definition.Principal
    $principalSid = $principal.UserId
    if ($principalSid -notlike 'S-1-*') {
        $principalSid = (New-Object Security.Principal.NTAccount($principalSid)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    if ($principalSid -cne $sid -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1) {
        throw 'The fixture must be the current-user, interactive, unelevated task with exactly one action'
    }
    $entry = $definition.Actions.Item(1)
    if ($entry.Type -ne 0 -or !(Same-Path $entry.Path $powerShell) -or !(Same-Path $entry.WorkingDirectory $stateDir) -or
        $entry.Arguments -cne (Service-Arguments 'Run')) { throw 'Refusing cleanup/control of a task with modified actions' }
}
function Query-Error([Exception]$Exception) {
    $cause = $Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    return @{ message = $Exception.Message; hresult = $cause.HResult }
}
function Get-TaskObservation([string]$Label) {
    $value = [ordered]@{
        label = $Label; phase = $phase; task_path = $taskPath
        task_present = $null; task_error = $null; state = $null; state_error = $null
        enabled = $null; enabled_error = $null; last_result = $null; last_result_error = $null
        instances_count = $null; instances_error = $null
        running_tasks_exact_path_count = $null; running_tasks_error = $null
    }
    try {
        $task = Get-ProbeTask
        $value.task_present = [bool]$task
        if ($task) {
            try { $value.state = [int]$task.State } catch { $value.state_error = Query-Error $_.Exception }
            try { $value.enabled = [bool]$task.Enabled } catch { $value.enabled_error = Query-Error $_.Exception }
            try { $value.last_result = [long]$task.LastTaskResult } catch { $value.last_result_error = Query-Error $_.Exception }
            try {
                # Read Count directly: @(...).Count can count a COM wrapper instead of its instances.
                $count = $task.GetInstances(0).Count
                if ($null -eq $count -or $count -lt 0) { throw 'GetInstances returned no valid Count' }
                $value.instances_count = [int]$count
            } catch { $value.instances_error = Query-Error $_.Exception }
        }
    } catch { $value.task_error = Query-Error $_.Exception }
    try {
        # TASK_ENUM_HIDDEN=1. Both APIs are security-context scoped, not kernel shutdown proof:
        # https://learn.microsoft.com/windows/win32/taskschd/taskservice-getrunningtasks
        $running = $scheduler.GetRunningTasks(1)
        $count = $running.Count
        if ($null -eq $count -or $count -lt 0) { throw 'GetRunningTasks returned no valid Count' }
        $matches = 0
        for ($index = 1; $index -le $count; $index++) {
            if ($running.Item($index).Path -ceq $taskPath) { $matches++ }
        }
        $value.running_tasks_exact_path_count = $matches
    } catch { $value.running_tasks_error = Query-Error $_.Exception }
    return $value
}
function Save-Observation($Value) {
    $observations.Add($Value)
    Write-Host ('Task smoke observation: ' + ($Value | ConvertTo-Json -Depth 4 -Compress))
}
function Read-FixtureHealth {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 -MaximumRedirection 0
        if ($health.service -ceq 'nootify' -and $health.fixture -ceq $fixtureId -and $health.pid -gt 0) { return $health }
    } catch { }
    return $null
}
function Test-PortFree {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
    try {
        $listener.ExclusiveAddressUse = $false
        $listener.Server.SetSocketOption([Net.Sockets.SocketOptionLevel]::Socket, [Net.Sockets.SocketOptionName]::ReuseAddress, $false)
        $listener.Start()
        return $true
    } catch { return $false }
    finally { $listener.Stop() }
}
function Invoke-Service([string]$Action, [string]$Label) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $powerShell
    $start.Arguments = Service-Arguments $Action
    $start.WorkingDirectory = $fixtureDir
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $start.EnvironmentVariables[$name] = $value }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (!$process.Start()) { throw "Could not launch source service $Action" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        # Outer deadman only: production retains its 60s management lock and 30s start/stop deadlines.
        $timedOut = !$process.WaitForExit(120000)
        if ($timedOut) {
            $process.Kill()
            if (!$process.WaitForExit(5000)) { throw "Source service $Action exceeded 120s and its command process did not exit" }
        }
        if (!$stdout.Wait(5000) -or !$stderr.Wait(5000)) { throw "Source service $Action did not close its redirected output" }
        [IO.File]::WriteAllText((Join-Path $outputDir "$Label.stdout.log"), $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $outputDir "$Label.stderr.log"), $stderr.GetAwaiter().GetResult())
        if ($timedOut) { throw "Source service $Action exceeded 120s; see $Label.stderr.log" }
        if ($process.ExitCode -ne 0) { throw "Source service $Action exited $($process.ExitCode); see $Label.stderr.log" }
        $result = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
        $expected = @{ Install = 'installed'; Start = 'started'; Stop = 'stopped'; Uninstall = 'uninstalled' }[$Action]
        if ($result.status -cne $expected -or $result.task -cne $taskName -or $result.installed -ne ($Action -ne 'Uninstall')) {
            throw "Unexpected source service $Action result"
        }
    } finally { $process.Dispose() }
}
function Assert-Running {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Assert-ProbeTask (Get-ProbeTask)
        $value = Get-TaskObservation 'running'
        $health = Read-FixtureHealth
        $value['fixture_healthy'] = [bool]$health
        $value['fixture_pid'] = $(if ($health) { [int]$health.pid } else { $null })
        if ($health -and !($fixtureProcesses | Where-Object { $_.Id -eq [int]$health.pid -and !$_.HasExited })) {
            $process = Get-Process -Id ([int]$health.pid) -ErrorAction Stop
            $null = $process.Handle # Retain this exact process through Stop/Uninstall, including PID reuse.
            if (!(Same-Path $process.MainModule.FileName $node)) { $process.Dispose(); throw 'Fixture health PID is not the expected Node executable' }
            $fixtureProcesses.Add($process)
        }
        if ($health -and $value.state -eq 4 -and $value.enabled -eq $true -and $value.instances_count -eq 1) {
            Save-Observation $value
            return [int]$health.pid
        }
        Start-Sleep -Milliseconds 150
    } while ($watch.Elapsed.TotalSeconds -lt 5)
    Save-Observation $value
    throw ('Expected one running, healthy fixture task; actual: ' + ($value | ConvertTo-Json -Compress))
}
function Assert-Drained([bool]$TaskRemains) {
    foreach ($process in $fixtureProcesses) {
        if (!$process.WaitForExit(5000)) { throw "Fixture Node process $($process.Id) survived production job shutdown" }
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $value = Get-TaskObservation 'drained'
        $value['port_free'] = Test-PortFree
        $value['fixture_healthy'] = [bool](Read-FixtureHealth)
        $value['runtime_present'] = Test-Path -LiteralPath (Join-Path $stateDir 'windows-runtime.json')
        # Unknown/denied queries remain null. A missing registration has no GetInstances count.
        # Source Stop/Uninstall's kernel job drain plus retained process handles certify shutdown.
        if ($value.task_present -eq $TaskRemains -and $value.port_free -and !$value.fixture_healthy -and !$value.runtime_present -and
            ($null -eq $value.running_tasks_exact_path_count -or $value.running_tasks_exact_path_count -eq 0) -and
            (!$TaskRemains -or ($value.enabled -eq $false -and $value.state -eq 1 -and $null -ne $value.instances_count -and $value.instances_count -eq 0))) {
            Save-Observation $value
            return
        }
        Start-Sleep -Milliseconds 150
    } while ($watch.Elapsed.TotalSeconds -lt 5)
    Save-Observation $value
    throw ('Expected drained fixture; actual: ' + ($value | ConvertTo-Json -Compress))
}
function Test-Step([string]$Name, [scriptblock]$Check) {
    $script:phase = $Name
    Write-Host "Windows task smoke: $Name"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $null = & $Check
        $results.Add(@{ name = $Name; result = 'passed'; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2) })
    } catch {
        $results.Add(@{ name = $Name; result = 'failed'; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2); error = $_.Exception.Message })
        throw
    }
}
function Assert-PlainTree([IO.FileSystemInfo]$Item) {
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing redirected fixture entries' }
    if ($Item -is [IO.DirectoryInfo]) {
        foreach ($child in $Item.GetFileSystemInfos()) { Assert-PlainTree $child }
    }
}

# Do not overwrite old diagnostic files, or write/copy anything from a pre-existing fixture.
if (Test-Path -LiteralPath $outputDir) { throw "Refusing pre-existing probe diagnostics: $outputDir" }
$null = New-Item -ItemType Directory -Path $outputDir
try {
    Test-Step 'Fresh disposable runner and isolated fixture' {
        if ((Test-Path -LiteralPath $fixtureDir) -or (Get-ProbeTask)) {
            throw 'Refusing a pre-existing Nootify task or task-smoke fixture directory'
        }
        if (((Get-Item -LiteralPath $runnerTemp -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Refusing redirected RUNNER_TEMP'
        }
        $null = New-Item -ItemType Directory -Path $fixtureDir # No -Force: a racing directory must fail.
        $script:ownsFixture = $true
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $owner = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.SetOwner($owner)
        foreach ($identity in @($owner, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
            $null = $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
        }
        Set-Acl -LiteralPath $fixtureDir -AclObject $acl
        [IO.File]::WriteAllText($markerPath, $fixtureId)
        [IO.File]::WriteAllText($mcpConfig, '{"mcpServers":{}}')
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
        try {
            $listener.Start()
            $script:port = $listener.LocalEndpoint.Port
        } finally { $listener.Stop() }
        # No application imports, settings, tokens, network backends or real MCP configuration.
        $fixtureSource = @'
'use strict';
const http = require('node:http');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--state-dir' || args[1] !== path.join(__dirname, 'state') ||
    args[2] !== '--port' || !/^\d+$/.test(args[3]) || Number(args[3]) < 1 || Number(args[3]) > 65535 ||
    args[4] !== '--mcp-config' || args[5] !== path.join(__dirname, 'empty-mcp.json')) {
  throw new Error('Unexpected task fixture arguments');
}
const server = http.createServer((req, res) => {
  res.setHeader('Connection', 'close');
  if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ service: 'nootify', fixture: '__FIXTURE_ID__', pid: process.pid }));
});
server.listen(Number(args[3]), '127.0.0.1', () => console.log('Task fixture listening.'));
'@
        [IO.File]::WriteAllText($server, $fixtureSource.Replace('__FIXTURE_ID__', $fixtureId))
    }
    Test-Step 'Node discovery selects the first executable when PATH has multiple matches' {
        $firstRuntime = Join-Path $fixtureDir 'first Node runtime'
        $secondRuntime = Join-Path $fixtureDir 'second Node runtime'
        $savedPath = $env:PATH
        try {
            foreach ($directory in @($firstRuntime, $secondRuntime)) {
                $null = New-Item -ItemType Directory -Path $directory
                # Discovery only: these empty executables are never launched.
                [IO.File]::WriteAllText((Join-Path $directory 'node.exe'), '')
            }
            $env:PATH = $firstRuntime + [IO.Path]::PathSeparator + $secondRuntime
            $resolved = Resolve-NodePath
            if ($resolved -isnot [string] -or $resolved -cne (Join-Path $firstRuntime 'node.exe')) {
                throw 'Node discovery must return one path to the first executable, not join multiple PATH matches'
            }
        } finally {
            $env:PATH = $savedPath
            foreach ($directory in @($firstRuntime, $secondRuntime)) {
                if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
            }
        }
    }
    Test-Step 'Invocation paths are individual absolute filesystem paths' {
        $paths = [ordered]@{ PowerShell = $powerShell; Script = $serviceScript; NodePath = $node; ServerPath = $server
            StateDir = $stateDir; McpConfig = $mcpConfig; WorkingDirectory = $fixtureDir; RunnerTemp = $runnerTemp }
        foreach ($field in $paths.Keys) {
            $path = $paths[$field]
            $diagnostic = [ordered]@{ label = 'invocation-path'; phase = $phase; field = $field; value = $path
                type = $(if ($null -eq $path) { 'null' } else { $path.GetType().FullName }); full_path = $null; error = $null }
            try {
                if ($path -isnot [string]) { throw 'Expected one path string' }
                if (![IO.Path]::IsPathRooted($path)) { throw 'Expected an absolute path' }
                $diagnostic.full_path = [IO.Path]::GetFullPath($path)
            } catch {
                $diagnostic.error = $_.Exception.Message
                throw "Invalid probe invocation path ${field}: $($_.Exception.Message)"
            } finally { Save-Observation $diagnostic }
        }
        # Only source/runtime/fixture paths, never application configuration contents.
        Save-Observation ([ordered]@{ label = 'invocation-command'; phase = $phase; executable = $powerShell; arguments = (Service-Arguments 'Install') })
    }
    Test-Step 'Install starts the exact interactive unelevated task' {
        Invoke-Service 'Install' 'install'
        $script:firstPid = Assert-Running
    }
    Test-Step 'Repeated Start keeps exactly one fixture process' {
        Assert-ProbeTask (Get-ProbeTask)
        Invoke-Service 'Start' 'start-existing'
        if ((Assert-Running) -ne $firstPid) { throw 'Repeated Start replaced the running fixture process' }
    }
    Test-Step 'Stop disables the task and drains its real job' {
        Assert-ProbeTask (Get-ProbeTask)
        Invoke-Service 'Stop' 'stop'
        Assert-ProbeTask (Get-ProbeTask)
        Assert-Drained $true
    }
    Test-Step 'Start after Stop creates a healthy replacement' {
        Assert-ProbeTask (Get-ProbeTask)
        Invoke-Service 'Start' 'start-stopped'
        $script:secondPid = Assert-Running
        if ($secondPid -eq $firstPid) { throw 'Start after Stop did not replace the original process' }
    }
    Test-Step 'Uninstall drains the running fixture and removes its task' {
        Assert-ProbeTask (Get-ProbeTask)
        Invoke-Service 'Uninstall' 'uninstall'
        Assert-Drained $false
    }
} catch {
    $failure = $_.Exception.Message
    Write-Warning "Windows task smoke failed in ${phase}: $failure"
} finally {
    $value = Get-TaskObservation 'before-cleanup'
    if ($ownsFixture -and $port -gt 0) {
        $health = Read-FixtureHealth
        $value['fixture_healthy'] = [bool]$health
        $value['fixture_pid'] = $(if ($health) { [int]$health.pid } else { $null })
        $value['port_free'] = Test-PortFree
        $value['runtime_present'] = Test-Path -LiteralPath (Join-Path $stateDir 'windows-runtime.json')
    }
    Save-Observation $value
    if ($ownsFixture) {
        try {
            Assert-PlainTree (Get-Item -LiteralPath $fixtureDir -Force)
            if ([IO.File]::ReadAllText($markerPath) -cne $fixtureId) { throw 'Refusing cleanup of an unverified fixture directory' }
            $task = Get-ProbeTask
            if ($task) { Assert-ProbeTask $task } # Re-read exact registration before any cleanup operation.
            # Only fixed fixture log names are copied. A diagnostic failure must not bypass cleanup.
            try {
                foreach ($name in @('stdout.log', 'stderr.log')) {
                    $path = Join-Path $stateDir $name
                    if (Test-Path -LiteralPath $path -PathType Leaf) {
                        Copy-Item -LiteralPath $path -Destination (Join-Path $outputDir "fixture-$name")
                    }
                }
            } catch { Write-Warning "Could not copy fixture logs: $($_.Exception.Message)" }
            if ($task) { Invoke-Service 'Uninstall' 'cleanup-uninstall' }
            Assert-Drained $false
            Remove-Item -LiteralPath $fixtureDir -Recurse -Force
        } catch {
            $cleanupFailure = $_.Exception.Message
            Write-Warning "Windows task smoke cleanup refused or failed: $cleanupFailure"
        }
    }
    foreach ($process in $fixtureProcesses) { $process.Dispose() }
    @{ result = $(if ($failure -or $cleanupFailure) { 'failed' } else { 'passed' }); phase = $phase; port = $port
        error = $failure; cleanup_error = $cleanupFailure; steps = @($results.ToArray()); observations = @($observations.ToArray()) } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputDir 'diagnostics.json') -Encoding UTF8
    if ($env:GITHUB_STEP_SUMMARY) {
        @('### Windows Scheduled Task lifecycle probe', '') + @($results | ForEach-Object { "- $($_.result): $($_.name) ($($_.seconds)s)" }) |
            Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
    }
}
if ($failure -or $cleanupFailure) { throw "Windows task lifecycle probe failed. $failure Cleanup: $cleanupFailure" }
Write-Host 'Real Windows Scheduled Task Install/Start/Stop/Uninstall probe passed.'
