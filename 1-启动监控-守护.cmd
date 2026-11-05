@echo off
chcp 936 >nul
title 闲鱼扫货监控 - 守护
cd /d "%~dp0"
set "RT=%~dp0runtime"
if exist "%~dp0runtime.txt" (
  for /f "usebackq delims=" %%a in ("%~dp0runtime.txt") do (
    if not defined RTSET (
      if exist "%%~a\playwright-driver\node.exe" set "RT=%%~a"
      set "RTSET=1"
    )
  )
)
if exist "%~dp0runtime\playwright-driver\node.exe" set "RT=%~dp0runtime"
set "PLAYWRIGHT_BROWSERS_PATH=%RT%\playwright-browsers"
echo 守护进程已启动，本窗口可以最小化，但不要关闭。
echo 它会每 60 秒检查一次监控是否还活着，死了就自动重新拉起。
echo.
rem 【启动即扫 2026-11-04】
rem 双击本文件 = 我要开始扫。后台挂一个助手，等监控起来了自动解除待命。
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-resume.ps1"
"%RT%\playwright-driver\node.exe" guard.cjs
pause
