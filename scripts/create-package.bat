@echo off
REM ============================================================================
REM Builds this package and produces a versioned .tgz the exact same way
REM `npm publish` would, without needing a registry yet:
REM   - other repos on this machine can depend on it via
REM       "referenced-automation-api": "file:../shared-packages/referenced-automation-api-1.0.0.tgz"
REM   - or hand the .tgz to DevOps to `npm publish <file>.tgz --registry <nexus-npm-url>`
REM     once a private npm registry (e.g. Nexus) is wired up.
REM
REM Usage: scripts\create-package.bat [output-dir]
REM   Default output-dir: ..\shared-packages (sibling to this repo)
REM ============================================================================
setlocal
cd /d "%~dp0\.."

set "OUT_DIR=%~1"
if "%OUT_DIR%"=="" set "OUT_DIR=..\shared-packages"
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

call npm ci
if errorlevel 1 exit /b 1

call npm run build
if errorlevel 1 exit /b 1

set "TARBALL="
for /f "delims=" %%T in ('npm pack --silent') do set "TARBALL=%%T"
if not defined TARBALL (
  echo ERROR: npm pack did not produce a tarball. 1>&2
  exit /b 1
)

move /y "%TARBALL%" "%OUT_DIR%\" >nul
if errorlevel 1 (
  echo ERROR: failed to move %TARBALL% into %OUT_DIR%. 1>&2
  exit /b 1
)

echo.
echo Package written to: %OUT_DIR%\%TARBALL%
echo Consume it from another repo with:
echo   npm install %OUT_DIR%\%TARBALL%

endlocal
