# Windows PowerShell 5.1. One private stdin request; never put a token/message in arguments or errors.
param([switch]$Diagnostics)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
# A caller running PowerShell 7 can otherwise pass incompatible Core modules to 5.1.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
function Trace-Inbox([string]$Phase) { if ($Diagnostics) { [Console]::Error.WriteLine($Phase) } }
Trace-Inbox 'inbox:started'
$writer = $null
$writing = $false
try {
    # Keep UTF-8 local to redirected streams, without .NET Framework's global
    # Windows console encoding setters (Console.InputEncoding calls SetConsoleCP).
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false)
    $writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
    $writer.AutoFlush = $true
    Trace-Inbox 'inbox:reading'
    # JSON.stringify escapes embedded newlines. Read exactly one line instead of
    # waiting for EOF on Node's Windows duplex stdio pipe.
    $line = $reader.ReadLine()
    Trace-Inbox 'inbox:input'
    $request = ConvertFrom-Json -InputObject $line
    Trace-Inbox 'inbox:compile'
    $compile = @{ LiteralPath = (Join-Path $PSScriptRoot 'inbox-auth.cs') }
    # .NET Framework stores named pipes and SafePipeHandle in System.Core, which
    # Windows PowerShell 5.1 does not reference by default. Core editions use their defaults.
    if ($PSVersionTable.PSVersion.Major -le 5) { $compile.ReferencedAssemblies = @('System.dll', 'System.Core.dll') }
    Add-Type @compile
    Trace-Inbox 'inbox:ready'
    $writer.WriteLine('{"ready":true}')
    $writing = $true
    [Nootify.InboxWriter]::Write([string]$request.path, [uint32]$request.expectedPid, [string]$request.frames, [int]$request.timeout)
    $writer.WriteLine('{"status":"socket_written"}')
    exit 0
} catch {
    if ($null -ne $writer) {
        if ($writing) { $writer.WriteLine('{"error":"inbox_write_failed"}') }
        else { $writer.WriteLine('{"error":"inbox_startup_failed"}') }
    }
    exit 1
}
