@echo off
setlocal
chcp 936 >nul
cd /d "%~dp0"

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "NODE=%HERE%\runtime\playwright-driver\node.exe"
set "CLI=%HERE%\runtime\playwright-driver\package\cli.js"
set "BROWSERS=%HERE%\runtime\playwright-browsers"
set "PLAYWRIGHT_BROWSERS_PATH=%BROWSERS%"

echo ============================================================
echo    下载闲鱼扫货监控所需的浏览器内核
echo ============================================================
echo.

if not exist "%NODE%" (
    echo  [错误] 找不到 node.exe
    echo         预期位置: %NODE%
    echo.
    echo  请确认整个文件夹是完整解压出来的，不要只复制部分文件。
    pause
    exit /b 1
)
if not exist "%CLI%" (
    echo  [错误] 找不到 cli.js
    echo         预期位置: %CLI%
    pause
    exit /b 1
)

echo  下载源:   https://cdn.playwright.dev
echo  存放位置: %BROWSERS%
echo  大约大小: 415 MB  ^(只装 Chromium，不装用不到的 headless shell^)
echo  预计耗时: 3 到 15 分钟，取决于网速
echo.
echo  下载过程中会显示进度条，解压阶段看起来像卡住，其实在解压，别关窗口。
echo ============================================================
echo.
pause
echo.

"%NODE%" "%CLI%" install chromium --no-shell
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo ============================================================
    echo  [失败] 下载没有完成 ^(返回码 %RC%^)
    echo ============================================================
    echo.
    echo  可以试这几个办法：
    echo   1. 检查网络后重新双击本文件
    echo   2. 如果一个都不行，手动下载下面这个链接：
    echo      https://cdn.playwright.dev/builds/cft/149.0.7827.55/win64/chrome-win64.zip
    echo      然后把压缩包里的 chrome-win64 文件夹整个放进：
    echo      %BROWSERS%\chromium-1228\
    echo      ^(也就是变成 %BROWSERS%\chromium-1228\chrome-win64\chrome.exe^)
    echo.
    pause
    exit /b %RC%
)

echo ============================================================
echo  [完成] 浏览器已装好
echo ============================================================
echo.
echo  现在可以双击【1-启动监控-无窗口.vbs】开始使用。
echo  第一次用请先双击【0-首次扫码登录.cmd】登录一次。
echo.
pause
exit /b 0