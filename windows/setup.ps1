param([switch]$OpenFirewall, [ValidateRange(1,65535)][int]$FirewallPort = 8080)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $major = & node -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw 'Install Node.js 24 or newer first.' }
    if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath 'windows/.env.windows.example' -Destination '.env' }
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Client build failed.' }
    if ($OpenFirewall) {
        if (-not (Get-NetFirewallRule -Name 'ZDIS-HTTP' -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -Name 'ZDIS-HTTP' -DisplayName 'ZDIS HTTP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $FirewallPort -Profile Domain,Private | Out-Null
        }
    }
    Write-Host 'Ready. Run windows/start.ps1. Edit .env before exposing the server.'
} finally { Pop-Location }
