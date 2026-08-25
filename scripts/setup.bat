@echo off
REM ============================================================================
REM One-shot local setup: installs dependencies. Pure API testing needs no
REM browser binaries (no `page`/`browser` fixture is used here), so there is
REM no `playwright install` step - see the `ui`/`sap` repos for that.
REM
REM Usage: scripts\setup.bat
REM ============================================================================
setlocal
cd /d "%~dp0\.."

echo == Installing dependencies ==========================================
call npm ci
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Try: npm test
endlocal
