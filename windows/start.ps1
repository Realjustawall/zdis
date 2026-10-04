param([switch]$LogToFile)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if ($LogToFile) {
        New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null
        Start-Transcript -Path (Join-Path $root 'logs/server.log') -Append | Out-Null
    }
    if (-not (Test-Path -LiteralPath '.env')) {
        Copy-Item -LiteralPath 'windows/.env.windows.example' -Destination '.env'
        Write-Host 'Created .env with Windows SQLite defaults. The initial admin password is generated at first startup.'
    }
    if (-not (Test-Path -LiteralPath 'node_modules')) { throw 'Dependencies are missing. Run windows/setup.ps1 first.' }
    if (-not (Test-Path -LiteralPath 'client/dist/index.html')) { throw 'Client build is missing. Run npm.cmd run build first.' }
    & node --disable-warning=ExperimentalWarning --import ./server/src/lib/telemetry.js ./server/src/index.js
    if ($LASTEXITCODE -ne 0) { throw "ZDIS exited with code $LASTEXITCODE" }
} finally { if ($LogToFile) { Stop-Transcript | Out-Null }; Pop-Location }
