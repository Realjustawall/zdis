@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup.ps1"
if errorlevel 1 goto failed
echo Installation complete. Run start-windows.cmd to start ZDIS.
pause
exit /b 0
:failed
echo Installation failed. Review the error above.
pause
exit /b 1
