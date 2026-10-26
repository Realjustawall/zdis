param([Parameter(Mandatory=$true)][string]$Candidates)
$ErrorActionPreference = 'Stop'
$candidatePath = (Resolve-Path $Candidates).Path
$manifest = Get-Content (Join-Path $candidatePath 'manifest.json') -Raw | ConvertFrom-Json
$installer = Join-Path $candidatePath 'ZDis-Setup.exe'
Write-Output 'PHASE: inspect installer signer'
$certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (Join-Path $candidatePath 'ZDis-Server-Certificate.crt')
$signature = Get-AuthenticodeSignature $installer
if (!$signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw 'Installer signer differs from dedicated server certificate'
}
# Use the disposable hosted machine's store for unattended verification. The
# current-user root store can display a consent dialog on a noninteractive runner.
$trusted = $null
$installDir = Join-Path $env:RUNNER_TEMP 'zdis-client-smoke'
$process = $null
try {
    Write-Output 'PHASE: trust the disposable CI signing certificate'
    $trusted = Import-Certificate -FilePath (Join-Path $candidatePath 'ZDis-Server-Certificate.crt') -CertStoreLocation Cert:\LocalMachine\Root -Confirm:$false
    $verified = Get-AuthenticodeSignature $installer
    Write-Output ($verified | Format-List Status,StatusMessage,SignerCertificate | Out-String)
    if ($verified.Status -ne 'Valid') { throw "Invalid installer signature: $($verified.Status): $($verified.StatusMessage)" }
    Write-Output 'PHASE: silently install the signed client'
    $setup = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$installDir" -PassThru
    if (!$setup.WaitForExit(120000)) {
        Stop-Process -Id $setup.Id -Force -ErrorAction SilentlyContinue
        throw 'Silent installer did not exit within 120 seconds'
    }
    if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
    $exe = Join-Path $installDir "ZDis $($manifest.serverId).exe"
    if (!(Test-Path $exe)) { throw "Installed executable missing: $exe" }
    $verifiedExe = Get-AuthenticodeSignature $exe
    if ($verifiedExe.Status -ne 'Valid') { throw "Installed executable signature is invalid: $($verifiedExe.Status): $($verifiedExe.StatusMessage)" }
    Write-Output 'PHASE: inspect the installed server configuration'
    $env:ZDIS_SMOKE_ASAR = Join-Path $installDir 'resources/app.asar'
    $env:ZDIS_SMOKE_ORIGIN = $manifest.serverUrl
    $env:ZDIS_SMOKE_ID = $manifest.serverId
    Push-Location native/windows
    try {
        node --input-type=module -e 'import {extractFile} from "@electron/asar"; const c=JSON.parse(extractFile(process.env.ZDIS_SMOKE_ASAR,"server.json").toString()); if(c.serverUrl!==process.env.ZDIS_SMOKE_ORIGIN || c.serverId!==process.env.ZDIS_SMOKE_ID) throw Error("Incorrect embedded server");'
        if ($LASTEXITCODE -ne 0) { throw 'Embedded Windows server configuration check failed' }
    } finally { Pop-Location }
    Write-Output 'PHASE: launch the installed executable'
    $process = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds 10
    if ($process.HasExited) { throw 'Installed app exited during launch' }
    Write-Output 'Windows signature, embedded server, installation and process launch passed.'
} finally {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id -Force }
    if ($trusted) { Remove-Item "Cert:\LocalMachine\Root\$($trusted.Thumbprint)" -ErrorAction SilentlyContinue }
}
