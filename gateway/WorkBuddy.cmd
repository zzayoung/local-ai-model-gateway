@echo off
powershell.exe -NoProfile -File "%~dp0Start-ModelClient.ps1" -Client WorkBuddy
if errorlevel 1 pause
