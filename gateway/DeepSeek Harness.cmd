@echo off
powershell.exe -NoProfile -File "%~dp0Start-ModelClient.ps1" -Client DeepSeek
if errorlevel 1 pause
