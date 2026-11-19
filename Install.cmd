@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
set "gatewayInstallExit=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %gatewayInstallExit%
