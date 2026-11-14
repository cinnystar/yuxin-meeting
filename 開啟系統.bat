@echo off
cd /d %~dp0
start "" http://localhost:8791/
powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1
