@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start.ps1"
if errorlevel 1 pause
