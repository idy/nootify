#requires -Version 5.1
# Compile and execute only a dummy payload, using the exact production NSIS hooks.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or !$env:RUNNER_TEMP -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This native probe is restricted to disposable Windows GitHub Actions runners.'
}
if (![IO.Path]::IsPathRooted($env:RUNNER_TEMP)) { throw 'RUNNER_TEMP must be absolute' }
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$repository = Split-Path -Parent $PSScriptRoot
$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$fixture = Join-Path $runnerTemp 'Nootify installer hook smoke'
$outputDir = Join-Path $repository '.cache\windows-installer-hook-smoke'
# Get-Command may return several PATH matches. Select one scalar executable explicitly.
$node = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
$startupVariables = @('NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA')
$phase = 'preflight'
$failure = $null
$results = New-Object 'Collections.Generic.List[object]'

function Quote-Argument([string]$Value) {
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
function Read-SafeLog([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536) {
        throw 'Refusing redirected or oversized native probe diagnostics'
    }
    return [IO.File]::ReadAllText($Path)
}
function Run-Native([string]$File, [string]$Arguments, [string]$Label, [hashtable]$EnvironmentValues = @{}, [int]$ExpectedExit = 0) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $File
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $fixture
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($name in $startupVariables) { $start.EnvironmentVariables.Remove($name) }
    foreach ($name in $EnvironmentValues.Keys) { $start.EnvironmentVariables[$name] = $EnvironmentValues[$name] }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (!$process.Start()) { throw "$Label did not start" }
        $null = $process.Handle # Retain identity until bounded tree cleanup completes.
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $timedOut = !$process.WaitForExit(30000)
        if ($timedOut) {
            # Only the process we just launched and its descendants; never image-name killing.
            $killStart = New-Object Diagnostics.ProcessStartInfo
            $killStart.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            $killStart.Arguments = "/PID $($process.Id) /T /F"
            $killStart.UseShellExecute = $false
            $killStart.CreateNoWindow = $true
            $killer = [Diagnostics.Process]::Start($killStart)
            try {
                if (!$killer.WaitForExit(5000)) { $killer.Kill(); $null = $killer.WaitForExit(5000) }
            } finally { $killer.Dispose() }
            if (!$process.WaitForExit(5000)) { throw "$Label timed out and did not exit after tree cleanup" }
        }
        if (!$stdout.Wait(5000) -or !$stderr.Wait(5000)) { throw "$Label did not close redirected output" }
        [IO.File]::WriteAllText((Join-Path $outputDir "$Label.stdout.log"), $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $outputDir "$Label.stderr.log"), $stderr.GetAwaiter().GetResult())
        if ($timedOut) { throw "$Label exceeded 30 seconds" }
        if ($process.ExitCode -ne $ExpectedExit) { throw "$Label exited $($process.ExitCode), expected $ExpectedExit" }
    } finally { $process.Dispose() }
}
function Save-NativeTrace([string]$Directory, [string]$Label) {
    foreach ($name in @('nootify-installer-hook.log', 'probe-state.log')) {
        $text = Read-SafeLog (Join-Path $Directory $name)
        if ($text) {
            [IO.File]::WriteAllText((Join-Path $outputDir "$Label.$name"), $text)
            Write-Host "$Label $name`n$text"
        }
    }
}
function Invoke-Hook([string]$Executable, [string]$Arguments, [string]$Directory, [string]$Label, [hashtable]$Values, [string]$Hook, [int]$Mode, [bool]$Diagnostics) {
    try { Run-Native $Executable $Arguments $Label $Values }
    finally { Save-NativeTrace $Directory $Label }
    $state = Read-SafeLog (Join-Path $Directory 'probe-state.log')
    if (!$state.Contains("PASS $Hook mode=$Mode registers stack")) { throw "$Label did not preserve registers/stack or finish its hook" }
    $trace = Read-SafeLog (Join-Path $Directory 'nootify-installer-hook.log')
    if (!$Diagnostics) {
        if ($trace) { throw "$Label unexpectedly enabled production diagnostics" }
        return
    }
    foreach ($name in $startupVariables) {
        if (!$trace.Contains("clear ${name}: result=")) { throw "$Label lost an environment API diagnostic" }
    }
    $command = $(if ($Hook -eq 'NSIS_HOOK_PREINSTALL' -or $Mode -eq 1) { 'service-stop' } else { 'service-uninstall' })
    if (!$trace.Contains("manage ${command}: invoking CLI") -or !$trace.Contains("manage ${command}: result=0")) {
        throw "$Label lost CLI invocation or result diagnostics"
    }
}

