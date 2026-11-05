@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---- resolve runtime root (kept in runtime.txt as UTF-8) ----
set "RT="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::ReadAllText('%~dp0runtime.txt',[Text.Encoding]::UTF8).Trim()" 2^>nul`) do set "RT=%%i"

rem ---- 便携包：如果本目录带 runtime\ 就用它（搬走整个文件夹也能跑）----
if exist "%~dp0runtime\playwright-driver\node.exe" set "RT=%~dp0runtime"
if defined RT if "!RT:~-1!"=="\" set "RT=!RT:~0,-1!"
rem ---- fallback: 8.3 short name ----
rem (E: 盘的旧兜底已删除)

if not defined RT (
  echo.
  echo  [ERROR] Cannot locate the runtime.
  echo  Please edit runtime.txt so it contains the folder:
  echo    ^<install^>\playwright-runtime\amd64
  echo.
  pause
  exit /b 1
)
if not exist "!RT!\playwright-driver\node.exe" (
  echo.
  echo  [ERROR] node.exe not found under:
  echo    !RT!
  echo  Please make sure the app is still installed there.
  echo.
  pause
  exit /b 1
)

set "PLAYWRIGHT_BROWSERS_PATH=!RT!\playwright-browsers"

rem ---- open a real browser window so the user can log in manually ----
"!RT!\playwright-driver\node.exe" login-manual.cjs

endlocal