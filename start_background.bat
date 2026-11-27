@echo off
rem ============================================================================
rem  Alternative background launcher using cmd + PowerShell (no VBScript).
rem  Use this if your Win7 blocks .vbs files. Unlike "start /B", the server is
rem  launched by PowerShell Start-Process -WindowStyle Hidden, which DETACHES
rem  from this console: this window closes by itself and the server keeps
rem  running. Output goes to logs\server.log (no console font involved).
rem  Pure ASCII on purpose - do not add Chinese text (Win7 font issue).
rem  To stop: run stop_background.vbs.
rem ============================================================================
cd /d "%~dp0"
if not exist logs mkdir logs

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH.
  echo         Install Node 18.16.0 and add it to PATH, then retry.
  pause
  exit /b 1
)

powershell -NoProfile -Command "Get-Command powershell" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PowerShell not available. Use start_background.vbs instead.
  pause
  exit /b 1
)

echo Starting inspection center in background (detached)...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch_hidden.ps1" -Server "%CD%\server.js" -LogFile "%CD%\logs\server.log"
if errorlevel 1 (
  echo [ERROR] Failed to launch. See messages above.
  pause
  exit /b 1
)

rem Give the server a moment to bind its port, then open the dashboard.
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:8082"

rem Exit normally - the hidden server process is detached and stays alive.
exit /b 0
