@echo off
rem Internal helper used by launch_hidden.ps1. Do not double-click.
rem Paths come from environment variables so cmd /c only sees ONE quoted
rem argument (multiple quoted tokens break Win7 cmd /c quote handling).
set "NODE_BIN=%NODEEXE%"
if "%NODE_BIN%"=="" set "NODE_BIN=node"
"%NODE_BIN%" "%HIDDEN_SRV%" >> "%HIDDEN_LOG%" 2>&1
