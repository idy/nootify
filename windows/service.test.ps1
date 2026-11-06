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
$serviceScript = Join-Path $PSScriptRoot 'service.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($serviceScript, [ref]$tokens, [ref]$errors)
Assert ($errors.Count -eq 0) ($errors | Out-String)
# Load only function definitions. The production script's top-level management flow never runs here.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
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
function Owned-Processes { return ,([Collections.Generic.List[Diagnostics.Process]]::new()) }
Stop-OwnedTask $task
Assert ($task.Stops -eq 1) 'Expected one stop of the owned task'
Stop-OwnedTask $task
Assert ($task.Stops -eq 1) 'Stopping an already stopped task must be idempotent'

# Exercise the actual suspended-process/nested-job implementation with a node + helper tree.
Add-Type -Path (Join-Path $PSScriptRoot 'service-runner.cs')
$directory = Join-Path ([IO.Path]::GetTempPath()) ('nootify-job-test-' + [guid]::NewGuid().ToString())
$null = [IO.Directory]::CreateDirectory($directory)
$runner = $null
try {
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
    $runner = [Nootify.ServiceRunner]::new($copiedNode, [string[]]@($fixture, $directory), $directory)
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
    [IO.File]::Move($copiedNode, (Join-Path $directory 'replaced-node.exe'))
} finally {
    if ($runner) { $runner.Dispose() }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
Write-Output 'Windows service tests passed'
