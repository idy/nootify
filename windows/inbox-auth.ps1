# Windows PowerShell 5.1. One private stdin request; never put a token/message in arguments or errors.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
$writer = $null
$writing = $false
try {
    # Keep UTF-8 local to redirected streams, without .NET Framework's global
    # Windows console encoding setters (Console.InputEncoding calls SetConsoleCP).
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false)
    $writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
    $writer.AutoFlush = $true
    # Exactly one request, terminated by EOF before startup readiness is announced.
    $request = ConvertFrom-Json -InputObject ($reader.ReadToEnd())
    $compile = @{ LiteralPath = (Join-Path $PSScriptRoot 'inbox-auth.cs') }
    # .NET Framework stores named pipes and SafePipeHandle in System.Core, which
    # Windows PowerShell 5.1 does not reference by default. Core editions use their defaults.
    if ($PSVersionTable.PSVersion.Major -le 5) { $compile.ReferencedAssemblies = @('System.dll', 'System.Core.dll') }
    Add-Type @compile
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
