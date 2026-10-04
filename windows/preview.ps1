param([ValidateRange(1,65535)][int]$Port = 18181)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not (Test-Path -LiteralPath 'client/dist/index.html')) { throw 'Run npm.cmd run build first.' }
    $env:NODE_ENV = 'development'
    $env:HOST = '127.0.0.1'
    $env:PORT = "$Port"
    $env:PUBLIC_URL = "http://127.0.0.1:$Port"
    $env:CLIENT_ORIGIN = $env:PUBLIC_URL
    $env:DATABASE_DRIVER = 'sqlite'
    $env:DATABASE_URL = ''
    $env:REDIS_URL = ''
    $env:REQUIRE_REDIS = 'false'
    $env:REQUIRE_POSTGRES = 'false'
    $env:SECURE_COOKIES = 'false'
    $env:DATA_DIR = Join-Path $root '.tmp/preview-latest'
    $env:SQLITE_FILE = Join-Path $env:DATA_DIR 'preview.sqlite3'
    $env:SEED_ADMIN_USERNAME = 'admin'
    $env:SEED_ADMIN_EMAIL = 'admin@example.com'
    $env:SEED_ADMIN_PASSWORD = 'admin'
    Write-Host "Local test preview: $env:PUBLIC_URL (admin / admin). Uses separate .tmp data."
    & node --disable-warning=ExperimentalWarning ./server/src/index.js
    if ($LASTEXITCODE -ne 0) { throw "Preview exited with code $LASTEXITCODE. Check the startup log above." }
} finally { Pop-Location }
