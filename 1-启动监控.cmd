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

rem 【启动即扫 2026-11-04】
rem 双击本文件本身就等于「我要开始扫」，不该停在待命。先挂一个后台助手，
rem 等监控把端口起来、并且还处在待命状态时，自动替用户点一次「开始监控」。
rem 托盘（闲鱼扫货监控.exe）不走这里，所以从托盘启动仍然停在待命 —— 那是刻意保留的。
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-resume.ps1"

rem ---- run monitor (node is a direct child of cmd: closing the window stops it quickly) ----
"!RT!\playwright-driver\node.exe" monitor.cjs

endlocal