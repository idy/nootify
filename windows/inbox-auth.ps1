# Windows PowerShell 5.1. One private stdin request; never put a token/message in arguments or errors.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $compile = @{ Path = (Join-Path $PSScriptRoot 'inbox-auth.cs') }
    # .NET Framework stores named pipes and SafePipeHandle in System.Core, which
    # Windows PowerShell 5.1 does not reference by default. Core editions use their defaults.
    if ($PSVersionTable.PSVersion.Major -le 5) { $compile.ReferencedAssemblies = @('System.dll', 'System.Core.dll') }
    Add-Type @compile
    [Console]::WriteLine('{"ready":true}')
    $request = ConvertFrom-Json -InputObject ([Console]::ReadLine())
    [Nootify.InboxWriter]::Write([string]$request.path, [uint32]$request.expectedPid, [string]$request.frames, [int]$request.timeout)
    [Console]::WriteLine('{"status":"socket_written"}')
    exit 0
} catch {
    [Console]::WriteLine('{"error":"inbox_write_failed"}')
    exit 1
}
