@echo off
REM ============================================================================
REM One-shot local setup - works from a completely fresh clone of the whole
REM repo family, in any order: builds whichever sibling packages this repo
REM depends on (from a sibling checkout, cloning nothing on its own) before
REM `npm ci`, since npm ci fails otherwise if e.g. referenced-automation-utils
REM hasn't been packaged into ..\shared-packages yet.
REM
REM Pure API testing needs no browser binaries (no `page`/`browser` fixture is
REM used here), so there is no `playwright install` step - see the `ui`/`sap`
REM repos for that.
REM
REM Usage: scripts\setup.bat
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "SHARED_PACKAGES_DIR=..\shared-packages"

echo == Ensuring dependency packages exist in %SHARED_PACKAGES_DIR% ==========
call :ensure_package referenced-automation-utils
if errorlevel 1 exit /b 1

echo.
echo == Installing dependencies ==========================================
call npm ci
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Try: npm test
endlocal
exit /b 0

:ensure_package
set "REPO_NAME=%~1"
set "FOUND="
for %%F in ("%SHARED_PACKAGES_DIR%\automation-%REPO_NAME%-*.tgz") do set "FOUND=%%F"
if defined FOUND (
  echo == %REPO_NAME%: already packaged ==
  exit /b 0
)
set "REPO_DIR=..\%REPO_NAME%"
if not exist "%REPO_DIR%" (
  echo ERROR: %REPO_NAME% is not packaged and not checked out at %REPO_DIR%. 1>&2
  echo Clone it as a sibling of this repo first: 1>&2
  echo   git clone https://github.com/achaljoshi/%REPO_NAME%.git %REPO_DIR% 1>&2
  exit /b 1
)
echo == Building %REPO_NAME% (dependency) ==
pushd "%REPO_DIR%"
REM %REPO_DIR% is a sibling of this repo at the same depth, so the relative
REM path to the shared packages folder is unchanged after pushd.
call scripts\create-package.bat "%SHARED_PACKAGES_DIR%"
set "BUILD_RESULT=%ERRORLEVEL%"
popd
exit /b %BUILD_RESULT%