# No -Force: never reuse or overwrite existing fixtures or diagnostics.
if ((Test-Path -LiteralPath $fixture) -or (Test-Path -LiteralPath $outputDir)) {
    throw 'Refusing a pre-existing installer-hook fixture or diagnostic directory'
}
if (((Get-Item -LiteralPath $runnerTemp -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Refusing redirected RUNNER_TEMP'
}
$null = New-Item -ItemType Directory -Path $outputDir
try {
    $null = New-Item -ItemType Directory -Path $fixture
    $phase = 'download and verify NSIS 3.13'
    $archive = Join-Path $fixture 'nsis-3.13.zip'
    $ProgressPreference = 'SilentlyContinue' # PS5.1 progress rendering slows downloads greatly.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip' -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -cne 'BA63DFFC4410EE89193E1CB5A41989991BD77C61068DA17E3156D136B7B0B3D8') {
        throw 'NSIS archive SHA256 mismatch; refusing extraction'
    }
    $compilerDir = Join-Path $fixture 'compiler'
    Expand-Archive -LiteralPath $archive -DestinationPath $compilerDir
    # NSIS distributions also ship Bin\makensis.exe; select the root compiler beside Include/Plugins.
    $compilers = @(Get-ChildItem -LiteralPath $compilerDir -Filter makensis.exe -Recurse -File | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_.DirectoryName 'Include\LogicLib.nsh') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $_.DirectoryName 'Plugins\x86-unicode\System.dll') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $_.DirectoryName 'Plugins\x86-unicode\nsExec.dll') -PathType Leaf)
    })
    if ($compilers.Count -ne 1) { throw "Expected exactly one pinned NSIS root compiler, found $($compilers.Count)" }
    $compiler = $compilers[0].FullName
    $cliSource = @'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const command = process.argv[2];
