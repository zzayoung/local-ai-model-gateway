@echo off
powershell.exe -NoProfile -File "%~dp0Start-ClaudeCode.ps1" %*
if errorlevel 1 pause
