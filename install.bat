@echo off
rem ============================================================================
rem  One-click dependency install for Windows (Python 3 + pip from PATH).
rem  Usage: double-click this file, or run it from a cmd window where
rem         "python" is the Python 3 you want to use.
rem  Node center is dependency-free: install Node 14+ (18.16.0 recommended).
rem  Pure ASCII on purpose (Win7 console/font breaks on UTF-8 text).
rem ============================================================================
cd /d "%~dp0"

echo ==== [1/3] Check Python 3 ====
python -c "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3 not found on PATH.
  echo Install Python 3 and add it to PATH, then run this again.
  pause
  exit /b 1
)
python --version

echo ==== [2/3] Check Node ====
where node >nul 2>nul
if errorlevel 1 (
  echo WARNING: node not found. Install Node 14+ ^(18.16.0 recommended^) before start.bat.
) else (
  for /f "tokens=*" %%v in ('node -v') do echo Node: %%v
)

echo ==== [3/3] pip install -r requirements.txt ====
python -m pip --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: pip not available for this Python. Install pip and retry.
  pause
  exit /b 1
)
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo ERROR: pip install failed. See messages above.
  pause
  exit /b 1
)

python -c "import pyte, wcwidth, PIL; print('IMPORT_OK  pyte/wcwidth/Pillow', PIL.__version__)"
if errorlevel 1 (
  echo ERROR: dependency import check failed.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  Install done.
echo  Start : start.bat  (or start_background.vbs for no-window mode)
echo  Web   : http://localhost:8082
echo  First run generates config\config.json and a random password in
echo  config\INITIAL_PASSWORD.txt - change it in the web UI, then delete it.
echo ============================================
pause
