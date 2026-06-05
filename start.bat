@echo off
REM Suhradam Volleyball Scoring - Windows one-click launcher.
REM Double-click this file in Explorer, or run start.bat in a terminal.

cd /d "%~dp0"

echo ============================================
echo    Suhradam Volleyball Scoring System
echo ============================================
echo.

REM 1. Check Node.js is available.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo.
  echo Please install the LTS version from https://nodejs.org
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo [OK] Node.js %NODEVER% found.

REM 2. Install dependencies on first run.
if not exist "node_modules" (
  echo.
  echo Installing dependencies ^(first run only, needs internet^)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
)

REM 3. Start the server.
echo.
echo Starting server... ^(close this window or press Ctrl+C to stop^)
echo.
node server.js
