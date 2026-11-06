# Runs on Windows without registering, stopping, or changing any real Scheduled Task.
param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
function Assert($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Must-Fail([scriptblock]$Code, [string]$Message) {
    $failed = $false
    try { $null = & $Code } catch { $failed = $true }
    Assert $failed $Message
}
function Wait-File([string]$Path) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $Path)) {
        if ($watch.ElapsedMilliseconds -ge 10000) { throw "Fixture did not publish $Path" }
        Start-Sleep -Milliseconds 10
    }
}
$serviceScript = Join-Path $PSScriptRoot 'service.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($serviceScript, [ref]$tokens, [ref]$errors)
Assert ($errors.Count -eq 0) ($errors | Out-String)
# Load only function definitions. The production script's top-level management flow never runs here.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
Assert (Same-Path '\\?\C:\Nootify Test\node.exe' 'C:\Nootify Test\node.exe') 'Canonical namespace and DOS paths must identify the same installation'
Assert (Same-Path '\\?\UNC\server\share\node.exe' '\\server\share\node.exe') 'Canonical namespace and UNC paths must identify the same installation'
Assert (!(Same-Path '\\?\C:\Nootify Test\node.exe' 'C:\Other\node.exe')) 'Namespace normalization must not broaden ownership to another installation'
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = "Nootify.Service.$ownerSid"
$descriptionPrefix = 'Nootify per-user service v1: '
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$scriptPath = [IO.Path]::GetFullPath($serviceScript)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$ServerPath = 'C:\Nootify Test\server.js'
$StateDir = 'C:\Nootify Test\state'
$McpConfig = "C:\Users\O'Brien\MCP settings.json"
$Port = 9517
$record = [pscustomobject]@{ version = 1; sid = $ownerSid; script = $scriptPath; node = $NodePath; server = $ServerPath; state = $StateDir; port = $Port; mcp = $McpConfig }
$entry = [pscustomobject]@{ Type = 0; Path = $powerShell; Arguments = (Run-Arguments $record); WorkingDirectory = $StateDir }
$actions = [pscustomobject]@{ Count = 1; Entry = $entry }
$actions | Add-Member ScriptMethod Item { param($Index); Assert ($Index -eq 1) 'COM actions are one-based'; return $this.Entry }
$principal = [pscustomobject]@{ UserId = $ownerSid; LogonType = 3; RunLevel = 0 }
$definition = [pscustomobject]@{ RegistrationInfo = [pscustomobject]@{ Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress) }; Actions = $actions; Principal = $principal }
$task = [pscustomobject]@{ Definition = $definition; Enabled = $true; Starts = 0; Stops = 0; Instances = 1 }
$task | Add-Member ScriptMethod GetInstances { param($Flags); return [pscustomobject]@{ Count = $this.Instances } }
$task | Add-Member ScriptMethod Run { param($Args); $this.Starts++; $this.Instances = 1 }
$task | Add-Member ScriptMethod Stop { param($Flags); $this.Stops++; $this.Instances = 0 }
$null = Assert-Owned $task
Assert ($entry.Arguments.Contains('"C:\Nootify Test\server.js"')) 'Space-containing paths must stay one argument'
Assert ($entry.Arguments.Contains('"C:\Users\O''Brien\MCP settings.json"')) 'Apostrophes must remain literal in -File arguments'
Assert ((Quote-Argument 'C:\directory\') -eq '"C:\directory\\"') 'Trailing slashes must not escape the closing quote'
foreach ($field in @('script', 'node', 'server', 'state')) {
    $before = $record.$field; $record.$field = 'C:\Unrelated\file'
    $definition.RegistrationInfo.Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress)
    Must-Fail { Assert-Owned $task } "Changed $field must fail ownership"
    $record.$field = $before
}
$definition.RegistrationInfo.Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress)
$before = $entry.Arguments; $entry.Arguments += ' -OtherCommand injected'
Must-Fail { Assert-Owned $task } 'Changed task action must fail ownership'
$entry.Arguments = $before
$principal.RunLevel = 1
Must-Fail { Assert-Owned $task } 'An elevated task must fail ownership'
$principal.RunLevel = 0; $principal.LogonType = 1
Must-Fail { Assert-Owned $task } 'A password/service-account task must fail ownership'
$principal.LogonType = 3
$definition.RegistrationInfo.Description = 'Another application'
Must-Fail { Assert-Owned $task } 'Matching task name alone is not ownership'
$definition.RegistrationInfo.Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress)

