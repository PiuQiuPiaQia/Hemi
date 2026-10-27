# One-shot handoff only after explicit user approval. No password or auto-login.
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'An administrator token is required to transfer this session.'
}
$owned = @()
foreach ($line in @(quser $env:USERNAME 2>$null | Select-Object -Skip 1)) {
  $parts = $line.TrimStart('>', ' ') -split '\s+'
  if ($parts.Count -ge 4 -and $parts[0] -eq $env:USERNAME -and
      $parts[1] -match '^rdp-tcp#\d+$' -and $parts[2] -match '^\d+$' -and
      $parts[3] -match '^(Active|\u6d3b\u52a8|\u8fd0\u884c\u4e2d)$') {
    $owned += [int]$parts[2]
  }
}
if ($owned.Count -ne 1) { throw 'Exactly one active RDP session owned by this account is required.' }
& (Join-Path $env:SystemRoot 'System32\tscon.exe') $owned[0] /dest:console /v
if ($LASTEXITCODE -ne 0) { throw ('Session transfer failed: ' + $LASTEXITCODE) }
