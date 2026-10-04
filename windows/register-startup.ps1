param([string]$TaskName = 'ZDIS-Windows-Server')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $root 'windows/start.ps1') + '" -LogToFile'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'ZDIS single-process SQLite server' -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered $TaskName. Use Get-ScheduledTaskInfo to inspect status."