if (process.argv.length !== 3 || !['service-stop', 'service-uninstall'].includes(command)) {
  process.stderr.write('Unexpected dummy CLI command\n'); process.exit(9);
}
const clean = {};
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA']) {
  clean[name] = !process.env[name];
}
fs.appendFileSync(path.resolve(__dirname, '../../..', 'calls.jsonl'), JSON.stringify({ command, clean }) + '\n');
if (Object.values(clean).some(value => !value)) { process.exitCode = 10; }
'@
    foreach ($diagnostics in @($true, $false)) {
        $variant = $(if ($diagnostics) { 'diagnostic' } else { 'production' })
        $phase = "compile $variant probe"
        $installer = Join-Path $fixture "$variant-hook-probe.exe"
        $arguments = '/V4 ' + (Quote-Argument ("/DPROBE_OUTPUT=$installer")) +
            $(if (!$diagnostics) { ' /DPROBE_NO_DIAGNOSTICS' } else { '' }) + ' ' +
            (Quote-Argument (Join-Path $PSScriptRoot 'windows-installer-hook-smoke.nsi'))
        Run-Native $compiler $arguments "compile-$variant" @{ NOOTIFY_INSTALLER_HOOK_DIAGNOSTICS = '0' }
        foreach ($poisoned in @($false, $true)) {
            foreach ($mode in @(0, 1)) {
                $label = $variant + '-' + $(if ($poisoned) { 'poisoned' } else { 'clean' }) + "-mode-$mode"
                $phase = $label
                $caseDir = Join-Path $fixture $label
                $payload = Join-Path $caseDir 'payload'
                $cliDir = Join-Path $payload 'service\dist\src'
                $null = New-Item -ItemType Directory -Path $cliDir
                Copy-Item -LiteralPath $node -Destination (Join-Path $payload 'node.exe')
                Copy-Item -LiteralPath $installer -Destination (Join-Path $caseDir 'hook-probe.exe')
                [IO.File]::WriteAllText((Join-Path $cliDir 'cli.js'), $cliSource)
                $values = @{}
                if ($poisoned) {
                    $missing = Join-Path $caseDir 'nootify-hook-missing-preload.cjs'
                    $values = @{
                        NODE_OPTIONS = '--require="' + $missing.Replace('\', '/') + '"'
                        NODE_PATH = (Join-Path $caseDir 'missing-node-modules')
                        NODE_EXTRA_CA_CERTS = (Join-Path $caseDir 'missing-ca.pem')
                        NODE_ICU_DATA = (Join-Path $caseDir 'missing-icu')
                    }
                    # Prove the inherited preload alone would prevent Node from starting. The other
                    # fixture values stay out of the control so an ICU startup failure cannot mask it.
                    Run-Native (Join-Path $payload 'node.exe') '-e "process.exit(0)"' "$label-control" @{ NODE_OPTIONS = $values.NODE_OPTIONS } 1
                    $control = Read-SafeLog (Join-Path $outputDir "$label-control.stderr.log")
                    if ($control -notmatch 'MODULE_NOT_FOUND' -or $control -notmatch 'nootify-hook-missing-preload\.cjs') {
                        throw 'Missing-preload negative control did not reject startup as expected'
                    }
                }
                $switches = '/S' + $(if ($mode -eq 1) { ' /UPDATE' } else { '' })
                Invoke-Hook (Join-Path $caseDir 'hook-probe.exe') $switches $caseDir "$label-install" $values 'NSIS_HOOK_PREINSTALL' $mode $diagnostics
                # NSIS _?= must be last and unquoted (even with spaces). It prevents the
                # normal temporary uninstaller handoff, making this retained process synchronous.
                Invoke-Hook (Join-Path $payload 'uninstall.exe') "$switches _?=$payload" $payload "$label-uninstall" $values 'NSIS_HOOK_PREUNINSTALL' $mode $diagnostics
                $callText = Read-SafeLog (Join-Path $payload 'calls.jsonl')
                [IO.File]::WriteAllText((Join-Path $outputDir "$label.calls.jsonl"), $callText)
                $calls = @($callText -split '\r?\n' | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
                $uninstallCommand = $(if ($mode -eq 1) { 'service-stop' } else { 'service-uninstall' })
                if ($calls.Count -ne 2 -or $calls[0].command -cne 'service-stop' -or $calls[1].command -cne $uninstallCommand) {
                    throw "$label recorded unexpected CLI commands"
                }
                foreach ($call in $calls) {
                    foreach ($name in $startupVariables) {
                        if ($call.clean.$name -ne $true) { throw "$label inherited a Node startup variable" }
                    }
                }
                $results.Add(@{ case = $label; diagnostics = $diagnostics; result = 'passed'; install = 'service-stop'; uninstall = $uninstallCommand })
                Write-Host "Windows installer hook smoke: $label passed"
            }
        }
    }
} catch {
    $failure = $_.Exception.Message
    Write-Warning "Windows installer hook smoke failed in ${phase}: $failure"
} finally {
    # Only fixed compiler/process output, dummy command records, native bool/error/status
    # traces and this summary are uploaded. No real app/state/configuration is read.
    @{ result = $(if ($failure) { 'failed' } else { 'passed' }); phase = $phase; error = $failure; cases = @($results.ToArray()) } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputDir 'diagnostics.json') -Encoding UTF8
}
if ($failure) { throw "Windows installer hook probe failed: $failure. See .cache/windows-installer-hook-smoke native traces." }
Write-Host 'Native Windows installer/uninstaller hook probe passed all eight production/diagnostic environment/update cases.'
