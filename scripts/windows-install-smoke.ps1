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
    try { $listener.ExclusiveAddressUse = $true; $listener.Start(); return $true }
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
function Run-Native([string]$File, [string]$Arguments, [string]$Label) {
    $stdout = Join-Path $OutputDirectory "$Label.stdout.log"
    $stderr = Join-Path $OutputDirectory "$Label.stderr.log"
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $process.Handle
    if (!$process.WaitForExit(180000)) {
        $process.Kill()
        throw "$Label exceeded 180 seconds"
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "$Label exited with $($process.ExitCode); inspect its captured logs" }
    return $stdout
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
    foreach ($path in @($app, $node, $cli, $server, $uninstaller, (Join-Path $installDir 'nootify-tsnet.exe'), (Join-Path $installDir 'service\windows\service-runner.cs'))) {
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
    $task = Get-TestTask
    if (!$task -or $task.GetInstances(0).Count -ne 1) { throw 'Expected exactly one running user task' }
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
    if ($task) { $diagnostic['task_state'] = $task.State; $diagnostic['last_task_result'] = $task.LastTaskResult }
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
    Test-Step 'Silent install of the baseline package into a path with spaces' {
        # NSIS /D must be the last argument, without quotes around its path.
        $null = Run-Native $BaselineInstaller "/S /D=$installDir" 'install-baseline'
        Assert-Installation $BaselineVersion
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
    Test-Step 'Daemon remains healthy after desktop exit and reopening' {
        Stop-TestApps
        Start-Sleep -Milliseconds 750
        if (!(Test-Health) -or $daemon.HasExited) { throw 'Desktop exit stopped the independent service' }
        $script:desktop = Start-TestApp
        Wait-Until 'reopened desktop' { @(Get-TestApps).Count -eq 1 }
        if ((Get-ServiceProcess).Id -ne $daemon.Id) { throw 'Reopening restarted the healthy daemon' }
        Stop-TestApps
    }
    Test-Step 'Updater-mode upgrade replaces running files and relaunches the desktop' {
        $null = Run-Native $Installer "/S /UPDATE /R /D=$installDir" 'upgrade-current'
        Wait-Until 'upgraded app and daemon' { (Test-Health) -and @(Get-TestApps).Count -eq 1 }
        Assert-Installation $Version
        if (!$daemon.WaitForExit(10000)) { throw 'The old daemon survived replacement' }
        Assert-RunningTask
        if ((Get-TestTask).Definition.Data -cne $marker) { throw 'Upgrade did not preserve the existing scheduled task' }
        if ([IO.File]::ReadAllText((Join-Path $stateDir 'install-smoke-marker')) -cne $marker -or
            (Get-FileHash -LiteralPath (Join-Path $stateDir 'auth-token') -Algorithm SHA256).Hash -cne $tokenHash) { throw 'Upgrade did not preserve private state' }
    }
    Test-Step 'Installed CLI can restart the actual task' {
        $previous = Get-ServiceProcess
        $null = Invoke-Service 'restart'
        if (!$previous.WaitForExit(10000) -or !(Test-Health) -or (Get-ServiceProcess).Id -eq $previous.Id) { throw 'Service restart did not replace the daemon cleanly' }
        Assert-RunningTask
    }
    Test-Step 'Silent uninstall removes the real task and listener but keeps data' {
        Uninstall-TestApp 'uninstall-current'
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
