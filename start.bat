@echo off
rem ============================================================================
rem  Foreground launcher - keeps the black window open so you can watch logs.
rem  IMPORTANT: this file is intentionally PURE ASCII.
rem  Do NOT add Chinese text here: Win7 raster font + chcp 65001 causes the
rem  error "The system cannot write to the specified device".
rem  Node writes its own Chinese logs via WriteConsoleW (font fallback needed;
rem  run fix_console_font.ps1 once if Chinese shows as boxes).
rem ============================================================================
cd /d "%~dp0"
title Daily Inspect Center (foreground)

echo ============================================
echo   Daily Inspect Center  -  foreground mode
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH.
  echo         Install Node 18.16.0 and add it to PATH, then retry.
  echo.
  pause
  exit /b 1
)

rem Optional: switch this console to a TrueType font so Chinese logs render.
rem Safe to fail - errors are suppressed.
if exist "%~dp0scripts\fix_console_font.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fix_console_font.ps1" >nul 2>&1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo Node version : %NODEVER%
echo Work dir     : %CD%
echo Web UI       : http://localhost:8082  (port auto-increments if busy)
echo Stop         : press Ctrl+C, or just close this window
echo.
echo Starting server...
echo.

node server.js

echo.
echo Server stopped.
pause
