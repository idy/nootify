# Pure peer policy and PowerShell/C# compilation; no accounts, ACLs or system state are modified.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'inbox-auth.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Inbox writer PowerShell syntax failed' }
Add-Type -Path (Join-Path $PSScriptRoot 'inbox-auth.cs')
function Assert-Denied([scriptblock]$Check) {
    $denied = $false
    try { & $Check } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $denied = $failure -is [UnauthorizedAccessException]
    }
    if (!$denied) { throw 'Inbox peer policy did not reject an unverifiable identity' }
}
$owner = 'S-1-5-21-100-200-300-1001'
$foreign = 'S-1-5-21-100-200-300-1002'
[Nootify.InboxWriter]::AssertPeer(123, 123, $owner, $owner)
Assert-Denied { [Nootify.InboxWriter]::AssertPeer(123, 124, $owner, $owner) } # Claimed pipe, different server PID.
Assert-Denied { [Nootify.InboxWriter]::AssertPeer(123, 123, $owner, $foreign) } # Reused expected PID, foreign token SID.
Assert-Denied { [Nootify.InboxWriter]::AssertPeer(0, 123, $owner, $owner) }
Assert-Denied { [Nootify.InboxWriter]::AssertPeer(123, 0, $owner, $owner) }
Assert-Denied { [Nootify.InboxWriter]::AssertPeer(123, 123, '', $owner) }
Assert-Denied { [Nootify.InboxWriter]::AssertPeer(123, 123, $owner, '') }
[Console]::WriteLine('Windows inbox peer policy tests passed')
