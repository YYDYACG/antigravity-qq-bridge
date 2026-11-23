@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-agyqq.ps1" -WithNapCat -WithSovits -OpenHub
