param([string]$Destination)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path (Split-Path -Parent $sourceRoot) 'zdis-windows-server.zip' }
$archivePath = [IO.Path]::GetFullPath($Destination)
$temporaryArchive = $archivePath + '.building-' + [guid]::NewGuid().ToString('N')
$excludedDirectories = @('node_modules','.git','.tmp','.playwright-cli','output','data','uploads','logs','backups','test-results','playwright-report','coverage','Saved')
function Get-ReleaseFiles([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.PSIsContainer) {
            if ($item.Name -notin $excludedDirectories) { Get-ReleaseFiles $item.FullName }
        } elseif (-not ($item.Name.StartsWith('.env') -and -not $item.Name.EndsWith('.example')) -and $item.Name -notmatch '(\.log$|\.db$|\.sqlite[0-9]?(-wal|-shm)?$|\.tsbuildinfo$|\.zip$)') {
            $item
        }
    }
}
Add-Type -AssemblyName System.IO.Compression
try {
    $stream = [IO.File]::Open($temporaryArchive, [IO.FileMode]::CreateNew)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ReleaseFiles $sourceRoot) {
            $relative = $file.FullName.Substring($sourceRoot.Length + 1).Replace('\','/')
            $entry = $zip.CreateEntry('zdis-windows-server/' + $relative, [IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            $inputStream = [IO.File]::OpenRead($file.FullName)
            try { $inputStream.CopyTo($entryStream) } finally { $inputStream.Dispose(); $entryStream.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    Move-Item -LiteralPath $temporaryArchive -Destination $archivePath -Force
    Write-Host "Ready: $archivePath"
} finally {
    if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
}
