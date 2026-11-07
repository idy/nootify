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
# Load only this host's built-in modules, not PowerShell 7 modules inherited by 5.1.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
# CREATE_NO_WINDOW has redirected handles but no console code page to configure.
$utf8 = [Text.UTF8Encoding]::new($false)
$stdoutWriter = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$stderrWriter = [IO.StreamWriter]::new([Console]::OpenStandardError(), $utf8)
$stdoutWriter.AutoFlush = $true; $stderrWriter.AutoFlush = $true
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "Nootify.Service.$ownerSid"
$descriptionPrefix = 'Nootify per-user service v1: '
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$creationLockName = "Global\Nootify.Service.Creation.$ownerSid"
$runLockName = "Global\Nootify.Service.Run.$ownerSid"

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
function Get-TaskInstanceCount {
    # GetInstances(0) can omit this hidden task even while Scheduler reports Running.
    # Use the API with an explicit TASK_ENUM_HIDDEN flag, then select the exact root path.
    $running = $scheduler.GetRunningTasks(1)
    $total = $running.Count
    if ($null -eq $total -or $total -lt 0) { throw 'Cannot verify running Scheduled Task instances' }
    $expectedPath = '\' + $taskName
    $count = 0
    for ($index = 1; $index -le $total; $index++) {
        $path = [string]$running.Item($index).Path
        if (!$path) { throw 'Cannot verify a running Scheduled Task path' }
        if ([string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { $count++ }
    }
    return $count
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
    try {
        # Match bundled Node/libuv: exclusive binds reject harmless TIME_WAIT sockets,
        # while SO_REUSEADDR on Windows can steal another application's live port.
        $listener.ExclusiveAddressUse = $false
        $listener.Server.SetSocketOption([Net.Sockets.SocketOptionLevel]::Socket, [Net.Sockets.SocketOptionName]::ReuseAddress, $false)
        $listener.Start()
    }
    catch { throw "Port $Port is already occupied; stop the existing service before installing or starting Nootify" }
    finally { $listener.Stop() }
}
function Protect-StateItem([IO.FileSystemInfo]$Item) {
    # Replacing only the parent ACL leaves explicit/protected child grants readable
    # through Windows bypass-traverse privilege. Repair every existing entry too.
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing redirected service state entries' }
    $isDirectory = $Item -is [IO.DirectoryInfo]
    if ($isDirectory) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inheritance = 'ContainerInherit, ObjectInherit' }
    else { $acl = New-Object Security.AccessControl.FileSecurity; $inheritance = 'None' }
    $acl.SetAccessRuleProtection($true, $false)
    $sid = New-Object Security.Principal.SecurityIdentifier($ownerSid)
    $acl.SetOwner($sid)
    foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, 'None', 'Allow')
        $null = $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Item.FullName -AclObject $acl
    if ($isDirectory) {
        # Traverse only after protecting this directory, never through a reparse point.
        foreach ($child in $Item.GetFileSystemInfos()) { Protect-StateItem $child }
    }
}
function Prepare-State {
    $null = [IO.Directory]::CreateDirectory($StateDir)
    Protect-StateItem (Get-Item -LiteralPath $StateDir -Force)
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
function Import-ServiceRunner {
    # Use the verified entry script path: extracted function scriptblocks have no PSScriptRoot.
    # Only System.dll/mscorlib types are used, including on Windows PowerShell 5.1.
    if (!('Nootify.ServiceJob' -as [type])) { Add-Type -LiteralPath (Join-Path (Split-Path -Parent (Full-Path $scriptPath)) 'service-runner.cs') }
}
function Get-BootSequence { return [Nootify.ServiceJob]::ReadBootSequence() }
function Get-TerminalSessionId { return [Nootify.ServiceJob]::ReadTerminalSessionId() }
function Test-TerminalSessionEnded([uint32]$SessionId) { return [Nootify.ServiceJob]::TerminalSessionEnded($SessionId) }
function Job-CompletionPath([string]$Name) {
    $prefix = "Global\Nootify.Service.Job.$ownerSid."
    if ($Name -cnotmatch ('^' + [regex]::Escape($prefix) + '[0-9a-f]{32}$')) { throw 'Cannot verify the Nootify job identity' }
    return Join-Path (Split-Path -Parent $runtimePath) ('windows-job-' + $Name.Substring($prefix.Length) + '.complete')
}
function Read-OwnedRuntime([bool]$TaskActive) {
    try { $runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json }
    catch [IO.FileNotFoundException] {
        if ($TaskActive) { throw 'Cannot verify the active Nootify task job: its runtime record is missing' }
        return $null
    }
    catch [IO.DirectoryNotFoundException] {
        if ($TaskActive) { throw 'Cannot verify the active Nootify task job: its state directory is missing' }
        return $null
    }
    # Private state plus the exact installation/SID and an unpredictable per-run name bind
    # this handle to our job. Never fall back to a PID tree, a fixed job name, or an outer job.
    $prefix = "Global\Nootify.Service.Job.$ownerSid."
    if ($runtime.version -notin @(2, 3, 4) -or $runtime.sid -ne $ownerSid -or !(Same-Path $runtime.script $scriptPath) -or $runtime.job -cnotmatch ('^' + [regex]::Escape($prefix) + '[0-9a-f]{32}$')) {
        throw 'Cannot verify the Nootify job runtime record'
    }
    if ($runtime.version -ge 3 -and $null -ne $runtime.boot) {
        [uint32]$boot = 0
        if (!([uint32]::TryParse([string]$runtime.boot, [ref]$boot))) { throw 'Cannot verify the Nootify kernel boot sequence' }
    }
    if ($runtime.version -eq 4 -and $null -ne $runtime.terminal_session) {
        [uint32]$terminal = 0
        if (!([uint32]::TryParse([string]$runtime.terminal_session, [ref]$terminal))) { throw 'Cannot verify the Nootify terminal session' }
    }
    return $runtime
}
function Open-OwnedJob([bool]$TaskActive) {
    $runtime = Read-OwnedRuntime $TaskActive
    if (!$runtime) { return $null }
    $completionPath = Job-CompletionPath ([string]$runtime.job)
    $job = [Nootify.ServiceJob]::Open([string]$runtime.job, $ownerSid, $completionPath)
    if ($job) { return $job } # A live job always requires its own authoritative drain.
    if ($runtime.version -ge 3 -and $null -ne $runtime.boot) {
        $currentBoot = Get-BootSequence
        if ($null -ne $currentBoot -and [uint32]$runtime.boot -ne [uint32]$currentBoot) { return $null }
    }
    if ($runtime.version -eq 4 -and $null -ne $runtime.terminal_session -and [uint32]$runtime.terminal_session -ne 0) {
        if (Test-TerminalSessionEnded ([uint32]$runtime.terminal_session)) { return $null }
    }
    # A changed boot or explicit deletion of the original terminal session excludes
    # every old member. Present/reused session IDs, denied queries and other errors
    # never prove exit. Otherwise require a receipt after ActiveProcesses==0.
    # A missing name alone only proves that the last job handle closed.
    try { $completed = [IO.File]::ReadAllText($completionPath) }
    catch [IO.FileNotFoundException] { $completed = $null }
    catch [IO.DirectoryNotFoundException] { $completed = $null }
    if ($completed -cne [string]$runtime.job) {
        throw "Cannot verify Nootify shutdown: the missing job has no completion receipt, deleted terminal session or changed kernel boot sequence. Sign out and sign back in, or use Windows Restart and retry. Preserved or reused session IDs cannot certify shutdown. If this record has no readable boot evidence, Restart alone cannot clear it: deliberately remove or repair '$runtimePath' after the restart, preserving the other private settings."
    }
    return $null
}
function Remove-JobRuntime {
    $runtime = Read-OwnedRuntime $false
    if ($runtime) {
        $completionPath = Job-CompletionPath ([string]$runtime.job)
        # Remove the runtime identity first: interruption may leave an unused receipt,
        # but must never discard a receipt that a retained runtime still needs.
        Remove-Item -LiteralPath $runtimePath -ErrorAction Stop
        Remove-Item -LiteralPath $completionPath -ErrorAction SilentlyContinue
    }
}
function Publish-Job([string]$Name) {
    $temporary = $runtimePath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        # CreateProcess inherits handles and therefore runs Node in this same terminal
        # session. The first atomic assignment binds every future job member to it.
        [IO.File]::WriteAllText($temporary, (@{ version = 4; sid = $ownerSid; script = $scriptPath; job = $Name; boot = (Get-BootSequence); terminal_session = (Get-TerminalSessionId) } | ConvertTo-Json -Compress))
        [IO.File]::Move($temporary, $runtimePath) # Same-directory atomic publication, before any Node creation.
    } finally { Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue }
}
function Stop-OwnedTask($Task) {
    if ($Task) { $null = Assert-Owned $Task }
    Import-ServiceRunner
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $creationLock = $null; $job = $null
    # Prevent logon/restart policy from starting another instance after the empty check.
    # A deleted registration can still have a live job; its private runtime must be checked.
    if ($Task) { $Task.Enabled = $false }
    try {
        $creationLock = Enter-Lock $creationLockName ([Math]::Max(0, 30000 - [int]$watch.ElapsedMilliseconds))
        $job = Open-OwnedJob ($Task -and (Get-TaskInstanceCount) -gt 0)
        if ($Task -and (Get-TaskInstanceCount) -gt 0) { $Task.Stop(0) }
        # Retaining the handle defeats KILL_ON_JOB_CLOSE, so terminate explicitly and
        # query kernel membership until empty, including helpers spawned during Stop.
        if ($job) { $job.TerminateAndWait([Math]::Max(0, 30000 - [int]$watch.ElapsedMilliseconds)) }
        while ($Task -and (Get-TaskInstanceCount) -ne 0) {
            if ($watch.ElapsedMilliseconds -ge 30000) { throw 'Timed out waiting for the Nootify task to stop' }
            Start-Sleep -Milliseconds 50
        }
        Remove-JobRuntime
    } finally {
        if ($job) { $job.Dispose() }
        if ($creationLock) { $creationLock.ReleaseMutex(); $creationLock.Dispose() }
    }
}
function Start-OwnedTask($Task) {
    $null = Assert-Owned $Task
    $Task.Enabled = $true
    if ((Get-TaskInstanceCount) -eq 0) {
        Assert-PortFree
        $null = $Task.Run($null)
    }
    $until = [DateTime]::UtcNow.AddSeconds(30)
    do {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 -MaximumRedirection 0
            if ($response.service -eq 'nootify' -and (Get-TaskInstanceCount) -gt 0) { return }
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
    $runLock = Enter-Lock $runLockName 0
    $runner = $null; $job = $null; $creationLock = $null
    try {
        Prepare-State
        Assert-PortFree
        # Task Scheduler may inherit machine/user environment. Keep account secrets and code injection out.
        Get-ChildItem Env: | Where-Object { $_.Name -match '^(NODE_.*|LARK_.*|SLACK_.*|TELEGRAM_.*|GITHUB_.*|GH_.*|CODEX_APP_SERVER_.*|OPENCODE_SERVER_.*|TS_.*|TSNET_.*|TAILSCALE_.*|NOOTIFY_TSNET_BIN|NOOTIFY_GITHUB_CLIENT_ID)$' } | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
        Import-ServiceRunner
        $arguments = @($ServerPath, '--state-dir', $StateDir, '--port', [string]$Port)
        if ($McpConfig) { $arguments += @('--mcp-config', $McpConfig) }
        $creationLock = Enter-Lock $creationLockName 30000
        try {
            # This is independent of Management, which Start/Install holds until health.
            # A queued Run must observe Stop's disable before it can create any process.
            $task = Get-Task
            if (!$task) { throw 'Nootify task is no longer installed' }
            $record = Assert-Owned $task
            if ($record.mcp -cne $McpConfig) { throw 'Run arguments do not match the registered task' }
            if (!$task.Enabled) { return 0 }
            # Failure leaves Node uncreated and reports a failed Run. Keep the logon
            # trigger enabled so a later sign-in or Restart can supply independent evidence.
            $previous = Open-OwnedJob $false
            if ($previous) { try { $previous.TerminateAndWait(20000) } finally { $previous.Dispose() } }
            Remove-JobRuntime
            $name = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
            $job = [Nootify.ServiceJob]::Create($name, $ownerSid, (Job-CompletionPath $name))
            Publish-Job $name
            $runner = [Nootify.ServiceRunner]::new($job, $NodePath, [string[]]$arguments, $StateDir)
            $runner.Resume()
        } finally {
            $creationLock.ReleaseMutex(); $creationLock.Dispose(); $creationLock = $null
        }
        return $runner.Wait() # Preserve failures so Scheduler's restart policy applies.
    } finally {
        try {
            if ($runner) { $runner.Dispose() }
            elseif ($job) { $job.TerminateAndWait(20000) }
        } finally {
            if ($job) { $job.Dispose() }
            if ($creationLock) { $creationLock.ReleaseMutex(); $creationLock.Dispose() }
            # A successful drain publishes a private receipt before closing the job.
            # Keep the identity for Stop/restart. After abrupt exit, a vanished name
            # requires that receipt, a changed boot or verified terminal-session deletion.
            $runLock.ReleaseMutex(); $runLock.Dispose()
        }
    }
}

$operationLock = $null
try {
    $scriptPath = Full-Path $PSCommandPath
    $NodePath = Full-Path $NodePath; $ServerPath = Full-Path $ServerPath; $StateDir = Full-Path $StateDir
    if ($McpConfig) { $McpConfig = Full-Path $McpConfig }
    $runtimePath = Join-Path $StateDir 'windows-runtime.json'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    if ($Action -eq 'Run') { exit (Run-Service) }
    # Status stays read-only and cheap: one COM lookup, no subprocess, HTTP request, or lock wait.
    if ($Action -ne 'Status') { $operationLock = Enter-Lock "Global\Nootify.Service.Management.$ownerSid" 60000 }
    $task = Get-Task
    if ($task) { $record = Assert-Owned $task }
    if ($Action -eq 'Status') { $stdoutWriter.WriteLine((@{ installed = [bool]$task } | ConvertTo-Json -Compress)); exit 0 }
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
    } else {
        Stop-OwnedTask $task
        if ($task -and $Action -eq 'Uninstall') { $scheduler.GetFolder('\').DeleteTask($taskName, 0) }
    }
    $status = @{ Install = 'installed'; Start = 'started'; Restart = 'restarted'; Stop = 'stopped'; Uninstall = 'uninstalled' }[$Action]
    $stdoutWriter.WriteLine((@{ installed = [bool]($task -and $Action -ne 'Uninstall'); status = $status; task = $taskName } | ConvertTo-Json -Compress))
} catch {
    if ($Action -eq 'Run' -and (Test-Path -LiteralPath $StateDir -PathType Container)) {
        try { [IO.File]::AppendAllText((Join-Path $StateDir 'stderr.log'), "Scheduled Task: $($_.Exception.Message)`r`n") } catch { }
    }
    $stderrWriter.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($operationLock) { $operationLock.ReleaseMutex(); $operationLock.Dispose() }
}
