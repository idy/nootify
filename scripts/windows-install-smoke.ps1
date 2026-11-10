#requires -Version 5.1
# Execute real NSIS packages only on a disposable Windows Actions runner.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$BaselineInstaller,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$BaselineVersion = '0.0.0',
    [string]$OutputDirectory = '.cache/windows-install-smoke'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) {
    throw 'This test installs software and is restricted to disposable Windows GitHub Actions runners.'
}
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$BaselineInstaller = (Resolve-Path -LiteralPath $BaselineInstaller).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$installDir = Join-Path $env:RUNNER_TEMP 'Nootify install smoke'
$stateDir = Join-Path $env:LOCALAPPDATA 'Nootify\state'
$app = Join-Path $installDir 'Nootify.exe'
$node = Join-Path $installDir 'node.exe'
$cli = Join-Path $installDir 'service\dist\src\cli.js'
$server = Join-Path $installDir 'service\dist\src\server.js'
$uninstaller = Join-Path $installDir 'uninstall.exe'
$registryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nootify'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "Nootify.Service.$sid"
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$results = New-Object 'Collections.Generic.List[object]'
$launches = 0
$ownsTestState = $false
$failure = $null
$phase = 'preflight'
$null = [IO.Directory]::CreateDirectory($OutputDirectory)

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\'), [IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function Get-TestTask {
    try { return $scheduler.GetFolder('\').GetTask($taskName) }
    catch {
        $errorObject = $_.Exception
        while ($errorObject) {
            if ($errorObject.HResult -eq -2147024894) { return $null }
            $errorObject = $errorObject.InnerException
        }
        throw
    }
}
function Get-TestInstanceCount {
    $running = $scheduler.GetRunningTasks(1) # TASK_ENUM_HIDDEN
    $total = $running.Count
    if ($null -eq $total -or $total -lt 0) { throw 'Cannot query hidden running task instances' }
    $count = 0
    $expectedPath = '\' + $taskName
    for ($index = 1; $index -le $total; $index++) {
        $path = [string]$running.Item($index).Path
        if (!$path) { throw 'Running task path is unavailable' }
        if ([string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { $count++ }
    }
    return $count
}
function Get-TestApps {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'Nootify.exe'" | Where-Object {
        $_.ExecutablePath -and (Same-Path $_.ExecutablePath $app)
    })
}
function Get-InstallProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -and
        $_.CommandLine.IndexOf($installDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}
function Stop-TestApps {
    foreach ($process in @(Get-TestApps)) {
        $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($live) { $live.Kill(); $null = $live.WaitForExit(10000) }
    }
}
function Get-ServiceProcess {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.ExecutablePath -and (Same-Path $_.ExecutablePath $node) -and $_.CommandLine -and
        $_.CommandLine.IndexOf($server, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($processes.Count -ne 1) { throw "Expected one installed daemon, found $($processes.Count)" }
    $process = Get-Process -Id $processes[0].ProcessId
    $null = $process.Handle # Pin the process identity before replacement/restart.
    return $process
}
function Test-Health {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:9417/health' -TimeoutSec 2 -MaximumRedirection 0
        return $health.service -eq 'nootify'
    } catch { return $false }
}
function Test-PortFree {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 9417)
    try {
        $listener.ExclusiveAddressUse = $false
        $listener.Server.SetSocketOption([Net.Sockets.SocketOptionLevel]::Socket, [Net.Sockets.SocketOptionName]::ReuseAddress, $false)
        $listener.Start()
        return $true
    }
    catch { return $false }
    finally { $listener.Stop() }
}
function Wait-Until([string]$Description, [scriptblock]$Check, [int]$Seconds = 90) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $lastError = ''
    do {
        try { if (& $Check) { return } } catch { $lastError = $_.Exception.Message }
        Start-Sleep -Milliseconds 250
    } while ($watch.Elapsed.TotalSeconds -lt $Seconds)
    throw "Timed out: $Description. $lastError"
}
function Test-Step([string]$Name, [scriptblock]$Check) {
    $script:phase = $Name
    Write-Host "Install smoke: $Name"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $null = & $Check
        $results.Add(@{ name = $Name; result = 'passed'; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2) })
    } catch {
        $results.Add(@{ name = $Name; result = 'failed'; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2); error = $_.Exception.Message })
        throw
    }
}
function Run-Native([string]$File, [string]$Arguments, [string]$Label, [int]$ExpectedExitCode = 0) {
    $stdout = Join-Path $OutputDirectory "$Label.stdout.log"
    $stderr = Join-Path $OutputDirectory "$Label.stderr.log"
    # NSIS detail output is not its stdout/stderr. Give each owned installer
    # invocation a fresh opt-in trace directory; never pass this to the daemon.
    $installerProcess = (Same-Path $File $Installer) -or (Same-Path $File $BaselineInstaller) -or (Same-Path $File $uninstaller)
    $traceVariable = 'NOOTIFY_INSTALLER_DIAGNOSTICS'
    $previousTrace = [Environment]::GetEnvironmentVariable($traceVariable, 'Process')
    try {
        if ($installerProcess) {
            $trace = Join-Path $OutputDirectory ('installer-' + $Label + '-' + [Guid]::NewGuid().ToString('N'))
            $null = [IO.Directory]::CreateDirectory($trace)
            [Environment]::SetEnvironmentVariable($traceVariable, $trace, 'Process')
        }
        $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally {
        [Environment]::SetEnvironmentVariable($traceVariable, $previousTrace, 'Process')
    }
    $null = $process.Handle
    if (!$process.WaitForExit(180000)) {
        $process.Kill()
        throw "$Label exceeded 180 seconds"
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne $ExpectedExitCode) { throw "$Label exited with $($process.ExitCode), expected ${ExpectedExitCode}; inspect its captured logs" }
    return $stdout
}
function With-NodeStartupOptions([scriptblock]$Check) {
    # Scoped process-only fixture, never a user/machine setting. Restore on failure too.
    $missingPreload = Join-Path $OutputDirectory 'nootify-smoke-missing-preload.cjs'
    if (Test-Path -LiteralPath $missingPreload) { throw 'Refusing an existing preload fixture path' }
    $values = @{
        NODE_OPTIONS = '--require="' + $missingPreload.Replace('\', '/') + '"'
        NODE_PATH = (Join-Path $OutputDirectory 'missing-node-modules')
    }
    $saved = @{}
    try {
        foreach ($name in $values.Keys) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $values[$name], 'Process')
        }
        & $Check
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}
function Invoke-Service([string]$Action) {
    $arguments = '"' + $cli + '" service-' + $Action
    $path = Run-Native $node $arguments "service-$Action"
    return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
}
function Start-TestApp {
    $script:launches++
    $process = Start-Process -FilePath $app -WorkingDirectory $installDir -PassThru -RedirectStandardOutput (Join-Path $OutputDirectory "app-$launches.stdout.log") -RedirectStandardError (Join-Path $OutputDirectory "app-$launches.stderr.log")
    $null = $process.Handle
    return $process
}
function Assert-Installation([string]$ExpectedVersion) {
    foreach ($path in @($app, $node, $cli, $server, $uninstaller, (Join-Path $installDir 'nootify-tsnet.exe'), (Join-Path $installDir 'nootify-core.exe'), (Join-Path $installDir 'service\windows\service-runner.cs'), (Join-Path $installDir 'service\windows\inbox-auth.ps1'), (Join-Path $installDir 'service\windows\inbox-auth.cs'))) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Installed payload is missing $path" }
    }
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($app).ProductVersion -cne $ExpectedVersion) {
        throw "Installed executable does not contain version $ExpectedVersion"
    }
    $registration = Get-ItemProperty -LiteralPath $registryKey
    if ($registration.DisplayVersion -cne $ExpectedVersion -or !(Same-Path $registration.InstallLocation.Trim('"') $installDir)) {
        throw "Unexpected per-user install registration; expected version $ExpectedVersion in the smoke directory"
    }
}
function Assert-RunningTask {
    # HTTP can be ready before Scheduler publishes the running-instance snapshot.
    # Require the exact singleton contract, but wait for both startup signals.
    $ready = [pscustomobject]@{ Task = $null }
    Wait-Until 'exactly one running user task' {
        $candidate = Get-TestTask
        if (!$candidate) { throw 'The installed task is not registered yet' }
        $count = Get-TestInstanceCount
        if ($count -ne 1) { throw "Expected one instance; visible=$count; state=$($candidate.State); lastResult=$($candidate.LastTaskResult)" }
        $ready.Task = $candidate
        return $true
    }
    $task = $ready.Task
    $definition = $task.Definition
    if ($definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0) { throw 'The service must use an interactive, unelevated user task' }
    if (!(Invoke-Service 'status').installed) { throw 'The installed CLI does not recognize its task' }
    $null = Get-ServiceProcess
}
function Uninstall-TestApp([string]$Label) {
    Stop-TestApps
    $null = Run-Native $uninstaller '/S' $Label
    # NSIS normally copies its uninstaller to TEMP; wait for the actual removal too.
    Wait-Until 'uninstaller removes payload, registration, task and listener' {
        !(Test-Path -LiteralPath $app) -and !(Test-Path -LiteralPath $node) -and
        !(Test-Path -LiteralPath $registryKey) -and !(Get-TestTask) -and (Test-PortFree)
    }
    Wait-Until 'uninstaller and installed process tree exit' { @(Get-InstallProcesses).Count -eq 0 }
    if (@(Get-TestApps).Count -ne 0) { throw 'An installed desktop process survived uninstall' }
}
function Capture-Diagnostics {
    foreach ($name in @('stdout.log', 'stderr.log')) {
        $path = Join-Path $stateDir $name
        if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $OutputDirectory "service-$name") }
    }
    $task = Get-TestTask
    $diagnostic = @{ phase = $phase; task_present = [bool]$task; port_free = Test-PortFree; app_pids = @((Get-TestApps) | ForEach-Object { $_.ProcessId }) }
    if ($task) {
        $diagnostic['task_state'] = $task.State
        $diagnostic['last_task_result'] = $task.LastTaskResult
        $diagnostic['task_hidden'] = $task.Definition.Settings.Hidden
        $diagnostic['task_logon_type'] = $task.Definition.Principal.LogonType
        $diagnostic['task_run_level'] = $task.Definition.Principal.RunLevel
        try { $diagnostic['registered_task_instance_count'] = $task.GetInstances(0).Count }
        catch { $diagnostic['instance_query_hresult'] = $_.Exception.HResult }
        try {
            $running = $scheduler.GetRunningTasks(1) # TASK_ENUM_HIDDEN; filter to this exact owned task path.
            $matching = 0
            for ($index = 1; $index -le $running.Count; $index++) {
                if ([string]::Equals([string]$running.Item($index).Path, [string]$task.Path, [StringComparison]::OrdinalIgnoreCase)) { $matching++ }
            }
            $diagnostic['hidden_inclusive_instance_count'] = $matching
        } catch { $diagnostic['hidden_query_hresult'] = $_.Exception.HResult }
    }
    $diagnostic | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'diagnostics.json') -Encoding UTF8
}

