param(
    [Parameter(Mandatory=$true)][string]$NodeIp,
    [string]$LiveKitExecutable,
    [ValidateRange(1,65535)][int]$Port = 18181,
    [ValidateRange(1,65535)][int]$SignalPort = 18880,
    [ValidateRange(1,65535)][int]$TcpPort = 18881,
    [ValidateRange(1,65535)][int]$UdpPort = 18882,
    [ValidateRange(1,65535)][int]$TurnPort = 18883,
    [ValidateRange(1,65535)][int]$RelayStart = 18884,
    [ValidateRange(1,65535)][int]$RelayEnd = 18893
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$parsedIp = $null
if (-not [Net.IPAddress]::TryParse($NodeIp, [ref]$parsedIp) -or $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'NodeIp must be the IPv4 address of this computer on your network.'
}
if ([Net.IPAddress]::IsLoopback($parsedIp)) { throw 'Use the network IPv4 address, not loopback, for media candidates.' }
$localAddresses = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $_.GetIPProperties().UnicastAddresses | ForEach-Object { $_.Address.ToString() } })
if ($NodeIp -notin $localAddresses) { throw 'NodeIp is not assigned to this computer. Check its current network IPv4 address.' }
if (-not $LiveKitExecutable) { $LiveKitExecutable = Join-Path $root '.tmp/livekit-qa/livekit-server.exe' }
$LiveKitExecutable = [IO.Path]::GetFullPath($LiveKitExecutable)
if (-not (Test-Path -LiteralPath $LiveKitExecutable -PathType Leaf)) { throw 'Provide -LiveKitExecutable with the path to the Windows LiveKit server binary.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'client/dist/index.html'))) { throw 'Run npm.cmd run build first.' }
if (@($Port,$SignalPort,$TcpPort,$UdpPort,$TurnPort | Select-Object -Unique).Count -ne 5) { throw 'Use distinct ports.' }
if ($RelayEnd -lt $RelayStart -or @($Port,$SignalPort,$TcpPort,$UdpPort,$TurnPort | Where-Object { $_ -ge $RelayStart -and $_ -le $RelayEnd }).Count) { throw 'Use a separate, ordered TURN relay port range.' }
# Reject duplicate launches before creating any child process or changing keys.
foreach ($listenPort in @($Port,$SignalPort,$TcpPort)) {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any,$listenPort)
    $probe.Server.ExclusiveAddressUse = $true
    try { $probe.Start() } catch { throw "TCP port $listenPort is already in use. Stop the existing preview first." } finally { $probe.Stop() }
}
foreach ($listenPort in @($UdpPort,$TurnPort)+@($RelayStart..$RelayEnd)) {
    $udpProbe = New-Object Net.Sockets.UdpClient
    try { $udpProbe.Client.ExclusiveAddressUse=$true; $udpProbe.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Any,$listenPort)) } catch { throw "UDP port $listenPort is already in use." } finally { $udpProbe.Dispose() }
}
$data = Join-Path $root '.tmp/preview-latest'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$credentialsFile = Join-Path $data 'livekit-credentials.json'
if (-not (Test-Path -LiteralPath $credentialsFile)) {
    $randomBytes = New-Object byte[] 48
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
    @{apiKey=('preview_'+[guid]::NewGuid().ToString('N'));apiSecret=[Convert]::ToBase64String($randomBytes)} |
        ConvertTo-Json | Set-Content -LiteralPath $credentialsFile -Encoding UTF8
}
$credentials = Get-Content -LiteralPath $credentialsFile -Raw | ConvertFrom-Json
$previousKeys = $env:LIVEKIT_KEYS
$env:LIVEKIT_KEYS = $credentials.apiKey + ': ' + $credentials.apiSecret
$networkConfig = Join-Path $data 'livekit-network.yaml'
@"
rtc:
  ips:
    includes: ["$NodeIp/32"]
"@ | Set-Content -LiteralPath $networkConfig -Encoding UTF8
$media = $null
try {
    $media = Start-Process -FilePath $LiveKitExecutable -ArgumentList @('--config',('"'+$networkConfig+'"'),'--bind','0.0.0.0','--node-ip',$NodeIp,'--port',"$SignalPort",'--rtc.tcp_port',"$TcpPort",'--udp-port',"$UdpPort",'--turn.enabled','--turn.udp_port',"$TurnPort",'--turn.relay_range_start',"$RelayStart",'--turn.relay_range_end',"$RelayEnd",'--logging.level','warn') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data 'livekit-stdout.log') -RedirectStandardError (Join-Path $data 'livekit-stderr.log')
    $ready = $false
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        if ($media.HasExited) { throw "LiveKit exited. Read $data/livekit-stderr.log" }
        $tcp = New-Object Net.Sockets.TcpClient
        try { $tcp.Connect('127.0.0.1',$SignalPort); $ready=$true; break } catch { Start-Sleep -Milliseconds 250 } finally { $tcp.Dispose() }
    }
    if (-not $ready) { throw 'LiveKit did not start within ten seconds.' }
    $env:LIVEKIT_URL = "ws://127.0.0.1:$SignalPort"
    $env:LIVEKIT_API_URL = "http://127.0.0.1:$SignalPort"
    $env:LIVEKIT_API_KEY = $credentials.apiKey
    $env:LIVEKIT_API_SECRET = $credentials.apiSecret
    Write-Host "LiveKit media ready: UDP $UdpPort, TCP $TcpPort, candidate $NodeIp."
    & (Join-Path $PSScriptRoot 'preview.ps1') -Port $Port
} finally {
    $env:LIVEKIT_KEYS = $previousKeys
    if ($media -and -not $media.HasExited) { Stop-Process -InputObject $media -Force }
}
