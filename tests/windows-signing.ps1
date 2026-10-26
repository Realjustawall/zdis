$ErrorActionPreference = 'Stop'
$env:PATH = (Join-Path $env:ProgramFiles 'Git\usr\bin') + ';' + $env:PATH
$env:ZDIS_SIGNING_PASSWORD = 'Disposable-CI-Signing-Fixture-2026'
$folder = Join-Path $env:RUNNER_TEMP 'zdis-signing-regression'
$trusted = $null
try {
    @'
import importlib.util, os
from pathlib import Path
spec = importlib.util.spec_from_file_location('builder', 'scripts/build-server-clients.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
keys = Path(os.environ['RUNNER_TEMP'])/'zdis-signing-regression'
keys.mkdir(exist_ok=True)
builder.prepare_windows_signing(keys, 'fixture', os.environ.copy())
'@ | python -
    if ($LASTEXITCODE -ne 0) { throw 'Production certificate generator failed' }
    $trusted = Import-Certificate -FilePath (Join-Path $folder 'windows.crt') -CertStoreLocation Cert:\LocalMachine\Root -Confirm:$false
    $signer = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $folder 'windows.p12'), $env:ZDIS_SIGNING_PASSWORD)
    $probe = Join-Path $folder 'probe.ps1'
    Set-Content -Path $probe -Value 'Write-Output "Disposable code-signing fixture"'
    $signature = Set-AuthenticodeSignature -FilePath $probe -Certificate $signer -HashAlgorithm SHA256
    Write-Output ($signature | Format-List Status,StatusMessage | Out-String)
    if ($signature.Status -ne 'Valid') { throw "Windows rejected generated signing identity: $($signature.Status): $($signature.StatusMessage)" }
    Write-Output 'Production signing certificate accepted by Windows Authenticode.'
} finally {
    if ($trusted) { Remove-Item "Cert:\LocalMachine\Root\$($trusted.Thumbprint)" -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $folder -ErrorAction SilentlyContinue
    Remove-Item Env:\ZDIS_SIGNING_PASSWORD -ErrorAction SilentlyContinue
}