# The live service is reused: Start must not even check/bind the occupied port or launch a receiver.
function Invoke-RestMethod { param($Uri, $TimeoutSec, $MaximumRedirection); return [pscustomobject]@{ service = 'nootify' } }
$realPortCheck = ${function:Assert-PortFree}
function Assert-PortFree { throw 'Already-running Start must not bind its port' }
Start-OwnedTask $task
Assert ($task.Starts -eq 0) 'Repeated starts must not create another process'
${function:Assert-PortFree} = $realPortCheck
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $Port = $listener.LocalEndpoint.Port
try { Must-Fail { Assert-PortFree } 'An occupied port must reject initial installation' } finally { $listener.Stop() }
Assert-PortFree

# An accepted connection actively closed by the server leaves its local port in
# TIME_WAIT. Match a real Node listener (neither exclusive nor reuse enabled).
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.ExclusiveAddressUse = $false
$listener.Server.SetSocketOption([Net.Sockets.SocketOptionLevel]::Socket, [Net.Sockets.SocketOptionName]::ReuseAddress, $false)
$listener.Start(); $Port = $listener.LocalEndpoint.Port
$client = [Net.Sockets.TcpClient]::new()
$accepted = $null
try {
    Must-Fail { Assert-PortFree } 'A live Node-style listener must not be stolen'
    $client.Connect([Net.IPAddress]::Loopback, $Port)
    $remotePort = $client.Client.LocalEndPoint.Port
    $accepted = $listener.AcceptTcpClient()
    $accepted.Close(); $accepted = $null # Server sends FIN first.
    $client.GetStream().ReadTimeout = 3000
    Assert ($client.GetStream().ReadByte() -eq -1) 'The client must observe the server FIN'
    $client.Close(); $listener.Stop()
    $until = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $timeWait = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpConnections() | Where-Object {
            $_.LocalEndPoint.Port -eq $Port -and $_.RemoteEndPoint.Port -eq $remotePort -and $_.State -eq [Net.NetworkInformation.TcpState]::TimeWait
        })
        if ($timeWait.Count) { break }
        Start-Sleep -Milliseconds 10
    } while ([DateTime]::UtcNow -lt $until)
    Assert ($timeWait.Count -gt 0) 'The accepted-connection fixture must retain server-side TIME_WAIT'
    Assert-PortFree # No waiting for TCP state to expire.
    & $NodePath -e "const server=require('node:net').createServer();server.once('error',()=>{process.exitCode=1});server.listen({host:'127.0.0.1',port:Number(process.argv[1])},()=>server.close());" $Port
    Assert ($LASTEXITCODE -eq 0) 'Bundled Node must be able to bind immediately after the probe'
} finally {
    if ($accepted) { $accepted.Dispose() }
    $client.Dispose(); $listener.Stop()
}
$Port = $record.port

