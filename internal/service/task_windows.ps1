# Windows PowerShell 5.1; no elevation, password, service account, or machine-wide task.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Start', 'Stop', 'Uninstall', 'Status', 'Enable', 'Disable', 'Migrate', 'Capture', 'Restore')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$StateDir,
    [ValidateRange(1, 65535)][int]$Port = 9417,
    [string]$McpConfig,
    [string]$Registration
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
$descriptionPrefix = 'Nootify per-user service v2: '
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
    $parts = @('serve', '--service-managed', '--state-dir', (Quote-Argument $Record.state), '--port', [string]$Record.port)
    if ($Record.mcp) { $parts += @('--mcp-config', (Quote-Argument $Record.mcp)) }
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
function Test-OwnedTaskRunning($Task) {
    if (!$Task) { return $false }
    # Call only after Assert-Owned. Include hidden Scheduler instances and queued
    # work, whose imminent process creation Stop must also drain.
    return ((Get-TaskInstanceCount) -gt 0 -or $Task.State -eq 4 -or $Task.State -eq 2)
}
function Legacy-Run-Arguments($Record) {
    $parts = @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Argument $Record.script), '-Action', 'Run', '-NodePath', (Quote-Argument $Record.node), '-ServerPath', (Quote-Argument $Record.server), '-StateDir', (Quote-Argument $Record.state), '-Port', [string]$Record.port)
    if ($Record.mcp) { $parts += @('-McpConfig', (Quote-Argument $Record.mcp)) }
    return $parts -join ' '
}
function Assert-Owned($Task) {
    $definition = $Task.Definition
    $description = [string]$definition.RegistrationInfo.Description
    $legacyPrefix = 'Nootify per-user service v1: '
    $legacy = $description.StartsWith($legacyPrefix, [StringComparison]::Ordinal)
    if (!$legacy -and !$description.StartsWith($descriptionPrefix, [StringComparison]::Ordinal)) { throw 'Refusing an unrelated Scheduled Task with the Nootify task name' }
    try {
        $prefix = $(if ($legacy) { $legacyPrefix } else { $descriptionPrefix })
        $record = $description.Substring($prefix.Length) | ConvertFrom-Json
        if ($record.sid -ne $ownerSid -or !(Same-Path $record.state $StateDir) -or $record.port -ne $Port) { throw 'mismatch' }
        if ($record.mcp) { $null = Full-Path $record.mcp }
        $expectedPath = $Executable
        $expectedArguments = ''
        if ($legacy) {
            $directory = Split-Path -Parent $Executable
            if ($record.version -ne 1 -or !(Same-Path $record.script (Join-Path $directory 'service\windows\service.ps1')) -or !(Same-Path $record.node (Join-Path $directory 'node.exe')) -or !(Same-Path $record.server (Join-Path $directory 'service\dist\src\server.js'))) { throw 'legacy installation mismatch' }
            $expectedPath = $powerShell; $expectedArguments = Legacy-Run-Arguments $record
        } else {
            if ($record.version -ne 2 -or !(Same-Path $record.executable $Executable)) { throw 'executable mismatch' }
            $expectedArguments = Run-Arguments $record
        }
        $principal = $definition.Principal; $principalSid = $principal.UserId
        if ($principalSid -notlike 'S-1-*') { $principalSid = (New-Object Security.Principal.NTAccount($principalSid)).Translate([Security.Principal.SecurityIdentifier]).Value }
        if ($principalSid -ne $ownerSid -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1) { throw 'principal' }
        $entry = $definition.Actions.Item(1)
        if ($entry.Type -ne 0 -or !(Same-Path $entry.Path $expectedPath) -or !(Same-Path $entry.WorkingDirectory $StateDir) -or $entry.Arguments -cne $expectedArguments) { throw 'action' }
    } catch { throw 'Refusing to control a Scheduled Task owned by another installation or with modified actions' }
    return $record
}
function Assert-PortFree {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try {
        # Require a free listener: exclusive binds reject harmless TIME_WAIT sockets,
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
    $record = [ordered]@{ version = 2; sid = $ownerSid; executable = $Executable; state = $StateDir; port = $Port; mcp = $McpConfig }
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
    $entry.Path = $Executable
    $entry.Arguments = Run-Arguments $record
    $entry.WorkingDirectory = $StateDir
    # TASK_CREATE, not CREATE_OR_UPDATE: a racing or unrelated registration is never overwritten.
    return $scheduler.GetFolder('\').RegisterTaskDefinition($taskName, $definition, 2, $ownerSid, $null, 3, $null)
}

try {
    $Executable = Full-Path $Executable; $StateDir = Full-Path $StateDir
    if ($McpConfig) { $McpConfig = Full-Path $McpConfig }
    $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect()
    $task = Get-Task
    $record = $null
    if ($task) { $record = Assert-Owned $task }
    $captured = ''
    if ($Action -eq 'Capture') {
        if ($task -and $record.version -eq 1) { $captured = [string]$task.Xml }
    } elseif ($Action -eq 'Restore') {
        # A receipt is data, never a PowerShell program. Validate the complete old
        # action and current registration independently before replacing either.
        if (!$Registration -or $Registration.Length -gt 16384) { throw 'Invalid legacy task receipt' }
        $definition = $scheduler.NewTask(0)
        $definition.XmlText = $Registration
        $original = Assert-Owned ([pscustomobject]@{ Definition = $definition })
        if ($original.version -ne 1) { throw 'Rollback requires an exact owned legacy registration' }
        if (!$task -or $task.Enabled -or (Test-OwnedTaskRunning $task)) { throw 'Owned task must be disabled and drained before restoration' }
        foreach ($path in @($original.script, $original.node, $original.server)) {
            if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Original legacy service payload is missing' }
        }
        # Disabled publication cannot start a previously idle job through a trigger.
        $definition.Settings.Enabled = $false
        $task = $scheduler.GetFolder('\').RegisterTaskDefinition($taskName, $definition, 4, $ownerSid, $null, 3, $null)
        $record = Assert-Owned $task
    } elseif ($Action -eq 'Install') {
        if ($task) {
            if ($McpConfig -and !(Same-Path $record.mcp $McpConfig)) { throw 'The installed task uses another MCP config; uninstall it before changing its configuration' }
        } else {
            if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Nootify executable is missing' }
            Assert-PortFree; Prepare-State; $task = New-ServiceTask; $record = Assert-Owned $task
        }
    } elseif ($Action -eq 'Migrate') {
        if (!$task -or $task.Enabled -or (Get-TaskInstanceCount) -ne 0) { throw 'Legacy task must be disabled and drained before migration' }
        if ($record.version -eq 1) {
            $definition = $task.Definition
            $record = [ordered]@{ version = 2; sid = $ownerSid; executable = $Executable; state = $StateDir; port = $Port; mcp = $record.mcp }
            $definition.RegistrationInfo.Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress)
            $definition.Actions.Clear()
            $entry = $definition.Actions.Create(0); $entry.Path = $Executable; $entry.Arguments = Run-Arguments $record; $entry.WorkingDirectory = $StateDir
            $task = $scheduler.GetFolder('\').RegisterTaskDefinition($taskName, $definition, 4, $ownerSid, $null, 3, $null)
        }
    } elseif ($Action -eq 'Start') {
        if (!$task) { throw 'Nootify is not installed; use service-install' }
        $task.Enabled = $true
        if ((Get-TaskInstanceCount) -eq 0) { Assert-PortFree; $null = $task.Run($null) }
    } elseif ($Action -eq 'Stop') {
        if ($task) { $task.Enabled = $false; if ((Get-TaskInstanceCount) -gt 0) { $task.Stop(0) } }
    } elseif ($Action -eq 'Disable' -or $Action -eq 'Enable') {
        if ($task) { $task.Enabled = ($Action -eq 'Enable') }
        elseif ($Action -eq 'Enable') { throw 'Owned service task is missing' }
    } elseif ($Action -eq 'Uninstall') {
        if ($task) { $scheduler.GetFolder('\').DeleteTask($taskName,0); $task = $null }
    }
    $stdoutWriter.WriteLine((@{ installed = [bool]$task; running = [bool](Test-OwnedTaskRunning $task); enabled = [bool]($task -and $task.Enabled); task = $taskName; record = $record; registration = $captured } | ConvertTo-Json -Depth 5 -Compress))
} catch { $stderrWriter.WriteLine($_.Exception.Message); exit 1 }
