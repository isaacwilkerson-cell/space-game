@echo off
title Space Game Server
:loop
echo Starting Space Game server on http://localhost:8080...
powershell -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo Server stopped. Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto loop
