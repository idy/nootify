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
# These AST-loaded functions deliberately have no source-root metadata. Import must
# resolve the real native helper from the verified service script path instead.
Import-ServiceRunner
Assert ($null -ne ('Nootify.ServiceJob' -as [type])) 'Expected the actual service-runner.cs helper'
$bootSequence = Get-BootSequence
Assert ($null -ne $bootSequence) 'Windows 10+ must expose the documented shared kernel boot sequence'
Assert ((Get-BootSequence) -eq $bootSequence) 'The kernel boot sequence must remain stable within this running Windows session'
$bootParser = [Nootify.ServiceJob].GetMethod('BootSequenceFromData', [Reflection.BindingFlags]'Static,NonPublic')
function Parse-TestBootData([byte[]]$Data) { return $bootParser.Invoke($null, [object[]](,$Data)) }
$sharedData = New-Object byte[] 0x2C8
[BitConverter]::GetBytes([uint32]10240).CopyTo($sharedData, 0x260)
[BitConverter]::GetBytes([uint16]9).CopyTo($sharedData, 0x26A)
[BitConverter]::GetBytes([uint32]10).CopyTo($sharedData, 0x26C)
Assert ((Parse-TestBootData $sharedData) -eq 0) 'Boot sequence zero is valid and must remain distinct from an unreadable identity'
[BitConverter]::GetBytes([uint32]::MaxValue).CopyTo($sharedData, 0x2C4)
Assert ((Parse-TestBootData $sharedData) -eq [uint32]::MaxValue) 'The full unsigned boot sequence must be preserved'
Assert ($null -eq (Parse-TestBootData (New-Object byte[] 0x2C7))) 'A short shared-page read must not produce boot evidence'
[BitConverter]::GetBytes([uint32]11).CopyTo($sharedData, 0x26C)
Assert ($null -eq (Parse-TestBootData $sharedData)) 'An unsupported NT layout must not produce boot evidence'
[BitConverter]::GetBytes([uint32]10).CopyTo($sharedData, 0x26C)
[BitConverter]::GetBytes([uint16]65535).CopyTo($sharedData, 0x26A)
Assert ($null -eq (Parse-TestBootData $sharedData)) 'An unknown native architecture must not produce boot evidence'
[BitConverter]::GetBytes([uint16]9).CopyTo($sharedData, 0x26A)
[BitConverter]::GetBytes([uint32]9600).CopyTo($sharedData, 0x260)
Assert ($null -eq (Parse-TestBootData $sharedData)) 'A pre-Windows-10 layout must not produce boot evidence'
$runner = $null; $job = $null; $unrelated = $null; $unrelatedJob = $null; $startup = $null
$crashProcesses = @()
$task | Add-Member NoteProperty Job $null
try {
    Must-Fail { Stop-OwnedTask $task } 'An active task without a runtime job identity must fail closed'
    Assert ($task.Stops -eq 0) 'An unverifiable task must not report a successful stop'
    Assert (!$task.Enabled) 'Stop must disable future logon/restart instances even if verification fails'
    $missingName = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    Publish-Job $missingName # Deterministic lost-name/receipt fault; no process snapshot can certify it.
    Must-Fail { Stop-OwnedTask $task } 'A missing job name without a receipt must not prove completion'
    $task.Instances = 0
    Must-Fail { Stop-OwnedTask $task } 'Scheduler count zero must not certify a vanished job'
    Assert ((Test-Path -LiteralPath $runtimePath) -and $task.Stops -eq 0) 'An unverified shutdown must retain its runtime evidence'
    Must-Fail { Stop-OwnedTask $null } 'A deleted registration must not hide an unverified runtime job'
    Assert (Test-Path -LiteralPath $runtimePath) 'An absent registration must retain unverified runtime evidence'
    $runtimeRecord = Read-OwnedRuntime $false
    Assert ($runtimeRecord.version -eq 3 -and $runtimeRecord.boot -eq $bootSequence) 'Publication must capture kernel boot identity before Node creation'
    $runtimeText = [IO.File]::ReadAllText($runtimePath)
    $bootReader = ${function:Get-BootSequence}
    function Get-BootSequence { return $script:testBoot }
    try {
        $script:testBoot = $null
        Must-Fail { Open-OwnedJob $false } 'An unreadable current boot sequence must not certify a missing job'
        $runtimeRecord.boot = $null
        [IO.File]::WriteAllText($runtimePath, ($runtimeRecord | ConvertTo-Json -Compress))
        $script:testBoot = [uint32]1
        Must-Fail { Open-OwnedJob $false } 'An unreadable stored boot sequence must not certify a missing job'
        $runtimeRecord.version = 2
        [IO.File]::WriteAllText($runtimePath, ($runtimeRecord | ConvertTo-Json -Compress))
        Must-Fail { Open-OwnedJob $false } 'A legacy runtime record must not infer a cross-boot drain'
        $runtimeRecord.version = 3
        foreach ($invalidBoot in @(-1, 4294967296, 'not-a-boot-sequence')) {
            $runtimeRecord.boot = $invalidBoot
            [IO.File]::WriteAllText($runtimePath, ($runtimeRecord | ConvertTo-Json -Compress))
            Must-Fail { Open-OwnedJob $false } 'Invalid boot metadata must not certify a missing job'
        }
        $runtimeRecord.boot = [uint32]0
        [IO.File]::WriteAllText($runtimePath, ($runtimeRecord | ConvertTo-Json -Compress))
        $script:testBoot = $null
        Must-Fail { Open-OwnedJob $false } 'An unreadable current boot must not be confused with stored sequence zero'
        $script:testBoot = [uint32]0
        Must-Fail { Open-OwnedJob $false } 'An equal boot sequence, including a restored hibernation/Fast Startup kernel, never proves exit'
        $script:testBoot = [uint32]1
        Assert ($null -eq (Open-OwnedJob $false)) 'A changed validated boot sequence independently excludes the old job processes'
        $runtimeRecord.boot = [uint32]::MaxValue
        [IO.File]::WriteAllText($runtimePath, ($runtimeRecord | ConvertTo-Json -Compress))
        $script:testBoot = [uint32]0
        Assert ($null -eq (Open-OwnedJob $false)) 'Boot counter wrap still changes the boot identity'
    } finally {
        ${function:Get-BootSequence} = $bootReader
        [IO.File]::WriteAllText($runtimePath, $runtimeText)
    }
    Remove-Item -LiteralPath $runtimePath # Fixture repair only: this synthetic run never created a process.
    $task.Instances = 1
    $name = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $completionPath = Job-CompletionPath $name
    $job = [Nootify.ServiceJob]::Create($name, $ownerSid, $completionPath)
    Publish-Job $name
    Assert (!(Test-Path -LiteralPath $completionPath)) 'Creating/publishing a job must not certify its completion'
    $bootReader = ${function:Get-BootSequence}; $opened = $null
    $script:testBoot = [uint32]0; if ($bootSequence -eq 0) { $script:testBoot = [uint32]1 }
    function Get-BootSequence { return $script:testBoot }
    try {
        $opened = Open-OwnedJob $true
        Assert ($null -ne $opened) 'Even differing boot metadata must not bypass an existing job kernel drain'
    } finally { if ($opened) { $opened.Dispose() }; ${function:Get-BootSequence} = $bootReader }
    $job.TerminateAndWait(0); $job.Dispose(); $job = $null
    Assert ($null -eq [Nootify.ServiceJob]::Open($name, $ownerSid)) 'The drained job must have no remaining handles'
    Assert ([IO.File]::ReadAllText($completionPath) -ceq $name) 'A kernel-verified drain must publish the exact run identity'
    [IO.File]::WriteAllText($completionPath, $missingName)
    Must-Fail { Stop-OwnedTask $task } 'A receipt from another run must not certify this shutdown'
    Assert (Test-Path -LiteralPath $runtimePath) 'A mismatched receipt must retain runtime evidence'
    [IO.File]::WriteAllText($completionPath, $name)
    Stop-OwnedTask $task
    Assert ($task.Stops -eq 1) 'A matching drain receipt must permit stopping the owned task after name loss'
    Assert (!(Test-Path -LiteralPath $completionPath)) 'Successful management must retire the completed receipt'
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
    # Explicit grants and protected child DACLs survive a parent-only ACL repair.
    $exports = Join-Path $StateDir 'exports'
    $null = [IO.Directory]::CreateDirectory($exports)
    $protectedToken = Join-Path $StateDir 'auth-token'
    $database = Join-Path $StateDir 'state.sqlite'
    $export = Join-Path $exports 'private-config.json'
    foreach ($path in @($protectedToken, $database, $export)) { [IO.File]::WriteAllText($path, 'private ACL fixture') }
    foreach ($path in @($exports, $protectedToken, $database, $export)) {
        $weak = Get-Acl -LiteralPath $path
        $weak.SetAccessRuleProtection(($path -ne $database), $true)
        foreach ($publicSid in @('S-1-1-0', 'S-1-5-32-545')) {
            $identity = New-Object Security.Principal.SecurityIdentifier($publicSid)
            $null = $weak.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'ReadAndExecute', 'Allow')))
        }
        Set-Acl -LiteralPath $path -AclObject $weak
    }
    Prepare-State
    foreach ($path in @($StateDir, $exports, $protectedToken, $database, $export)) {
        $repaired = Get-Acl -LiteralPath $path
        Assert $repaired.AreAccessRulesProtected 'Each existing state entry must have a protected DACL'
        Assert ($repaired.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $ownerSid) 'Each state entry must be owned by the current user'
        foreach ($rule in $repaired.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            Assert ($rule.IdentityReference.Value -in @($ownerSid, 'S-1-5-18')) 'Explicit Users/Everyone grants must not survive startup repair'
        }
    }
    Assert ([IO.File]::ReadAllText($protectedToken) -eq 'private ACL fixture') 'ACL repair must preserve existing secret content'
    $junction = Join-Path $directory 'redirected-state'
    & $NodePath -e "require('node:fs').symlinkSync(process.argv[1], process.argv[2], 'junction')" $StateDir $junction
    Assert ($LASTEXITCODE -eq 0) 'Expected an unprivileged directory junction fixture'
    $privateState = $StateDir; $StateDir = $junction
    Must-Fail { Prepare-State } 'A directory junction must not redirect private service state'
    $StateDir = $privateState
    $outside = Join-Path $directory 'outside-state'
    $null = [IO.Directory]::CreateDirectory($outside)
    $outsideAcl = (Get-Acl -LiteralPath $outside).Sddl
    $nestedJunction = Join-Path $StateDir 'redirected-child'
    & $NodePath -e "require('node:fs').symlinkSync(process.argv[1], process.argv[2], 'junction')" $outside $nestedJunction
    Assert ($LASTEXITCODE -eq 0) 'Expected a nested directory junction fixture'
    Must-Fail { Prepare-State } 'ACL repair must refuse redirected children'
    Assert ((Get-Acl -LiteralPath $outside).Sddl -ceq $outsideAcl) 'ACL repair must not change a junction target outside state'
    [IO.Directory]::Delete($nestedJunction)
    $fixture = Join-Path $directory 'server.cjs'
    [IO.File]::WriteAllText($fixture, @'
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const stateArg = process.argv.indexOf('--state-dir');
const directory = stateArg < 0 ? process.argv[2] : process.argv[stateArg + 1];
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
console.log('stdout marker'); console.error('stderr marker');
fs.writeFileSync(join(directory, 'pids.tmp'), JSON.stringify([process.pid, child.pid]));
fs.renameSync(join(directory, 'pids.tmp'), join(directory, 'pids.json'));
setInterval(()=>{},1000);
'@)
    $copiedNode = Join-Path $directory 'test-node.exe'
    Copy-Item -LiteralPath $NodePath -Destination $copiedNode
    $name = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $completionPath = Job-CompletionPath $name
    $job = [Nootify.ServiceJob]::Create($name, $ownerSid, $completionPath)
    $runner = [Nootify.ServiceRunner]::new($job, $copiedNode, [string[]]@($fixture, $directory), $directory)
    Assert ($job.ActiveProcesses -eq 1) 'Suspended Node must already belong to its job at creation'
    Assert (!(Test-Path -LiteralPath $completionPath)) 'A live job must not have a completion receipt'
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
    Assert ([IO.File]::ReadAllText($completionPath) -ceq $name) 'Normal runner disposal must leave independently verifiable completion evidence'
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
param($ServiceScript, $ConfigPath, [ValidateSet('Barrier', 'Direct')][string]$Mode = 'Barrier')
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
# Run-Service must import the real helper through the extracted production function.
$entry = [pscustomobject]@{ Type = 0; Path = $powerShell; Arguments = (Run-Arguments $record); WorkingDirectory = $StateDir }
$actions = [pscustomobject]@{ Count = 1; Entry = $entry }
$actions | Add-Member ScriptMethod Item { param($Index); return $this.Entry }
$task = [pscustomobject]@{ Definition = [pscustomobject]@{ RegistrationInfo = [pscustomobject]@{ Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress) }; Actions = $actions; Principal = [pscustomobject]@{ UserId = $ownerSid; LogonType = 3; RunLevel = 0 } }; EnabledPath = $config.enabledPath }
$task | Add-Member ScriptProperty Enabled { return [IO.File]::ReadAllText($this.EnabledPath) -eq '1' }
function Get-Task { return $task }
$publish = ${function:Publish-Job}
function Publish-Job($Name) {
    if ($Mode -eq 'Barrier') {
        [IO.File]::WriteAllText($config.readyPath, 'barrier held; no record or Node yet')
        $watch = [Diagnostics.Stopwatch]::StartNew()
        while (!(Test-Path -LiteralPath $config.releasePath)) {
            if ($watch.ElapsedMilliseconds -ge 10000) { throw 'Stop did not release startup fixture' }
            Start-Sleep -Milliseconds 10
        }
    }
    & $publish $Name
}
try { exit (Run-Service) }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
'@)
    $hostArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Argument $harness) + ' -ServiceScript ' + (Quote-Argument $serviceScript) + ' -ConfigPath ' + (Quote-Argument $configPath)
    $startup = Start-Process -FilePath $powerShell -ArgumentList $hostArguments -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory 'startup.stdout') -RedirectStandardError (Join-Path $directory 'startup.stderr')
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

    # A root Node failure lets the surviving host drain helpers and publish a receipt.
    # The next actual Run must consume that receipt and start a fresh job normally.
    $ServerPath = $fixture; $record.server = $ServerPath
    $pidsPath = Join-Path $StateDir 'pids.json'
    $entry.Arguments = Run-Arguments $record
    $definition.RegistrationInfo.Description = $descriptionPrefix + ($record | ConvertTo-Json -Compress)
    @{ record = $record; runtimePath = $runtimePath; creationLockName = $creationLockName; runLockName = $runLockName; enabledPath = $enabledPath; releasePath = $releasePath; readyPath = $readyPath } |
        ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $configPath -Encoding UTF8
    Remove-Item -LiteralPath $pidsPath -ErrorAction SilentlyContinue
    $task.Enabled = $true
    $startup = Start-Process -FilePath $powerShell -ArgumentList ($hostArguments + ' -Mode Direct') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory 'normal.stdout') -RedirectStandardError (Join-Path $directory 'normal.stderr')
    $null = $startup.Handle; $task.Process = $startup
    Wait-File $pidsPath
    $normalRuntime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
    $normalCompletion = Job-CompletionPath $normalRuntime.job
    Assert (!(Test-Path -LiteralPath $normalCompletion)) 'A running host must not publish a completion receipt'
    $crashProcesses = @(([IO.File]::ReadAllText($pidsPath) | ConvertFrom-Json) | ForEach-Object { $process = [Diagnostics.Process]::GetProcessById([int]$_); $null = $process.Handle; $process })
    $crashProcesses[0].Kill()
    Assert ($startup.WaitForExit(10000)) 'The normal host must finish draining after root Node exits'
    foreach ($process in $crashProcesses) { Assert ($process.WaitForExit(0)) 'Normal host cleanup must also drain its helper' }
    foreach ($process in $crashProcesses) { $process.Dispose() }; $crashProcesses = @()
    Assert ([IO.File]::ReadAllText($normalCompletion) -ceq $normalRuntime.job) 'A normal host exit must leave a run-specific drain receipt'
    $startup.Dispose(); $startup = $null

    # Kill the actual PowerShell host while its root and helper are alive. Do not open
    # its job beforehand: that would keep the name alive and mask last-handle recovery.
    Remove-Item -LiteralPath $pidsPath
    $startup = Start-Process -FilePath $powerShell -ArgumentList ($hostArguments + ' -Mode Direct') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory 'crash.stdout') -RedirectStandardError (Join-Path $directory 'crash.stderr')
    $null = $startup.Handle; $task.Process = $startup
    Wait-File $pidsPath
    $crashRecord = [IO.File]::ReadAllText($runtimePath)
    $crashRuntime = $crashRecord | ConvertFrom-Json
    Assert ($crashRuntime.job -cne $normalRuntime.job) 'A normal restart must create a fresh private job identity'
    Assert (!(Test-Path -LiteralPath $normalCompletion)) 'A normal restart must retire the previous completion receipt'
    $crashCompletion = Job-CompletionPath $crashRuntime.job
    $crashProcesses = @(([IO.File]::ReadAllText($pidsPath) | ConvertFrom-Json) | ForEach-Object { $process = [Diagnostics.Process]::GetProcessById([int]$_); $null = $process.Handle; $process })
    $startup.Kill(); Assert ($startup.WaitForExit(5000)) 'The abrupt host-exit fixture must lose its last job handle'
    # These retained fixture handles are assertions/teardown only. Production never
    # accepts descendant enumeration or process exit snapshots as drain evidence.
    foreach ($process in $crashProcesses) { Assert ($process.WaitForExit(5000)) 'KILL_ON_JOB_CLOSE must eventually terminate the crash fixture' }
    Assert (!(Test-Path -LiteralPath $crashCompletion)) 'An abruptly killed host must not certify its own shutdown'
    $beforeStops = $task.Stops
    $stopWatch = [Diagnostics.Stopwatch]::StartNew()
    Must-Fail { Stop-OwnedTask $task } 'An abruptly vanished job without a receipt must fail closed even after Scheduler count zero'
    Assert ($stopWatch.ElapsedMilliseconds -lt 30000) 'Unverifiable recovery must stay within the shutdown deadline'
    Assert (!$task.Enabled -and $task.Stops -eq $beforeStops) 'Failed crash recovery must keep the task disabled without claiming a stop'
    Assert ([IO.File]::ReadAllText($runtimePath) -ceq $crashRecord) 'Failed crash recovery must retain the exact runtime evidence'
    $startup.Dispose(); $startup = $null
    $task.Enabled = $true
    $startup = Start-Process -FilePath $powerShell -ArgumentList ($hostArguments + ' -Mode Direct') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory 'recovery.stdout') -RedirectStandardError (Join-Path $directory 'recovery.stderr')
    $null = $startup.Handle; $task.Process = $startup
    Assert ($startup.WaitForExit(10000)) 'An unverified prior crash must prevent another Run from creating Node'
    Assert ($startup.ExitCode -ne 0) 'An unverified prior crash must fail automatic restart explicitly'
    Assert $task.Enabled 'A failed Run must leave the logon trigger enabled for automatic recovery after a full Restart'
    $recoveryError = [IO.File]::ReadAllText((Join-Path $directory 'recovery.stderr'))
    Assert ($recoveryError.Contains('Use Windows Restart and retry') -and $recoveryError.Contains('no readable boot evidence')) 'Recovery must distinguish automatic recovery after Restart from legacy/unreadable boot repair'
    Assert ([IO.File]::ReadAllText($runtimePath) -ceq $crashRecord) 'A failed restart must retain the previous run identity'
    # Model a subsequent full Windows Restart at the boot-reader boundary. Only this
    # changed kernel sequence, not Scheduler zero or retained fixture PIDs, permits recovery.
    $bootReader = ${function:Get-BootSequence}
    $script:testBoot = [uint32]0; if ($crashRuntime.boot -eq 0) { $script:testBoot = [uint32]1 }
    function Get-BootSequence { return $script:testBoot }
    try { Stop-OwnedTask $task } finally { ${function:Get-BootSequence} = $bootReader }
    Assert (!(Test-Path -LiteralPath $runtimePath)) 'A changed verified kernel boot sequence must recover the old runtime automatically'
    Assert (Test-Path -LiteralPath (Join-Path $StateDir 'state.json')) 'Cross-boot recovery must preserve private settings'
    $startup.Dispose(); $startup = $null
    foreach ($process in $crashProcesses) { $process.Dispose() }; $crashProcesses = @()
    $task.Enabled = $false
    [IO.File]::Move($copiedNode, (Join-Path $directory 'crash-released-node.exe'))
    [IO.File]::Move((Join-Path $directory 'crash-released-node.exe'), $copiedNode)

    # Keep an unrelated job alive throughout Stop; a matching user alone is not ownership.
    $unrelatedName = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $unrelatedJob = [Nootify.ServiceJob]::Create($unrelatedName, $ownerSid)
    $unrelated = [Nootify.ServiceRunner]::new($unrelatedJob, $originalNode, [string[]]@('-e', 'setInterval(()=>{},1000)'), $directory)
    $unrelated.Resume()

    # Deleting a registration does not terminate its action. With no task object,
    # Stop must still authenticate and drain the recorded job, preserving other jobs.
    $name = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $job = [Nootify.ServiceJob]::Create($name, $ownerSid, (Job-CompletionPath $name))
    Publish-Job $name
    $runner = [Nootify.ServiceRunner]::new($job, $copiedNode, [string[]]@('-e', 'setInterval(()=>{},1000)'), $directory)
    $runner.Resume()
    $beforeStops = $task.Stops
    Stop-OwnedTask $null
    Assert ($job.ActiveProcesses -eq 0) 'A missing task registration must not leave the daemon alive'
    Assert (!(Test-Path -LiteralPath $runtimePath)) 'An orphaned job must be verified empty before its runtime is removed'
    Assert ($task.Stops -eq $beforeStops) 'An absent registration must not control another task'
    Assert ($unrelatedJob.ActiveProcesses -eq 1) 'Orphan cleanup must leave unrelated jobs running'
    $runner.Dispose(); $runner = $null; $job = $null
    Stop-OwnedTask $null # No registration and no runtime is an idempotent stop.

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
    $name = "Global\Nootify.Service.Job.$ownerSid." + [guid]::NewGuid().ToString('N')
    $completionPath = Job-CompletionPath $name
    $job = [Nootify.ServiceJob]::Create($name, $ownerSid, $completionPath)
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
    $constructor = [Nootify.ServiceJob].GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([IntPtr], [string], [string]), $null)
    $limited = $constructor.Invoke([object[]]@($limitedHandle, $name, $completionPath))
    $openJob = ${function:Open-OwnedJob}
    function Open-OwnedJob { return $limited }
    try {
        Must-Fail { Stop-OwnedTask $task } 'A failed native job query must fail Stop'
        Assert (Test-Path -LiteralPath $runtimePath) 'A failed drain must retain runtime evidence'
        Assert (!(Test-Path -LiteralPath $completionPath)) 'A failed authoritative query must never publish a completion receipt'
    } finally { ${function:Open-OwnedJob} = $openJob }
    Stop-OwnedTask $task # The retained real handle permits a fresh authoritative query on retry.
    $job.Dispose(); $job = $null
    [IO.File]::Move($copiedNode, (Join-Path $directory 'replaced-node.exe'))
} finally {
    if ($startup) { if (!$startup.HasExited) { $startup.Kill(); $null = $startup.WaitForExit(5000) }; $startup.Dispose() }
    foreach ($process in $crashProcesses) {
        if (!$process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
        $process.Dispose()
    }
    if ($task.Job) { try { $task.Job.TerminateAndWait(5000) } finally { $task.Job.Dispose() } }
    if ($runner) { $runner.Dispose() }
    if ($job) { try { $job.TerminateAndWait(5000) } finally { $job.Dispose() } }
    if ($unrelated) { $unrelated.Dispose() }
    elseif ($unrelatedJob) { try { $unrelatedJob.TerminateAndWait(5000) } finally { $unrelatedJob.Dispose() } }
    if (Test-Path -LiteralPath $runtimePath) {
        # Fixture teardown does not claim a production stop or discard real service state.
        # It may encounter the intentionally unverified crash record after an assertion fails.
        $cleanupRuntime = Read-OwnedRuntime $false
        $cleanupJob = [Nootify.ServiceJob]::Open($cleanupRuntime.job, $ownerSid)
        if ($cleanupJob) { try { $cleanupJob.TerminateAndWait(5000) } finally { $cleanupJob.Dispose() } }
    }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
Write-Output 'Windows service tests passed'