# Capture a task definition against a fake scheduler instead of registering anything.
$createdEntry = [pscustomobject]@{ Path = ''; Arguments = ''; WorkingDirectory = '' }
$newActions = [pscustomobject]@{ Entry = $createdEntry }
$newActions | Add-Member ScriptMethod Create { param($Kind); Assert ($Kind -eq 0) 'Only exec actions'; return $this.Entry }
$createdTrigger = [pscustomobject]@{ UserId = ''; Enabled = $false }
$triggers = [pscustomobject]@{ Entry = $createdTrigger }
$triggers | Add-Member ScriptMethod Create { param($Kind); Assert ($Kind -eq 9) 'Only a logon trigger'; return $this.Entry }
$settings = [pscustomobject]@{ Enabled = $false; Hidden = $false; AllowDemandStart = $false; AllowHardTerminate = $false; MultipleInstances = 0; DisallowStartIfOnBatteries = $true; StopIfGoingOnBatteries = $true; RunOnlyIfIdle = $true; IdleSettings = [pscustomobject]@{ StopOnIdleEnd = $true }; RunOnlyIfNetworkAvailable = $true; StartWhenAvailable = $false; ExecutionTimeLimit = ''; RestartInterval = ''; RestartCount = 0 }
$newDefinition = [pscustomobject]@{ RegistrationInfo = [pscustomobject]@{ Description = '' }; Principal = [pscustomobject]@{ UserId = ''; LogonType = 0; RunLevel = 1 }; Actions = $newActions; Triggers = $triggers; Settings = $settings }
$folder = [pscustomobject]@{ Registered = $false }
$folder | Add-Member ScriptMethod RegisterTaskDefinition {
    param($Name, $Definition, $Flags, $User, $Password, $Logon, $Sddl)
    Assert ($Flags -eq 2) 'Registration must never overwrite an existing task'
    Assert ($User -eq $ownerSid -and $null -eq $Password -and $Logon -eq 3) 'Registration must use the current interactive user without credentials'
    $this.Registered = $true; return $task
}
$scheduler = [pscustomobject]@{ Definition = $newDefinition; Folder = $folder }
$scheduler | Add-Member ScriptMethod NewTask { param($Flags); return $this.Definition }
$scheduler | Add-Member ScriptMethod GetFolder { param($Path); return $this.Folder }
$null = New-ServiceTask
Assert $folder.Registered 'Expected registration'
Assert ($newDefinition.Principal.RunLevel -eq 0 -and $newDefinition.Principal.LogonType -eq 3 -and $createdTrigger.UserId -eq $ownerSid) 'Expected least-privilege interactive logon task'
Assert ($settings.MultipleInstances -eq 2 -and $settings.ExecutionTimeLimit -eq 'PT0S') 'Expected one unlimited instance'
Assert (!$settings.DisallowStartIfOnBatteries -and !$settings.StopIfGoingOnBatteries -and !$settings.RunOnlyIfIdle -and !$settings.RunOnlyIfNetworkAvailable) 'Expected no battery/idle/network restrictions'
Assert ($settings.RestartCount -gt 0 -and $settings.RestartInterval -eq 'PT1M') 'Expected restart on failure'
$folder | Add-Member ScriptMethod GetTask { param($Name); throw [Runtime.InteropServices.COMException]::new('Missing task', -2147024894) }
Assert ($null -eq (Get-Task)) 'A missing task must report absent through wrapped COM exceptions'
$folder | Add-Member ScriptMethod GetTask { param($Name); throw [Runtime.InteropServices.COMException]::new('Access denied', -2147024891) } -Force
Must-Fail { Get-Task } 'Access denied must not look like an absent task'
# Isolate every named object and state file from the user's installed service.
$testId = [guid]::NewGuid().ToString('N')
$creationLockName = "Global\Nootify.Service.Creation.Test.$testId"
$runLockName = "Global\Nootify.Service.Run.Test.$testId"
$directory = Join-Path ([IO.Path]::GetTempPath()) ('nootify-job-test-' + $testId)
$null = [IO.Directory]::CreateDirectory($directory)
$runtimePath = Join-Path $directory 'windows-runtime.json'
Import-ServiceRunner
$runner = $null; $job = $null; $unrelated = $null; $unrelatedJob = $null; $startup = $null
$task | Add-Member NoteProperty Job $null
try {
    Must-Fail { Stop-OwnedTask $task } 'An active task without a runtime job identity must fail closed'
    Assert ($task.Stops -eq 0) 'An unverifiable task must not report a successful stop'
    Assert (!$task.Enabled) 'Stop must disable future logon/restart instances even if verification fails'
    Publish-Job ("Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N'))
    # A recorded job can be absent only after all its processes/handles are gone.
    Stop-OwnedTask $task
    Assert ($task.Stops -eq 1) 'Expected one stop of the owned task'
    Stop-OwnedTask $task
    Assert ($task.Stops -eq 1) 'Stopping an already stopped task must be idempotent'

    # Exercise the actual suspended-process/nested-job implementation with a node + helper tree.
    $StateDir = Join-Path $directory 'private-state'
    Prepare-State
    $acl = Get-Acl -LiteralPath $StateDir
    Assert $acl.AreAccessRulesProtected 'Service state must have a protected DACL'
    Assert ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $ownerSid) 'The current user must own service state'
    [IO.File]::WriteAllText((Join-Path $StateDir 'state.json'), 'private fixture')
    foreach ($path in @($StateDir, (Join-Path $StateDir 'state.json'))) {
        foreach ($rule in (Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            Assert ($rule.IdentityReference.Value -in @($ownerSid, 'S-1-5-18')) 'State ACLs must exclude other accounts'
        }
    }
    $junction = Join-Path $directory 'redirected-state'
    & $NodePath -e "require('node:fs').symlinkSync(process.argv[1], process.argv[2], 'junction')" $StateDir $junction
    Assert ($LASTEXITCODE -eq 0) 'Expected an unprivileged directory junction fixture'
    $privateState = $StateDir; $StateDir = $junction
    Must-Fail { Prepare-State } 'A directory junction must not redirect private service state'
    $StateDir = $privateState
    $fixture = Join-Path $directory 'server.cjs'
    [IO.File]::WriteAllText($fixture, @'
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
console.log('stdout marker'); console.error('stderr marker');
fs.writeFileSync(join(process.argv[2], 'pids.tmp'), JSON.stringify([process.pid, child.pid]));
fs.renameSync(join(process.argv[2], 'pids.tmp'), join(process.argv[2], 'pids.json'));
setInterval(()=>{},1000);
'@)
    $copiedNode = Join-Path $directory 'test-node.exe'
    Copy-Item -LiteralPath $NodePath -Destination $copiedNode
    $name = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $job = [Nootify.ServiceJob]::Create($name, $ownerSid)
    $runner = [Nootify.ServiceRunner]::new($job, $copiedNode, [string[]]@($fixture, $directory), $directory)
    Assert ($job.ActiveProcesses -eq 1) 'Suspended Node must already belong to its job at creation'
    Must-Fail { [Nootify.ServiceJob]::Create($name, $ownerSid) } 'Creation must never reconnect to an existing job'
    Must-Fail { [Nootify.ServiceJob]::Open($name, 'S-1-5-19') } 'A foreign job owner must fail verification'
    Assert ($job.ActiveProcesses -eq 1) 'Failed ownership/collision checks must not terminate an existing job'
    $runner.Resume()
    $until = [DateTime]::UtcNow.AddSeconds(10)
    $pidsPath = Join-Path $directory 'pids.json'
    while (!(Test-Path -LiteralPath $pidsPath)) {
        if ([DateTime]::UtcNow -gt $until) { throw 'Fixture node did not start' }
        Start-Sleep -Milliseconds 25
    }
    $pids = [IO.File]::ReadAllText($pidsPath) | ConvertFrom-Json
    $processes = @($pids | ForEach-Object { $process = [Diagnostics.Process]::GetProcessById([int]$_); $null = $process.Handle; $process })
    $runner.Dispose(); $runner = $null
    foreach ($process in $processes) { Assert ($process.WaitForExit(5000)) 'Node and helper must both leave the job'; $process.Dispose() }
    Assert ([IO.File]::ReadAllText((Join-Path $directory 'stdout.log')).Contains('stdout marker')) 'Expected private stdout log'
    Assert ([IO.File]::ReadAllText((Join-Path $directory 'stderr.log')).Contains('stderr marker')) 'Expected private stderr log'
    $job = $null
    $originalNode = $NodePath; $NodePath = $copiedNode
    $runtimePath = Join-Path $StateDir 'windows-runtime.json'
    $ServerPath = Join-Path $directory 'idle.cjs'
    [IO.File]::WriteAllText($ServerPath, 'setInterval(()=>{},1000);')
    $record.node = $NodePath; $record.server = $ServerPath; $record.state = $StateDir
    $entry.WorkingDirectory = $StateDir; $entry.Arguments = Run-Arguments $record
    $definition.RegistrationInfo.Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress)
    function Get-Task { return $task } # Scheduler boundary only; no installed task is accessed.

    # A delayed Run after a successful Stop must recheck task enablement inside the barrier.
    Assert ((Run-Service) -eq 0) 'A disabled task must reject a delayed Run without creating Node'
    Assert (!(Test-Path -LiteralPath $runtimePath)) 'A disabled Run must not create or publish a job'

    # Stop while real Run holds the creation barrier before publishing its job identity.
    # Disabling the fake task releases that startup; Stop must wait for creation and drain
    # the resulting Node even though Scheduler.Stop reports no instances immediately.
    $configPath = Join-Path $directory 'startup-config.json'
    $enabledPath = Join-Path $directory 'startup-enabled'
    $releasePath = Join-Path $directory 'startup-release'
    $readyPath = Join-Path $directory 'startup-ready'
    $harness = Join-Path $directory 'startup.ps1'
    [IO.File]::WriteAllText($enabledPath, '1')
    @{ record = $record; runtimePath = $runtimePath; creationLockName = $creationLockName; runLockName = $runLockName; enabledPath = $enabledPath; releasePath = $releasePath; readyPath = $readyPath } |
        ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $configPath -Encoding UTF8
    [IO.File]::WriteAllText($harness, @'
param($ServiceScript, $ConfigPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$config = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
$record = $config.record
$ownerSid = $record.sid; $scriptPath = $record.script; $NodePath = $record.node; $ServerPath = $record.server; $StateDir = $record.state; $Port = $record.port; $McpConfig = $record.mcp
$runtimePath = $config.runtimePath; $creationLockName = $config.creationLockName; $runLockName = $config.runLockName
$descriptionPrefix = 'Nootify per-user service v1: '
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($ServiceScript, [ref]$tokens, [ref]$errors)
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
Add-Type -Path (Join-Path (Split-Path $ServiceScript) 'service-runner.cs')
$entry = [pscustomobject]@{ Type = 0; Path = $powerShell; Arguments = (Run-Arguments $record); WorkingDirectory = $StateDir }
$actions = [pscustomobject]@{ Count = 1; Entry = $entry }
$actions | Add-Member ScriptMethod Item { param($Index); return $this.Entry }
$task = [pscustomobject]@{ Definition = [pscustomobject]@{ RegistrationInfo = [pscustomobject]@{ Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress) }; Actions = $actions; Principal = [pscustomobject]@{ UserId = $ownerSid; LogonType = 3; RunLevel = 0 } }; EnabledPath = $config.enabledPath }
$task | Add-Member ScriptProperty Enabled { return [IO.File]::ReadAllText($this.EnabledPath) -eq '1' }
function Get-Task { return $task }
$publish = ${function:Publish-Job}
function Publish-Job($Name) {
    [IO.File]::WriteAllText($config.readyPath, 'barrier held; no record or Node yet')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $config.releasePath)) {
        if ($watch.ElapsedMilliseconds -ge 10000) { throw 'Stop did not release startup fixture' }
        Start-Sleep -Milliseconds 10
    }
    & $publish $Name
}
exit (Run-Service)
'@)
    $startup = Start-Process -FilePath $powerShell -ArgumentList ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Argument $harness) + ' -ServiceScript ' + (Quote-Argument $serviceScript) + ' -ConfigPath ' + (Quote-Argument $configPath)) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory 'startup.stdout') -RedirectStandardError (Join-Path $directory 'startup.stderr')
    $null = $startup.Handle
    Wait-File $readyPath
    Assert (!(Test-Path -LiteralPath $runtimePath)) 'The startup fixture must stop before runtime publication'
    $task | Add-Member NoteProperty EnabledPath $enabledPath
    $task | Add-Member NoteProperty ReleasePath $releasePath
    $task | Add-Member NoteProperty Process $startup
    $task | Add-Member NoteProperty CountBeforeStop 0
    $task | Add-Member ScriptProperty Enabled { return [IO.File]::ReadAllText($this.EnabledPath) -eq '1' } {
        param($Value)
        [IO.File]::WriteAllText($this.EnabledPath, $(if ($Value) { '1' } else { '0' }))
        if (!$Value) { [IO.File]::WriteAllText($this.ReleasePath, 'stop waiting on creation barrier') }
    } -Force
    $task | Add-Member ScriptMethod GetInstances { param($Flags); return [pscustomobject]@{ Count = [int](!$this.Process.HasExited) } } -Force
    $task | Add-Member ScriptMethod Stop {
        param($Flags)
        $this.Stops++
        $runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
        $this.Job = [Nootify.ServiceJob]::Open($runtime.job, $ownerSid)
        $this.CountBeforeStop = $this.Job.ActiveProcesses
        $this.Process.Kill(); Assert ($this.Process.WaitForExit(5000)) 'Scheduler action must exit'
    } -Force
    Stop-OwnedTask $task
    Assert ($task.CountBeforeStop -gt 0) 'The startup fixture must create Node after Stop disables the task'
    Assert ($task.Job.ActiveProcesses -eq 0) 'Stop must drain startup Node despite additional open job handles'
    $task.Job.Dispose(); $task.Job = $null
    Assert (!(Test-Path -LiteralPath $runtimePath)) 'A successful stop may remove its completed runtime record'
    [IO.File]::Move($copiedNode, (Join-Path $directory 'released-node.exe'))
    [IO.File]::Move((Join-Path $directory 'released-node.exe'), $copiedNode)
    $startup.Dispose(); $startup = $null

    # Keep an unrelated job alive throughout Stop; a matching user alone is not ownership.
    $unrelatedName = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $unrelatedJob = [Nootify.ServiceJob]::Create($unrelatedName, $ownerSid)
    $unrelated = [Nootify.ServiceRunner]::new($unrelatedJob, $originalNode, [string[]]@('-e', 'setInterval(()=>{},1000)'), $directory)
    $unrelated.Resume()
    $lateFixture = Join-Path $directory 'late-helper.cjs'
    [IO.File]::WriteAllText($lateFixture, @'
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const directory = process.argv[2];
fs.writeFileSync(join(directory, 'late-ready'), 'ready');
let child;
setInterval(() => {
  if (!child && fs.existsSync(join(directory, 'spawn-helper'))) {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(join(directory, 'late-helper.tmp'), String(child.pid));
    fs.renameSync(join(directory, 'late-helper.tmp'), join(directory, 'late-helper.pid'));
  }
}, 10);
'@)
    $name = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $job = [Nootify.ServiceJob]::Create($name, $ownerSid)
    Publish-Job $name
    $runner = [Nootify.ServiceRunner]::new($job, $copiedNode, [string[]]@($lateFixture, $directory), $directory)
    $root = [Diagnostics.Process]::GetProcessById([int]$runner.ProcessId); $null = $root.Handle
    $runner.Resume(); Wait-File (Join-Path $directory 'late-ready')
    Assert ($job.ActiveProcesses -eq 1) 'The late-helper fixture must initially contain only Node'
    $task | Add-Member NoteProperty Helper $null
    $task | Add-Member ScriptMethod GetInstances { param($Flags); return [pscustomobject]@{ Count = $this.Instances } } -Force
    $task | Add-Member ScriptMethod Stop {
        param($Flags)
        $this.Stops++
        # This occurs after management opens the job, too late for any descendant snapshot.
        [IO.File]::WriteAllText((Join-Path $directory 'spawn-helper'), 'go')
        Wait-File (Join-Path $directory 'late-helper.pid')
        $this.Helper = [Diagnostics.Process]::GetProcessById([int][IO.File]::ReadAllText((Join-Path $directory 'late-helper.pid')))
        $null = $this.Helper.Handle
        Assert ($job.ActiveProcesses -ge 2) 'The real helper must be in the job before Scheduler reports stopped'
        $this.Instances = 0 # No process is killed at the mocked Scheduler boundary.
    } -Force
    $task.Instances = 1
    Stop-OwnedTask $task
    Assert ($job.ActiveProcesses -eq 0) 'Authoritative membership must include helpers born during Stop'
    Assert ($root.WaitForExit(0) -and $task.Helper.WaitForExit(0)) 'Stop must return only after Node/helper exit'
    Assert ($unrelatedJob.ActiveProcesses -eq 1) 'Stop must leave an unrelated current-user job running'
    $root.Dispose(); $task.Helper.Dispose()
    $runner.Dispose(); $runner = $null
    $job = [Nootify.ServiceJob]::Create($name, $ownerSid)
    Publish-Job $name

    # A real native query denial must abort Stop and retain evidence for retry.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NootifyJobTest {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
}
'@
    $limitedHandle = [NootifyJobTest]::OpenJobObject(8, $false, $name) # TERMINATE only; QueryInformationJobObject must fail.
    Assert ($limitedHandle -ne [IntPtr]::Zero) 'Expected a real terminate-only job handle'
    $constructor = [Nootify.ServiceJob].GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([IntPtr]), $null)
    $limited = $constructor.Invoke([object[]]@($limitedHandle))
    $openJob = ${function:Open-OwnedJob}
    function Open-OwnedJob { return $limited }
    try {
        Must-Fail { Stop-OwnedTask $task } 'A failed native job query must fail Stop'
        Assert (Test-Path -LiteralPath $runtimePath) 'A failed drain must retain runtime evidence'
    } finally { ${function:Open-OwnedJob} = $openJob }
    $job.Dispose(); $job = $null
    Stop-OwnedTask $task # Retry can prove this recorded job absent.
    [IO.File]::Move($copiedNode, (Join-Path $directory 'replaced-node.exe'))
} finally {
    if ($startup) { if (!$startup.HasExited) { $startup.Kill(); $null = $startup.WaitForExit(5000) }; $startup.Dispose() }
    if ($task.Job) { try { $task.Job.TerminateAndWait(5000) } finally { $task.Job.Dispose() } }
    if ($runner) { $runner.Dispose() }
    if ($job) { try { $job.TerminateAndWait(5000) } finally { $job.Dispose() } }
    if ($unrelated) { $unrelated.Dispose() }
    elseif ($unrelatedJob) { try { $unrelatedJob.TerminateAndWait(5000) } finally { $unrelatedJob.Dispose() } }
    if (Test-Path -LiteralPath $runtimePath) {
        $cleanupJob = Open-OwnedJob $false
        if ($cleanupJob) { try { $cleanupJob.TerminateAndWait(5000) } finally { $cleanupJob.Dispose() } }
    }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
Write-Output 'Windows service tests passed'
