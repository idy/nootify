# Windows PowerShell 5.1; no elevation, password, service account, or machine-wide task.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Start', 'Restart', 'Stop', 'Uninstall', 'Status', 'Run')][string]$Action,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$ServerPath,
    [Parameter(Mandatory = $true)][string]$StateDir,
    [ValidateRange(1, 65535)][int]$Port = 9417,
    [string]$McpConfig
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "Nootify.Service.$ownerSid"
$descriptionPrefix = 'Nootify per-user service v1: '
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Full-Path([string]$Value) {
    # Rust canonical paths can carry a Win32 namespace prefix; NSIS uses DOS/UNC paths.
    # Compare the same filesystem path consistently across desktop and installer calls.
    if ($Value.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { $Value = '\\' + $Value.Substring(8) }
    elseif ($Value.StartsWith('\\?\', [StringComparison]::Ordinal)) { $Value = $Value.Substring(4) }
    if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)' -or $Value -match '["\x00-\x1f]') { throw 'Service paths must be absolute Windows paths without control characters or quotes' }
    return [IO.Path]::GetFullPath($Value)
}
function Same-Path([string]$Left, [string]$Right) { return [string]::Equals((Full-Path $Left).TrimEnd('\'), (Full-Path $Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
function Quote-Argument([string]$Value) {
    # These are Windows command-line arguments to -File, never PowerShell expressions.
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
function Run-Arguments($Record) {
    $parts = @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Argument $Record.script), '-Action', 'Run', '-NodePath', (Quote-Argument $Record.node), '-ServerPath', (Quote-Argument $Record.server), '-StateDir', (Quote-Argument $Record.state), '-Port', [string]$Record.port)
    if ($Record.mcp) { $parts += @('-McpConfig', (Quote-Argument $Record.mcp)) }
    return $parts -join ' '
}
function Get-Task {
    try { return $scheduler.GetFolder('\').GetTask($taskName) }
    catch {
        $failure = $_.Exception
        while ($failure) {
            if ($failure.HResult -eq -2147024894) { return $null } # ERROR_FILE_NOT_FOUND only; access denied is an error.
            $failure = $failure.InnerException
        }
        throw
    }
}
function Assert-Owned($Task) {
    $definition = $Task.Definition
    $description = [string]$definition.RegistrationInfo.Description
    if (!$description.StartsWith($descriptionPrefix, [StringComparison]::Ordinal)) { throw 'Refusing an unrelated Scheduled Task with the Nootify task name' }
    try {
        $record = $description.Substring($descriptionPrefix.Length) | ConvertFrom-Json
        if ($record.version -ne 1 -or $record.sid -ne $ownerSid -or !(Same-Path $record.script $scriptPath) -or !(Same-Path $record.node $NodePath) -or !(Same-Path $record.server $ServerPath) -or !(Same-Path $record.state $StateDir) -or $record.port -ne $Port) { throw 'mismatch' }
        if ($record.mcp) { $null = Full-Path $record.mcp }
        $principal = $definition.Principal
        $principalSid = $principal.UserId
        if ($principalSid -notlike 'S-1-*') { $principalSid = (New-Object Security.Principal.NTAccount($principalSid)).Translate([Security.Principal.SecurityIdentifier]).Value }
        if ($principalSid -ne $ownerSid -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1) { throw 'principal' }
        $entry = $definition.Actions.Item(1)
        if ($entry.Type -ne 0 -or !(Same-Path $entry.Path $powerShell) -or !(Same-Path $entry.WorkingDirectory $StateDir) -or $entry.Arguments -cne (Run-Arguments $record)) { throw 'action' }
    } catch { throw 'Refusing to control a Scheduled Task owned by another installation or with modified actions' }
    return $record
}
function Assert-PortFree {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.ExclusiveAddressUse = $true; $listener.Start() }
    catch { throw "Port $Port is already occupied; stop the existing service before installing or starting Nootify" }
    finally { $listener.Stop() }
}
function Prepare-State {
    $null = [IO.Directory]::CreateDirectory($StateDir)
    $directory = Get-Item -LiteralPath $StateDir -Force
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a redirected service state directory' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $sid = New-Object Security.Principal.SecurityIdentifier($ownerSid)
    $acl.SetOwner($sid)
    foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $null = $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $StateDir -AclObject $acl
}
function New-ServiceTask {
    $record = [ordered]@{ version = 1; sid = $ownerSid; script = $scriptPath; node = $NodePath; server = $ServerPath; state = $StateDir; port = $Port; mcp = $McpConfig }
    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress)
    $definition.Principal.UserId = $ownerSid
    $definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN: current user's logged-in session, no password.
    $definition.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA: never highest privileges.
    $trigger = $definition.Triggers.Create(9) # TASK_TRIGGER_LOGON
    $trigger.UserId = $ownerSid
    $trigger.Enabled = $true
    $settings = $definition.Settings
    $settings.Enabled = $true
    $settings.Hidden = $true
    $settings.AllowDemandStart = $true
    $settings.AllowHardTerminate = $true
    $settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
    $settings.DisallowStartIfOnBatteries = $false
    $settings.StopIfGoingOnBatteries = $false
    $settings.RunOnlyIfIdle = $false
    $settings.IdleSettings.StopOnIdleEnd = $false
    $settings.RunOnlyIfNetworkAvailable = $false
    $settings.StartWhenAvailable = $true
    $settings.ExecutionTimeLimit = 'PT0S'
    $settings.RestartInterval = 'PT1M'
    $settings.RestartCount = 999
    $entry = $definition.Actions.Create(0)
    $entry.Path = $powerShell
    $entry.Arguments = Run-Arguments $record
    $entry.WorkingDirectory = $StateDir
    # TASK_CREATE, not CREATE_OR_UPDATE: a racing or unrelated registration is never overwritten.
    return $scheduler.GetFolder('\').RegisterTaskDefinition($taskName, $definition, 2, $ownerSid, $null, 3, $null)
}
function Owned-Processes {
    # Capture handles before Stop, so PID reuse cannot make us wait on a later, unrelated process.
    # These handles are only waited on; termination always targets the verified Scheduler task/job.
    $found = New-Object 'Collections.Generic.List[Diagnostics.Process]'
    try {
        $runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
        if ($runtime.sid -ne $ownerSid -or !(Same-Path $runtime.script $scriptPath)) { return ,$found }
        $root = [Diagnostics.Process]::GetProcessById([int]$runtime.pid)
        if ($root.StartTime.ToUniversalTime().Ticks.ToString() -ne $runtime.started -or !(Same-Path $root.MainModule.FileName $powerShell)) { $root.Dispose(); return ,$found }
        $null = $root.Handle
        $found.Add($root)
        $pending = New-Object 'Collections.Generic.Queue[Diagnostics.Process]'
        $pending.Enqueue($root)
        while ($pending.Count -gt 0) {
            $parent = $pending.Dequeue()
            foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.Id)")) {
                try {
                    $process = [Diagnostics.Process]::GetProcessById([int]$child.ProcessId)
                    if ($process.StartTime.ToUniversalTime() -lt $parent.StartTime.ToUniversalTime()) { $process.Dispose(); continue }
                    $null = $process.Handle
                    $found.Add($process); $pending.Enqueue($process)
                } catch { } # A child may have already exited.
            }
        }
    } catch { } # Before Run writes its record it has not resumed node; Scheduler still owns PowerShell.
    return ,$found
}
function Stop-OwnedTask($Task) {
    $null = Assert-Owned $Task
    $processes = Owned-Processes
    try {
        if ($Task.GetInstances(0).Count -gt 0) { $Task.Stop(0) }
        $until = [DateTime]::UtcNow.AddSeconds(30)
        do {
            if ($Task.GetInstances(0).Count -eq 0) { break }
            if ([DateTime]::UtcNow -ge $until) { throw 'Timed out waiting for the Nootify task to stop' }
            Start-Sleep -Milliseconds 50
        } while ($true)
        foreach ($process in $processes) {
            $remaining = [Math]::Max(0, [int]($until - [DateTime]::UtcNow).TotalMilliseconds)
            if (!$process.WaitForExit($remaining)) { throw 'Timed out waiting for Nootify node/helper processes to release their files' }
        }
    } finally { foreach ($process in $processes) { $process.Dispose() } }
}
function Start-OwnedTask($Task) {
    $null = Assert-Owned $Task
    if ($Task.GetInstances(0).Count -eq 0) {
        Assert-PortFree
        $Task.Enabled = $true
        $null = $Task.Run($null)
    }
    $until = [DateTime]::UtcNow.AddSeconds(30)
    do {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 -MaximumRedirection 0
            if ($response.service -eq 'nootify' -and $Task.GetInstances(0).Count -gt 0) { return }
        } catch { }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $until)
    throw "Nootify task started but health is not ready; inspect $(Join-Path $StateDir 'stderr.log')"
}
function Enter-Lock([string]$Name, [int]$Milliseconds) {
    $mutex = New-Object Threading.Mutex($false, $Name)
    try {
        try { $entered = $mutex.WaitOne($Milliseconds) } catch [Threading.AbandonedMutexException] { $entered = $true }
        if (!$entered) { throw 'Another Nootify service operation is in progress' }
    } catch { $mutex.Dispose(); throw }
    return $mutex
}
function Run-Service {
    $task = Get-Task
    if (!$task) { throw 'Nootify task is not installed' }
    $record = Assert-Owned $task
    if ($record.mcp -cne $McpConfig) { throw 'Run arguments do not match the registered task' }
    $runLock = Enter-Lock "Global\Nootify.Service.Run.$ownerSid" 0
    $runner = $null
    try {
        Prepare-State
        Assert-PortFree
        # Task Scheduler may inherit machine/user environment. Keep account secrets and code injection out.
        Get-ChildItem Env: | Where-Object { $_.Name -match '^(NODE_.*|LARK_.*|SLACK_.*|TELEGRAM_.*|GITHUB_.*|GH_.*|CODEX_APP_SERVER_.*|OPENCODE_SERVER_.*|TS_.*|TSNET_.*|TAILSCALE_.*|NOOTIFY_TSNET_BIN|NOOTIFY_GITHUB_CLIENT_ID)$' } | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
        Add-Type -Path (Join-Path $PSScriptRoot 'service-runner.cs')
        $arguments = @($ServerPath, '--state-dir', $StateDir, '--port', [string]$Port)
        if ($McpConfig) { $arguments += @('--mcp-config', $McpConfig) }
        $runner = [Nootify.ServiceRunner]::new($NodePath, [string[]]$arguments, $StateDir)
        $current = [Diagnostics.Process]::GetCurrentProcess()
        [IO.File]::WriteAllText($runtimePath, (@{ sid = $ownerSid; script = $scriptPath; pid = $PID; started = $current.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress))
        $runner.Resume()
        $exitCode = $runner.Wait()
    } finally {
        if ($runner) { $runner.Dispose() }
        Remove-Item -LiteralPath $runtimePath -ErrorAction SilentlyContinue
        $runLock.ReleaseMutex(); $runLock.Dispose()
    }
    exit $exitCode # Preserve failures so Scheduler's restart policy applies.
}

$operationLock = $null
try {
    $scriptPath = Full-Path $PSCommandPath
    $NodePath = Full-Path $NodePath; $ServerPath = Full-Path $ServerPath; $StateDir = Full-Path $StateDir
    if ($McpConfig) { $McpConfig = Full-Path $McpConfig }
    $runtimePath = Join-Path $StateDir 'windows-runtime.json'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    if ($Action -eq 'Run') { Run-Service }
    # Status stays read-only and cheap: one COM lookup, no subprocess, HTTP request, or lock wait.
    if ($Action -ne 'Status') { $operationLock = Enter-Lock "Global\Nootify.Service.Management.$ownerSid" 60000 }
    $task = Get-Task
    if ($task) { $record = Assert-Owned $task }
    if ($Action -eq 'Status') { @{ installed = [bool]$task } | ConvertTo-Json -Compress; exit 0 }
    if ($Action -eq 'Install') {
        if ($task) {
            if ($McpConfig -and !(Same-Path $record.mcp $McpConfig)) { throw 'The installed task uses another MCP config; uninstall it before changing its configuration' }
        } else {
            if (!(Test-Path -LiteralPath $NodePath -PathType Leaf) -or !(Test-Path -LiteralPath $ServerPath -PathType Leaf)) { throw 'Node or the compiled Nootify server is missing' }
            Assert-PortFree
            Prepare-State
            $task = New-ServiceTask
        }
        Start-OwnedTask $task
    } elseif ($Action -eq 'Start' -or $Action -eq 'Restart') {
        if (!$task) { throw 'Nootify is not installed; use service-install' }
        if ($Action -eq 'Restart') { Stop-OwnedTask $task }
        Start-OwnedTask $task
    } elseif ($task) {
        Stop-OwnedTask $task
        if ($Action -eq 'Uninstall') { $scheduler.GetFolder('\').DeleteTask($taskName, 0) }
    }
    $status = @{ Install = 'installed'; Start = 'started'; Restart = 'restarted'; Stop = 'stopped'; Uninstall = 'uninstalled' }[$Action]
    @{ installed = [bool]($task -and $Action -ne 'Uninstall'); status = $status; task = $taskName } | ConvertTo-Json -Compress
} catch {
    if ($Action -eq 'Run' -and (Test-Path -LiteralPath $StateDir -PathType Container)) {
        try { [IO.File]::AppendAllText((Join-Path $StateDir 'stderr.log'), "Scheduled Task: $($_.Exception.Message)`r`n") } catch { }
    }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($operationLock) { $operationLock.ReleaseMutex(); $operationLock.Dispose() }
}