try {
    Test-Step 'Fresh disposable runner' {
        if ($Installer -eq $BaselineInstaller -or $Version -eq $BaselineVersion) { throw 'Upgrade testing requires distinct installer versions' }
        if ((Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $stateDir) -or (Test-Path -LiteralPath $registryKey) -or (Get-TestTask) -or !(Test-PortFree)) {
            throw 'Refusing to alter a pre-existing Nootify installation, task, state or listener'
        }
        if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.claude.json')) { throw 'Refusing to import a pre-existing user MCP configuration' }
        $script:ownsTestState = $true
    }
    Test-Step 'Fresh installer recovers an interrupted unregistered exchange with its pending receipt' {
        $pendingKey = 'HKCU:\Software\Nootify\PendingInstaller'
        if (Test-Path -LiteralPath $pendingKey) { throw 'Refusing an existing pending installation receipt' }
        $token = [Guid]::NewGuid().ToString('B')
        # Registry New-Item does not create missing parents on a pristine runner.
        # Create only the absent parent; preserve any existing values and keep
        # the leaf creation non-forcing so a pre-existing receipt still fails.
        $pendingParent = Split-Path -Parent $pendingKey
        if (!(Test-Path -LiteralPath $pendingParent)) { $null = New-Item -Path $pendingParent }
        $null = New-Item -Path $pendingKey
        $null = New-ItemProperty -LiteralPath $pendingKey -Name Target -Value $installDir -PropertyType String
        $null = New-ItemProperty -LiteralPath $pendingKey -Name Token -Value $token -PropertyType String
        $transaction = Join-Path $installDir '.nootify-installer'
        foreach ($name in @('new', 'old', 'discard')) { $null = New-Item -ItemType Directory -Path (Join-Path $transaction $name) }
        [IO.File]::WriteAllText($app, 'interrupted fresh payload owned by this smoke fixture')
        @{ version = 1; target = $installDir; phase = 'exchanging'; previous = @(); running = $false; fresh_token = $token } |
            ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $transaction 'journal.json') -Encoding ASCII
        # The following baseline install must recover this state without a stable
        # InstallLocation yet, then remove the pending receipt only after commit.
    }
    Test-Step 'Silent install of the baseline package into a path with spaces' {
        # NSIS /D must be the last argument, without quotes around its path.
        $null = Run-Native $BaselineInstaller "/S /D=$installDir" 'install-baseline'
        Assert-Installation $BaselineVersion
        if (Test-Path -LiteralPath 'HKCU:\Software\Nootify\PendingInstaller') { throw 'Committed installation retained its pending receipt' }
    }
    Test-Step 'Installer diagnostics retain phase and helper evidence without private data' {
        $traces = @(Get-ChildItem -LiteralPath $OutputDirectory -Directory -Filter 'installer-install-baseline-*')
        if ($traces.Count -ne 1) { throw 'Baseline installer diagnostic directory is missing or ambiguous' }
        $phases = [IO.File]::ReadAllText((Join-Path $traces[0].FullName 'nsis-phases.log'))
        if ($phases -notmatch 'helper-apply-success' -or $phases -notmatch 'installation-success') {
            throw 'NSIS did not preserve its successful phase markers'
        }
        $reports = @(Get-ChildItem -LiteralPath $traces[0].FullName -File -Filter 'helper-*.jsonl')
        if ($reports.Count -lt 3) { throw 'Installer helper diagnostic reports are missing' }
        $actions = @{}
        foreach ($report in $reports) {
            foreach ($line in [IO.File]::ReadAllLines($report.FullName)) {
                $event = $line | ConvertFrom-Json
                if ($event.version -ne 1 -or $event.outcome -notin @('begin', 'success', 'failure')) {
                    throw 'Invalid installer helper diagnostic event'
                }
                if ($event.outcome -eq 'success') { $actions[[string]$event.action] = $true }
                if ($line.Contains($installDir) -or $line.Contains($stateDir) -or $line.Contains($env:USERPROFILE)) {
                    throw 'Installer diagnostics exposed a private path'
                }
            }
        }
        foreach ($action in @('prepare', 'apply', 'finish')) {
            if (!$actions.ContainsKey($action)) { throw "Installer helper did not report $action completion" }
        }
    }
    Test-Step 'Installed desktop starts its real service and one user task' {
        $script:desktop = Start-TestApp
        Wait-Until 'first-launch daemon health' { Test-Health }
        Assert-RunningTask
        $script:daemon = Get-ServiceProcess
        $script:tokenHash = (Get-FileHash -LiteralPath (Join-Path $stateDir 'auth-token') -Algorithm SHA256).Hash
        $script:marker = [Guid]::NewGuid().ToString()
        [IO.File]::WriteAllText((Join-Path $stateDir 'install-smoke-marker'), $marker)
        # A task data marker detects an update that deletes and recreates the task.
        $definition = (Get-TestTask).Definition
        $definition.Data = $marker
        $null = $scheduler.GetFolder('\').RegisterTaskDefinition($taskName, $definition, 4, $sid, $null, 3, $null)
    }
    Test-Step 'Opening a second instance reuses the desktop and daemon' {
        $second = Start-TestApp
        if (!$second.WaitForExit(15000) -or $second.ExitCode -ne 0) { throw 'The second desktop instance did not exit cleanly' }
        if ($desktop.HasExited -or (Get-ServiceProcess).Id -ne $daemon.Id) { throw 'Reopening replaced the existing desktop or service' }
        Assert-RunningTask
    }
    Test-Step 'Locked desktop aborts normal and updater installs before changing files or service' {
        $before = @{}
        foreach ($path in @($app, $node, $cli, $server, (Join-Path $installDir 'nootify-core.exe'), (Join-Path $installDir 'nootify-tsnet.exe'))) {
            $before[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        }
        # A real Windows sharing lock guarantees GENERIC_WRITE is rejected even
        # if a future desktop runtime changes how it maps its executable image.
        $lock = [IO.File]::Open($app, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $watch = [Diagnostics.Stopwatch]::StartNew()
            $null = Run-Native $Installer "/S /D=$installDir" 'locked-normal-install' 1
            if ($watch.Elapsed.TotalSeconds -gt 15) { throw 'Normal installation did not abort promptly for a locked desktop' }
            $watch.Restart()
            $null = Run-Native $Installer "/S /UPDATE /R /D=$installDir" 'locked-updater-install' 1
            if ($watch.Elapsed.TotalSeconds -lt 15 -or $watch.Elapsed.TotalSeconds -gt 45) { throw 'Updater lock wait was not bounded near the 20-second handoff deadline' }
            foreach ($path in $before.Keys) {
                if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $before[$path]) { throw 'A locked upgrade changed installed files' }
            }
            if ($desktop.HasExited -or $daemon.HasExited -or !(Test-Health) -or (Get-ServiceProcess).Id -ne $daemon.Id) {
                throw 'A locked upgrade stopped the existing desktop or service'
            }
            Assert-Installation $BaselineVersion
            Assert-RunningTask
            if ((Get-TestTask).Definition.Data -cne $marker) { throw 'A locked upgrade changed the registered task' }
        } finally { $lock.Dispose() }
    }
    Test-Step 'Daemon remains healthy after desktop exit and reopening' {
        Stop-TestApps
        Start-Sleep -Milliseconds 750
        if (!(Test-Health) -or $daemon.HasExited) { throw 'Desktop exit stopped the independent service' }
        $script:desktop = Start-TestApp
        Wait-Until 'reopened desktop' { @(Get-TestApps).Count -eq 1 }
        if ((Get-ServiceProcess).Id -ne $daemon.Id) { throw 'Reopening restarted the healthy daemon' }
        Stop-TestApps
    }
    Test-Step 'Installed Node rejects the inherited preload without installer sanitization' {
        With-NodeStartupOptions {
            $null = Run-Native $node '-e "process.exit(0)"' 'node-options-control' 1
            $errorText = Get-Content -LiteralPath (Join-Path $OutputDirectory 'node-options-control.stderr.log') -Raw
            if ($errorText -notmatch 'MODULE_NOT_FOUND' -or $errorText -notmatch 'nootify-smoke-missing-preload\.cjs') {
                throw 'The Node startup control did not reject the missing preload fixture'
            }
        }
    }
    Test-Step 'Changed installation destination refuses before touching the registered installation' {
        $other = Join-Path $env:RUNNER_TEMP 'Nootify refused destination'
        if (Test-Path -LiteralPath $other) { throw 'Refusing an existing alternate installation fixture' }
        $registrationBefore = Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress
        $previous = Get-ServiceProcess
        $null = Run-Native $Installer "/S /D=$other" 'refuse-changed-destination' 1
        if ((Test-Path -LiteralPath $other) -or $previous.HasExited -or !(Test-Health) -or
            (Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress) -cne $registrationBefore) {
            throw 'Changed destination modified the original installation or created another payload'
        }
        Assert-Installation $BaselineVersion
        Assert-RunningTask
    }
    Test-Step 'Normal silent upgrade restores a legacy-status service without relaunching the desktop' {
        # Match published older CLIs whose Status JSON contains only installed.
        # Keep real service management and its ownership checks for every action.
        $legacyCLI = Join-Path (Split-Path -Parent $cli) 'cli-smoke-original.js'
        if (Test-Path -LiteralPath $legacyCLI) { throw 'Refusing an existing legacy CLI fixture path' }
        Copy-Item -LiteralPath $cli -Destination $legacyCLI
        [IO.File]::WriteAllText($cli, @'
import { main } from './cli-smoke-original.js';
import { manageService } from './service.js';
await main(process.argv.slice(2), async (action, options) => {
  const result = await manageService(action, options);
  if (action === 'status') delete result.running;
  return result;
});
'@)
        $previous = Get-ServiceProcess
        With-NodeStartupOptions { $null = Run-Native $Installer "/S /D=$installDir" 'upgrade-normal-no-relaunch' }
        Wait-Until 'normal upgrade restores daemon without desktop' { (Test-Health) -and @(Get-TestApps).Count -eq 0 }
        Assert-Installation $Version
        if (!$previous.WaitForExit(10000)) { throw 'Normal upgrade did not replace the old daemon' }
        Assert-RunningTask
        if ((Get-TestTask).Definition.Data -cne $marker) { throw 'Normal upgrade recreated the registered task' }
        $script:daemon = Get-ServiceProcess
    }
    Test-Step 'Payload exchange failure rolls back old bytes and the running service' {
        $before = @{}
        foreach ($file in @(Get-ChildItem -LiteralPath $installDir -Recurse -File)) {
            $before[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }
        $registrationBefore = Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress
        # Deny FILE_SHARE_DELETE on node.exe. Extraction can still succeed in
        # staging, but moving this old root fails after Nootify.exe was exchanged.
        $lock = [IO.File]::Open($node, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { $null = Run-Native $Installer "/S /D=$installDir" 'rollback-locked-runtime' 1 }
        finally { $lock.Dispose() }
        Wait-Until 'rollback restores old daemon without desktop' { (Test-Health) -and @(Get-TestApps).Count -eq 0 }
        foreach ($path in $before.Keys) {
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $before[$path]) { throw 'Failed exchange did not restore old payload bytes' }
        }
        if ((Test-Path -LiteralPath (Join-Path $installDir '.nootify-installer')) -or
            (Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress) -cne $registrationBefore) { throw 'Failed exchange did not finish rollback' }
        Assert-RunningTask
        if ((Get-TestTask).Definition.Data -cne $marker) { throw 'Rollback recreated the registered task' }
        $script:daemon = Get-ServiceProcess
    }
    Test-Step 'Normal silent upgrade preserves a deliberately stopped service' {
        $null = Invoke-Service 'stop'
        Wait-Until 'explicitly stopped task and daemon' { (Get-TestInstanceCount) -eq 0 -and (Test-PortFree) }
        $null = Run-Native $Installer "/S /D=$installDir" 'upgrade-stopped-no-relaunch'
        Assert-Installation $Version
        if ((Get-TestTask).Enabled -or (Get-TestInstanceCount) -ne 0 -or !(Test-PortFree) -or @(Get-TestApps).Count -ne 0) {
            throw 'Upgrade started or enabled a deliberately stopped service'
        }
        $null = Invoke-Service 'start'
        Wait-Until 'explicit service start after stopped upgrade' { Test-Health }
        Assert-RunningTask
        $script:daemon = Get-ServiceProcess
    }
    Test-Step 'Normal upgrade retains an enabled idle task without starting it' {
        $null = Invoke-Service 'stop'
        Wait-Until 'idle task has no running instance' { (Get-TestInstanceCount) -eq 0 -and (Test-PortFree) }
        (Get-TestTask).Enabled = $true
        $null = Run-Native $Installer "/S /D=$installDir" 'upgrade-enabled-idle'
        Assert-Installation $Version
        if (!(Get-TestTask).Enabled -or (Get-TestInstanceCount) -ne 0 -or !(Test-PortFree) -or @(Get-TestApps).Count -ne 0) {
            throw 'Upgrade disabled or started an enabled idle task'
        }
        if ((Get-TestTask).Definition.Data -cne $marker) { throw 'Idle-task upgrade recreated task identity' }
        $status = Invoke-Service 'status'
        if (!$status.enabled -or $status.running) { throw 'Status did not distinguish enabled and running task state' }
        $null = Invoke-Service 'start'
        Wait-Until 'explicit start after idle task upgrade' { Test-Health }
        Assert-RunningTask
        $script:daemon = Get-ServiceProcess
    }
    Test-Step 'Updater-mode upgrade ignores inherited Node options and relaunches the desktop' {
        With-NodeStartupOptions { $null = Run-Native $Installer "/S /UPDATE /R /D=$installDir" 'upgrade-current' }
        Wait-Until 'upgraded app and daemon' { (Test-Health) -and @(Get-TestApps).Count -eq 1 }
        Assert-Installation $Version
        if (!$daemon.WaitForExit(10000)) { throw 'The old daemon survived replacement' }
        Assert-RunningTask
        if ((Get-TestTask).Definition.Data -cne $marker) { throw 'Upgrade did not preserve the existing scheduled task' }
        if ([IO.File]::ReadAllText((Join-Path $stateDir 'install-smoke-marker')) -cne $marker -or
            (Get-FileHash -LiteralPath (Join-Path $stateDir 'auth-token') -Algorithm SHA256).Hash -cne $tokenHash) { throw 'Upgrade did not preserve private state' }
    }
    Test-Step 'Legacy passive updater closes without input and relaunches from the registered directory' {
        Stop-TestApps
        $previous = Get-ServiceProcess
        # Exact Tauri installMode=passive invocation: /S would hide page bugs,
        # and /D would hide a failure to reuse the registered path with spaces.
        # Run-Native waits for exit without sending UI input or clicking Close.
        With-NodeStartupOptions { $null = Run-Native $Installer '/P /UPDATE /R' 'upgrade-legacy-passive' }
        Wait-Until 'passively updated app and daemon' { (Test-Health) -and @(Get-TestApps).Count -eq 1 }
        Assert-Installation $Version
        if (!$previous.WaitForExit(10000)) { throw 'The old daemon survived the passive update' }
        Assert-RunningTask
        if ((Get-TestTask).Definition.Data -cne $marker) { throw 'Passive update did not preserve the existing scheduled task' }
        if ([IO.File]::ReadAllText((Join-Path $stateDir 'install-smoke-marker')) -cne $marker -or
            (Get-FileHash -LiteralPath (Join-Path $stateDir 'auth-token') -Algorithm SHA256).Hash -cne $tokenHash) { throw 'Passive update did not preserve private state' }
    }
    Test-Step 'Installed CLI restarts immediately with an accepted keep-alive connection' {
        $previous = Get-ServiceProcess
        $browser = [Net.Sockets.TcpClient]::new('127.0.0.1', 9417)
        try {
            $stream = $browser.GetStream(); $stream.ReadTimeout = 5000
            $request = [Text.Encoding]::ASCII.GetBytes("GET /health HTTP/1.1`r`nHost: 127.0.0.1:9417`r`nConnection: keep-alive`r`n`r`n")
            $stream.Write($request, 0, $request.Length)
            $buffer = New-Object byte[] 4096
            if ($stream.Read($buffer, 0, $buffer.Length) -eq 0) { throw 'The service did not accept the keep-alive request' }
            # Leave the client open while Stop closes the daemon's accepted socket.
            $null = Invoke-Service 'restart'
            if (!$previous.WaitForExit(10000) -or !(Test-Health) -or (Get-ServiceProcess).Id -eq $previous.Id) { throw 'Service restart did not replace the daemon cleanly' }
            Assert-RunningTask
        } finally { $browser.Dispose() }
    }
    Test-Step 'Active desktop refuses silent uninstall before changing files, task or registration' {
        $apps = @(Get-TestApps)
        if ($apps.Count -ne 1) { throw 'Expected one active desktop before the uninstall refusal probe' }
        $activeDesktop = Get-Process -Id $apps[0].ProcessId
        $null = $activeDesktop.Handle # Retain the exact desktop identity across the probe.
        $activeDaemon = Get-ServiceProcess
        $before = @{}
        foreach ($file in @(Get-ChildItem -LiteralPath $installDir -Recurse -File)) {
            $before[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }
        $registrationBefore = Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress
        $taskBefore = (Get-TestTask).Xml
        $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nootify.lnk'
        $shortcutBefore = (Get-FileHash -LiteralPath $shortcut -Algorithm SHA256).Hash
        # Probe the actual mapped desktop image, without an extra file-sharing lock.
        # _?= must be last and unquoted: keep the uninstaller synchronous so its
        # refusal exit code is checked rather than the temporary handoff's result.
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $null = Run-Native $uninstaller "/S _?=$installDir" 'active-desktop-uninstall' 1
        if ($watch.Elapsed.TotalSeconds -gt 15) { throw 'Silent uninstall did not refuse the active desktop promptly' }
        if (@(Get-ChildItem -LiteralPath $installDir -Recurse -File).Count -ne $before.Count) {
            throw 'Refused uninstall added or removed installed files'
        }
        foreach ($path in $before.Keys) {
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $before[$path]) { throw 'Refused uninstall changed installed files' }
        }
        if ($activeDesktop.HasExited -or $activeDaemon.HasExited -or !(Test-Health) -or
            (Get-ServiceProcess).Id -ne $activeDaemon.Id) { throw 'Refused uninstall stopped the desktop or independent service' }
        Assert-Installation $Version
        Assert-RunningTask
        if ((Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress) -cne $registrationBefore -or
            (Get-TestTask).Xml -cne $taskBefore -or
            (Get-FileHash -LiteralPath $shortcut -Algorithm SHA256).Hash -cne $shortcutBefore) {
            throw 'Refused uninstall changed registration, the owned task or the shortcut'
        }
        if ([IO.File]::ReadAllText((Join-Path $stateDir 'install-smoke-marker')) -cne $marker -or
            (Get-FileHash -LiteralPath (Join-Path $stateDir 'auth-token') -Algorithm SHA256).Hash -cne $tokenHash) {
            throw 'Refused uninstall changed private state'
        }
    }
    Test-Step 'Locked independent runtime preserves uninstaller registration and management payload for retry' {
        Stop-TestApps
        $before = @{}
        foreach ($file in @(Get-ChildItem -LiteralPath $installDir -Recurse -File)) {
            $before[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }
        $registrationBefore = Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress
        $lock = [IO.File]::Open($node, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { $null = Run-Native $uninstaller "/S _?=$installDir" 'locked-runtime-uninstall' 1 }
        finally { $lock.Dispose() }
        foreach ($path in $before.Keys) {
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $before[$path]) { throw 'Failed uninstall did not restore the retryable payload layout' }
        }
        if ((Get-ItemProperty -LiteralPath $registryKey | ConvertTo-Json -Compress) -cne $registrationBefore -or
            !(Test-Path -LiteralPath $uninstaller) -or (Test-Path -LiteralPath (Join-Path $installDir '.nootify-installer'))) {
            throw 'Failed uninstall lost registration, uninstaller or completed quarantine rollback'
        }
        if ((Get-TestTask) -or !(Test-PortFree)) { throw 'Owned service uninstall did not complete before the independent lock refusal' }
    }
    Test-Step 'Silent uninstall after desktop exit ignores inherited Node options and keeps private data' {
        With-NodeStartupOptions { Uninstall-TestApp 'uninstall-current' }
        if ([IO.File]::ReadAllText((Join-Path $stateDir 'install-smoke-marker')) -cne $marker -or
            (Get-FileHash -LiteralPath (Join-Path $stateDir 'auth-token') -Algorithm SHA256).Hash -cne $tokenHash) { throw 'Uninstall removed private state' }
    }
    Test-Step 'Current package reinstalls after uninstall' {
        $null = Run-Native $Installer "/S /D=$installDir" 'reinstall-current'
        Assert-Installation $Version
        $script:desktop = Start-TestApp
        Wait-Until 'reinstalled daemon health' { Test-Health }
        Assert-RunningTask
        if ((Get-FileHash -LiteralPath (Join-Path $stateDir 'auth-token') -Algorithm SHA256).Hash -cne $tokenHash) { throw 'Reinstall replaced the retained authentication state' }
        Uninstall-TestApp 'uninstall-reinstalled'
    }
} catch {
    $failure = $_.Exception.Message
    Write-Warning "Install smoke failed in ${phase}: $failure"
} finally {
    if ($ownsTestState) {
        try { Capture-Diagnostics } catch { Write-Warning "Could not capture diagnostics: $($_.Exception.Message)" }
        try {
            Stop-TestApps
            if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $cli)) { $null = Invoke-Service 'uninstall' }
            if (Test-Path -LiteralPath $uninstaller) { Uninstall-TestApp 'cleanup-uninstall' }
        } catch {
            if (!$failure) { $failure = "Smoke cleanup failed: $($_.Exception.Message)" }
            Write-Warning "Smoke cleanup failed: $($_.Exception.Message)"
        }
        # No settings/auth-token are uploaded. Keep only allowlisted service logs and summaries.
    }
    @{ result = $(if ($failure) { 'failed' } else { 'passed' }); steps = @($results.ToArray()); error = $failure } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'summary.json') -Encoding UTF8
    if ($env:GITHUB_STEP_SUMMARY) {
        @('### Windows installation smoke test', '') + @($results | ForEach-Object { "- $($_.result): $($_.name) ($($_.seconds)s)" }) |
            Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
    }
}
if ($failure) { throw $failure }
Write-Host 'Windows installation, upgrade, service recovery and uninstall smoke passed.'
