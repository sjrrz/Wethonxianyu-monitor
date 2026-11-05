@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 重新登录闲鱼并恢复监控

rem ============================================================
rem  一键：先停监控 → 弹浏览器登录 → 存 cookie → 验证新鲜度 → 重启监控
rem  面板上点【立即重新登录】按钮，执行的就是这个文件。
rem ============================================================

rem ---- resolve runtime root (kept in runtime.txt as UTF-8) ----
set "RT="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::ReadAllText('%~dp0runtime.txt',[Text.Encoding]::UTF8).Trim()" 2^>nul`) do set "RT=%%i"
if exist "%~dp0runtime\playwright-driver\node.exe" set "RT=%~dp0runtime"
if defined RT if "!RT:~-1!"=="\" set "RT=!RT:~0,-1!"

if not defined RT (
  echo  [错误] 找不到运行时目录，请检查 runtime.txt
  pause & exit /b 1
)
if not exist "!RT!\playwright-driver\node.exe" (
  echo  [错误] 在下面这个目录里没找到 node.exe：
  echo    !RT!
  pause & exit /b 1
)
set "PLAYWRIGHT_BROWSERS_PATH=!RT!\playwright-browsers"
set "NODE=!RT!\playwright-driver\node.exe"

rem ---- 端口从 config.json 里读，别写死 ----
rem 以前这里写死 59288：用户一旦把 config.json 的 port 改成别的（比如为了和别的程序错开），
rem 这个脚本就永远探不到 /__scan/stop → 只能靠下面那步强杀 → 浏览器可能没正常收尾。
set "PORT=59288"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try{ $j=Get-Content '%~dp0config.json' -Raw -Encoding UTF8 | ConvertFrom-Json; if($j.port){ $j.port } else { 59288 } }catch{ 59288 }" 2^>nul`) do set "PORT=%%i"
if not defined PORT set "PORT=59288"

echo.
echo ============================================================
echo   第 1 步：停掉正在运行的监控
echo ============================================================
echo.
echo   登录要用同一个浏览器配置目录，监控开着就锁住了，必须先停。
echo.

rem ---- 先尝试优雅停止（调 /__scan/stop，会正常收尾关浏览器）----
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{ Invoke-WebRequest ('http://127.0.0.1:!PORT!/__scan/stop') -Method POST -TimeoutSec 4 -UseBasicParsing | Out-Null; Write-Host '  已发送停止指令' }catch{ Write-Host '  监控本来就没在运行' }"
timeout /t 5 /nobreak >nul

rem ---- 兜底：还在就强杀 ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*monitor.cjs*' }; if($p){ Write-Host ('  强制结束残留监控 PID=' + ($p.ProcessId -join ',')); $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } else { Write-Host '  监控已停止' }"
timeout /t 2 /nobreak >nul

echo.
echo ============================================================
echo   第 2 步：在弹出的浏览器窗口里登录闲鱼
echo ============================================================
echo.
echo   * 手机扫码 或 账号密码登录 都可以
echo   * 登录完它会自动保存 cookie 并验证数据新鲜度
echo   * 验证通过后 15 秒自动关窗口，然后监控自动重启
echo   * 如果 20 分钟没登录，这个窗口会自己退出
echo.
echo   正在打开浏览器...
echo.

"!NODE!" login-manual.cjs
set "LOGIN_EXIT=!errorlevel!"

echo.
echo ============================================================
echo   第 3 步：检查结果并重启监控
echo ============================================================
echo.

if not "!LOGIN_EXIT!"=="0" (
  echo   [注意] 登录程序退出码 = !LOGIN_EXIT!
  echo   如果是你手动关掉了窗口，属正常。
  echo.
)

if exist "data\cookies.json" (
  echo   已找到 cookie 文件：data\cookies.json
) else (
  echo   [警告] 没找到 data\cookies.json —— 说明这次没登录成功。
  echo   监控还是会启动，但可能仍拿不到最新数据。
)

echo.
echo   正在重启监控...
echo.

cd /d "%~dp0"
rem 【修 BUG-P】原来这行是 start "" cmd /c "1-启动监控.cmd"。
rem 那个 cmd 只是一次性中转：登录脚本这个窗口一关，它就结束；而新起的 monitor 把
rem process.ppid 当成父进程，5 秒后发现它没了 → 自我收尾退出。
rem 表现出来就是：登录完成、窗口一闪、面板打不开 —— 用户说成"启动不了、一直没登录"。
rem 现在直接把 SCAN_KEEP_ALIVE 交给新实例，并绕开那个短命 cmd 中转层。
set "SCAN_KEEP_ALIVE=1"
start "" "!RT!\playwright-driver\node.exe" monitor.cjs

rem 【启动即扫 2026-11-04】
rem 扫码登录成功的意图就是「重新开始扫」，不能让它在待命里干等着。
rem start-resume.ps1 会轮询端口，等 monitor 起来后如果是待命就自动 POST /__scan/resume。
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-resume.ps1"

echo.
echo   监控已重新启动，界面稍后会自动打开：
echo     http://127.0.0.1:!PORT!/
echo.
echo   本窗口 8 秒后自动关闭。
timeout /t 8 /nobreak >nul
endlocal
