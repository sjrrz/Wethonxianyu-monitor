<#
  闲鱼扫货监控 · 托盘控制台
  ============================================================================
  作用：开机后在右下角放一个小圆点图标，右键就能启动 / 停止 / 重启监控、打开界面、
        打开数据目录和日志、重新扫码登录、开关「开机自动启动」。
        不用再去记 7 个 .cmd 该双击哪一个。

  设计参考开源项目 ydisks-xianyu-helper 的 xianyu-tray 实现：
        它那边是 Go + systray 托盘 + Windows 服务；这边不装服务
        （服务跑在 session 0，弹不出扫码窗口，也要管理员权限），
        改成「托盘 + 现有 guard.cjs 当后台守护」，仍跑在当前用户会话里。

  状态来源：GET /__scan/selfcheck  —— 只读、不发搜索请求、不扰动风控。
        rank = ok / warn / bad  → 图标绿 / 黄 / 红；连不上 → 灰。

  用法：
        双击「闲鱼扫货监控.exe」（无窗口）或直接跑
        powershell -NoProfile -ExecutionPolicy Bypass -File 托盘.ps1

  单实例：用 Local\XianyuScanTray 互斥量，重复双击只会有一个图标。

  【注意】本文件必须以 UTF-8 with BOM 保存 —— PowerShell 5.1 对无 BOM 的
          UTF-8 会按 ANSI 解读，中文菜单会变乱码。
  ============================================================================
#>
param(
    # 自检模式：不开窗、不驻留，只打印当前状态后退出，用来验证脚本本身没坏
    [switch]$SelfTest,
    # 只启停、不驻留（给排查和自动化用；菜单里点的是同一套函数）
    [switch]$StartOnly,
    [switch]$StopOnly,
    # 只做「退出程序」那套收尾（停监控/停守护/收 Chromium/清残留），不驻留
    [switch]$QuitOnly
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 高 DPI 声明
# 【模糊根因 2026-10-29】本机是 2K 屏（2160×1440 物理）+ 150% 系统缩放。
# PowerShell 5.1 进程默认「DPI 不感知」，系统会把整个窗口（含右键菜单）
# 当位图拉伸 1.5 倍 → 文字、圆角、图标全都发糊，和别的软件格格不入。
# 必须在创建任何 WinForms 窗口之前声明感知，否则不生效。
if (-not ('DpiCtx' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DpiCtx {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
"@
}
$DPI_OK = $false
try {
    # PER_MONITOR_AWARE_V2 = -4（Win10 1703+，最精细；不同 DPI 的多屏也不糊）
    $DPI_OK = [DpiCtx]::SetProcessDpiAwarenessContext([IntPtr](-4))
    if (-not $DPI_OK) { $DPI_OK = [DpiCtx]::SetProcessDPIAware() }
} catch {
    try { $DPI_OK = [DpiCtx]::SetProcessDPIAware() } catch { }
}

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

# ---------------------------------------------------------------- 基础工具
function Get-Port {
    $p = 59288
    $cfg = Join-Path $root 'config.json'
    if (Test-Path -LiteralPath $cfg) {
        try {
            $j = [System.IO.File]::ReadAllText($cfg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($j.port) { $p = [int]$j.port }
        } catch { }
    }
    return $p
}

function Get-NodeExe {
    $c = Join-Path $root 'runtime\playwright-driver\node.exe'
    if (Test-Path -LiteralPath $c) { return $c }
    $rtFile = Join-Path $root 'runtime.txt'
    if (Test-Path -LiteralPath $rtFile) {
        try {
            $rt = ([System.IO.File]::ReadAllText($rtFile, [System.Text.Encoding]::UTF8)).Trim()
            if ($rt) {
                $c2 = Join-Path $rt 'playwright-driver\node.exe'
                if (Test-Path -LiteralPath $c2) { return $c2 }
            }
        } catch { }
    }
    return $null
}

# ---------------------------------------------------------------- 开发者功能
# 只有开发者自己的 config.json 里 developerMode=true 时才显示「发公告」。
# 打包给用户的 config.example.json 默认 false，用户托盘里不会有这个入口。
function Get-DeveloperMode {
    $cfg = Join-Path $root 'config.json'
    if (Test-Path -LiteralPath $cfg) {
        try {
            $j = [System.IO.File]::ReadAllText($cfg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            return ($null -ne $j.developerMode -and $j.developerMode -eq $true)
        } catch { }
    }
    return $false
}

function Test-Port {
    param([int]$Port)
    try {
        $c = [System.Net.Sockets.TcpClient]::new()
        $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(300)) { try { $c.Close() } catch { } return $false }
        try { $c.EndConnect($ar) } catch { try { $c.Close() } catch { } return $false }
        try { $c.Close() } catch { }
        return $true
    } catch {
        return $false
    }
}

function Get-SelfCheck {
    param([int]$Port)
    $url = "http://127.0.0.1:$Port/__scan/selfcheck?t=$([DateTime]::UtcNow.Ticks)"
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -ne 200) { return $null }
        return ($r.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-GuardPids {
    # 靠 data\guard.pid 认自己人，而不是在命令行里搜 'guard.cjs'。
    # 原因：启动参数传的是相对路径，命令行里没有绝对路径，
    # 同一目录的多个副本（备份包解压出来的那份）会互相认错 ——
    # 点「停止监控」把别人的守护杀掉、点「启动监控」又因为别人在跑而拒绝启动。
    $pidf = Join-Path $root 'data\guard.pid'
    if (-not (Test-Path -LiteralPath $pidf)) { return @() }
    $raw = ''
    try { $raw = ([System.IO.File]::ReadAllText($pidf)).Trim() } catch { return @() }
    $n = 0
    if (-not [int]::TryParse($raw, [ref]$n)) { return @() }
    $p = Get-Process -Id $n -ErrorAction SilentlyContinue
    if (-not $p) {
        # pid 文件是上次没清干净的残留，顺手删掉
        try { Remove-Item -LiteralPath $pidf -Force -ErrorAction SilentlyContinue } catch { }
        return @()
    }
    return @($n)
}

# ---------------------------------------------------------------- 开机自启
$RUN_KEY = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RUN_NAME = 'XianyuScanTray'

function Get-AutostartValue {
    try {
        $v = (Get-ItemProperty -Path $RUN_KEY -Name $RUN_NAME -ErrorAction Stop).$RUN_NAME
        return [string]$v
    } catch {
        return ''
    }
}

function Set-Autostart {
    param([bool]$On)
    # 【2026-11-04 修】原来这里只认 托盘.vbs，但那个文件早在改成 exe 启动器时就删了，
    # 于是点「开机自动启动」必定弹「找不到 托盘.vbs」。现在优先用 exe（便携版主入口），
    # exe 不在才回落到 vbs（老版本目录兼容）。
    $exe = Join-Path $root '闲鱼扫货监控.exe'
    $vbs = Join-Path $root '托盘.vbs'
    if ($On) {
        if (Test-Path -LiteralPath $exe) {
            $val = '"' + $exe + '"'
        } elseif (Test-Path -LiteralPath $vbs) {
            $val = 'wscript.exe "' + $vbs + '"'
        } else {
            throw "找不到启动入口（闲鱼扫货监控.exe 或 托盘.vbs），无法设置开机自启"
        }
        New-ItemProperty -Path $RUN_KEY -Name $RUN_NAME -Value $val -PropertyType String -Force | Out-Null
    } else {
        Remove-ItemProperty -Path $RUN_KEY -Name $RUN_NAME -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- 启停逻辑
function Start-All {
    param([int]$Port, [string]$NodeExe, [scriptblock]$Log)
    $pids = Get-GuardPids
    if ($pids.Count -gt 0) {
        & $Log "守护已经在跑（PID $($pids -join ',')），不重复启动"
        return $true
    }
    if (-not $NodeExe) { & $Log '找不到 node.exe，无法启动'; return $false }

    # 【必须】先清掉 monitor-exit.json。
    # monitor 正常停止时会写这个标记（reason=stop），守护看到新鲜标记就会进入
    # 「尊重期」——10 分钟内既不拉起也不报警。如果用户刚点完「停止监控」又马上点
    # 「启动监控」，新起的守护会读到这个标记，然后干等 10 分钟什么都不做，
    # 表现就是「点了启动没反应」。手动启动的语义是「我就是要它现在跑」，
    # 所以这个标记必须先删。
    $mk = Join-Path $root 'data\monitor-exit.json'
    if (Test-Path -LiteralPath $mk) {
        try { Remove-Item -LiteralPath $mk -Force -ErrorAction Stop; & $Log '已清掉上次的停止标记（否则守护会等 10 分钟才拉起）' } catch { }
    }

    # 告诉守护「这次是用户手动点的启动」，别发「监控已停止运行」那条告警
    $mf = Join-Path $root 'data\manual-start.json'
    try { [System.IO.File]::WriteAllText($mf, '{"at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}') } catch { }

    Start-Process -FilePath $NodeExe -ArgumentList 'guard.cjs' -WorkingDirectory $root -WindowStyle Hidden

    # 等它就绪（守护每 CHECK_MS 探一次，然后 spawn monitor；面板端口通了才算成）
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-SelfCheck -Port $Port) { return $true }
    }
    return $false
}

function Stop-All {
    param([int]$Port, [scriptblock]$Log)
    # 1) 先让 monitor 自己体面退出（会写 monitor-exit.json，守护才知道是"用户停的"）
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/__scan/stop" -Method POST -TimeoutSec 6 -UseBasicParsing | Out-Null
        & $Log '监控已收到停止指令，等待退出…'
    } catch {
        & $Log '监控没响应（可能已经不在了），直接清理'
    }
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 150
        if (-not (Test-Port -Port $Port)) { break }
    }
    # 2) 再关守护，否则它 10 分钟尊重期一过又会把监控拉起来
    $pids = Get-GuardPids
    foreach ($p in $pids) {
        try { Stop-Process -Id $p -Force -ErrorAction Stop; & $Log "已关闭守护进程 PID $p" } catch { & $Log "关闭守护 PID $p 失败：$($_.Exception.Message)" }
    }
    if ($pids.Count -eq 0) { & $Log '守护本来就没在跑' }
    return $true
}

# ---------------------------------------------------------------- 彻底退出
# 「退出程序」用的就是这个。Stop-All 只保证"进程不在了"，但端口没释放、
# Chromium 子进程变成孤儿、被 Force 杀掉的 monitor 来不及写退出标记，
# 都会让用户下次双击时状态脏。这里逐个兜底收干净。
function Stop-Everything {
    param([int]$Port, [scriptblock]$Log)

    $null = Stop-All -Port $Port -Log $Log

    # 端口和 Chromium 的兜底收尾不在这里同步做了：monitor 自己体面退出时已经
    # process.exit（释放端口）+ killByProfileAsync（后台收本目录 Chromium），
    # 这里的 Get-NetTCPConnection / Get-CimInstance 只是「monitor 被强杀」的极端兜底，
    # 不该让用户点「退出程序」时干等好几秒（首次 Get-NetTCPConnection JIT 就要 1 秒多）。
    # 极端情况由下次启动的 cleanStaleOnStart / sweepDataJunk 兜底。

    # ③ 残留的 pid / 标记文件清掉，下次启动是干净状态
    foreach ($f in @('guard.pid', 'manual-start.json')) {
        try {
            $p = Join-Path $root ('data\' + $f)
            if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
        } catch { }
    }

    return $true
}

# ---------------------------------------------------------------- 图标
# 【PNG 图标 2026-11-03】用户提供了一张 1254×1254 带透明通道的原图，用来换掉网页图标和托盘图标。
# 托盘四态仍然是「底图 + 右下角状态圆点」：底图 = 用户原图，圆点绿/黄/红/灰原样不动。
# 这样外观换成用户自己的图，状态语义一点没变 —— 用户依旧靠右下角颜色判断死活。
# 四张 ico（tray-ok / tray-warn / tray-bad / tray-off）由原图离线生成在程序目录，
# 运行时只读文件、不再手绘 —— 少一段 GDI+ 代码，也不用每次 tick 重新生成位图。
# 万一 ico 被删了（拷贝给别人时漏拷），回落成原来那个纯色圆点，托盘绝不因此起不来。
# 【目录整理 2026-11-05】四张 ico 移到了 assets\ 子目录，这里只写文件名，
# 实际路径在 New-DotIcon 里用 $script:TrayIcoDir 拼。
$script:TrayIcoDir = Join-Path $root 'assets'
$script:TrayIcoMap = @{
    '#16a34a' = 'tray-ok.ico'
    '#f59e0b' = 'tray-warn.ico'
    '#dc2626' = 'tray-bad.ico'
    '#9ca3af' = 'tray-off.ico'
}

function New-DotIcon {
    param([string]$Hex)
    $key = ([string]$Hex).ToLower()
    $file = $script:TrayIcoMap[$key]
    if ($file) {
        $full = Join-Path $script:TrayIcoDir $file
        if (Test-Path -LiteralPath $full) {
            try {
                # 托盘只用得到 SmallIconSize（本机 150% DPI 下是 24×24）。
                # 不指定尺寸时 .NET 会挑 48×48 那帧再让系统缩下去 = 多一次重采样、边缘发糊；
                # 直接要 24 那帧是逐像素映射的，最锐。取不到就退回默认行为。
                $want = [System.Windows.Forms.SystemInformation]::SmallIconSize
                try { $ico = [System.Drawing.Icon]::new($full, $want) }
                catch { $ico = [System.Drawing.Icon]::new($full) }
                # 必须留住 ico 对象，否则 GC 之后托盘图标会变空白
                $script:IconKeep[$key] = @{ ico = $ico; file = $full }
                return $ico
            } catch { }
        }
    }
    # ---- 回落：原来的纯色圆点 ----
    $c = [System.Drawing.ColorTranslator]::FromHtml($Hex)
    $bmp = [System.Drawing.Bitmap]::new(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $b = [System.Drawing.SolidBrush]::new($c)
    $g.FillEllipse($b, 1, 1, 30, 30)
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(235, 255, 255, 255), 3)
    $g.DrawEllipse($pen, 1, 1, 30, 30)
    $pen.Dispose(); $b.Dispose(); $g.Dispose()
    $h = $bmp.GetHicon()
    $ico = [System.Drawing.Icon]::FromHandle($h)
    $script:IconKeep[$key] = @{ bmp = $bmp; hicon = $h; ico = $ico }
    return $ico
}

$script:IconKeep = @{}

# ---------------------------------------------------------------- 自检模式
if ($SelfTest) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $port = Get-Port
    $node = Get-NodeExe
    "root      = $root"
    "port      = $port"
    "node      = $node"
    $j = Get-SelfCheck -Port $port
    if ($j) {
        "selfcheck = HTTP 200 rank=$($j.rank) summary=$($j.summary) roundNo=$($j.roundNo) uptimeSec=$($j.uptimeSec)"
        "items     = " + (($j.items | ForEach-Object { "$($_.key)=$($_.rank)" }) -join ' | ')
    } else {
        "selfcheck = 连不上（监控没在跑）"
    }
    $gp = Get-GuardPids
    "guardPids = " + (($gp | ForEach-Object { $_ }) -join ',')
    "autostart = " + (Get-AutostartValue)
    $script:IconKeep = @{}
    $ico = New-DotIcon -Hex '#16a34a'
    "icon      = $($ico.Width)x$($ico.Height) OK"
    "selftest  = PASS"
    exit 0
}

# ---------------------------------------------------------------- 只启停、不驻留
# 给排查和自动化用（双击菜单走的是同一套 Start-All / Stop-All）。
if ($StartOnly) {
    $port = Get-Port
    $node = Get-NodeExe
    $ok = Start-All -Port $port -NodeExe $node -Log { param($m) Write-Output $m }
    $j = Get-SelfCheck -Port $port
    if ($j) { "start = OK  rank=$($j.rank) summary=$($j.summary) roundNo=$($j.roundNo)" }
    else { "start = FAILED（探不通端口 $port）" }
    exit ([int](-not $ok))
}
if ($StopOnly) {
    $port = Get-Port
    $null = Stop-All -Port $port -Log { param($m) Write-Output $m }
    $j = Get-SelfCheck -Port $port
    if ($j) { "stop = 还在跑（端口 $port 仍有响应）"; exit 1 }
    $gp = Get-GuardPids
    if ($gp.Count -gt 0) { "stop = 守护还在（PID $($gp -join ',')）"; exit 1 }
    "stop = OK（监控与守护都已停止）"
    exit 0
}
if ($QuitOnly) {
    # 菜单「退出程序」走的是同一个 Stop-Everything，这里只是不驻留地跑一遍，便于验证
    $port = Get-Port
    $null = Stop-Everything -Port $port -Log { param($m) Write-Output $m }
    $j = Get-SelfCheck -Port $port
    $gp = Get-GuardPids
    $left = 0
    try {
        $prof = Join-Path $root 'data\browser-profile'
        $left = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($prof, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
            Where-Object { $_.Name } | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count
    } catch { }
    "port      = " + $(if ($j) { '仍在响应（异常）' } else { '已释放' })
    "guard     = " + $(if ($gp.Count -gt 0) { "还在跑 PID $($gp -join ',')" } else { '已停止' })
    "chromium  = " + $(if ($left -gt 0) { "还有 $left 个" } else { '已收干净' })
    if ($j -or $gp.Count -gt 0 -or $left -gt 0) { "quit = 有残留"; exit 1 }
    "quit = OK（整个程序已退出）"
    exit 0
}

# ---------------------------------------------------------------- 单实例
$mutex = [System.Threading.Mutex]::new($false, 'Local\XianyuScanTray')
$gotMutex = $false
try { $gotMutex = $mutex.WaitOne(0, $false) } catch [System.Threading.AbandonedMutexException] { $gotMutex = $true }
if (-not $gotMutex) { exit 0 }   # 已经有一个托盘在跑了

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Port = Get-Port
$script:NodeExe = Get-NodeExe
$script:Busy = $false
$script:St = @{ rank = 'unknown'; summary = '还没探到'; roundNo = 0; alive = $false; hold = $false }
$script:BootAutoStarted = $false
$script:TickCount = 0

$script:IconOk = New-DotIcon -Hex '#16a34a'   # 绿：一切正常
$script:IconWarn = New-DotIcon -Hex '#f59e0b' # 黄：能用但有要留意的
$script:IconBad = New-DotIcon -Hex '#dc2626'  # 红：有问题
$script:IconOff = New-DotIcon -Hex '#9ca3af'  # 灰：没在跑 / 连不上

# ---------------------------------------------------------------- 菜单
# 【原生菜单 2026-10-29】之前用 ContextMenuStrip + 自绘渲染器：圆角浅色块、绿色对勾、
# 行距放宽 6px。看着挺现代化，但和 Win11 自己的菜单比，仍是两套画法、两套尺寸。
# 现在换成 Win32 原生菜单（ContextMenu ⇒ 弹出窗口类 #32768）：
#   · 圆角由 DWM 自己画（本机实测 corner=3 = DWMWCP_ROUNDSMALL）
#   · 底色 #F9F9F9、行高 18px、字体跟系统菜单走
#   · 深色模式 / 高 DPI / 系统字号放大 全部自动跟随，不用自己算坐标
# 效果：和资源管理器、和其它所有软件的托盘菜单长得一模一样。
$menu = [System.Windows.Forms.ContextMenu]::new()

function Add-Mi {
    param([string]$Text)
    $mi = [System.Windows.Forms.MenuItem]::new($Text)
    [void]$menu.MenuItems.Add($mi)
    return $mi
}
function Add-Sep {
    [void]$menu.MenuItems.Add([System.Windows.Forms.MenuItem]::new('-'))
}

$miStatus = Add-Mi '状态：检查中…'
$miStatus.Enabled = $false
Add-Sep

$miOpen = Add-Mi '打开监控界面'
$miDataDir = Add-Mi '打开数据目录'
$miLog = Add-Mi '打开日志文件'
Add-Sep

$miStart = Add-Mi '启动监控'
# 【启动待命 2026-11-04】程序启动后默认处于「待命」：浏览器和登录态已就绪，但不发任何搜索请求。
# 这一项是「待命 ⇄ 扫描中」的切换，和上下那几个「进程级」的启动/停止不是一回事。
# 文案刻意保持短（原生菜单按最宽项定宽，超过 84px 会把左边的白边撑回来）。
$miHold = Add-Mi '▶ 开始监控'
$miStop = Add-Mi '停止监控'
$miRestart = Add-Mi '重启监控'
Add-Sep

$miRelogin = Add-Mi '重新扫码登录'
if (Get-DeveloperMode) {
    Add-Sep
    $miAnnounce = Add-Mi '📢 发公告'
} else {
    $miAnnounce = $null
}
Add-Sep

$miAutostart = Add-Mi '开机自动启动'
Add-Sep

$miQuit = Add-Mi '退出程序'
Add-Sep
# 【署名 2026-11-03】菜单最底部的灰色版本/作者行（Notepad、VS Code 托盘同款做法）。
# 它是 disabled 的，点不动、只用来标明版本与作者。
# 注意：原生菜单按「最宽的菜单项」定宽 —— 这一行必须短于当前最宽项，
# 否则整条菜单会被撑宽、左边的白边又会回来（当时最宽项实测 170px）。
$miVer = Add-Mi 'Wethon 1.0.0'
$miVer.Enabled = $false

# ---------------------------------------------------------------- 通知区图标
$notify = [System.Windows.Forms.NotifyIcon]::new()
$notify.Icon = $script:IconOff
$notify.Text = '闲鱼扫货监控'
$notify.Visible = $true
$notify.ContextMenu = $menu
function Show-AnnounceDialog {
    $frm = [System.Windows.Forms.Form]::new()
    $frm.Text = '发公告'
    $frm.StartPosition = 'CenterScreen'
    $frm.FormBorderStyle = 'FixedDialog'
    $frm.MaximizeBox = $false
    $frm.MinimizeBox = $false
    $frm.ClientSize = [System.Drawing.Size]::new(440, 232)

    $lbl = [System.Windows.Forms.Label]::new()
    $lbl.Text = '第一行当标题，后面的行当正文；只填一行就标题正文都用它。'
    $lbl.Location = [System.Drawing.Point]::new(14, 12)
    $lbl.AutoSize = $true

    $txt = [System.Windows.Forms.TextBox]::new()
    $txt.Multiline = $true
    $txt.ScrollBars = 'Vertical'
    $txt.Location = [System.Drawing.Point]::new(14, 36)
    $txt.Size = [System.Drawing.Size]::new(412, 130)

    $btn = [System.Windows.Forms.Button]::new()
    $btn.Text = '发送'
    $btn.Location = [System.Drawing.Point]::new(351, 178)
    $btn.Size = [System.Drawing.Size]::new(75, 30)
    $btn.DialogResult = [System.Windows.Forms.DialogResult]::OK

    $frm.AcceptButton = $btn
    $frm.Controls.Add($lbl)
    $frm.Controls.Add($txt)
    $frm.Controls.Add($btn)

    $result = $frm.ShowDialog()
    $content = $txt.Text
    $frm.Dispose()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
    if ([string]::IsNullOrWhiteSpace($content)) { return $null }
    return $content
}

function Show-Balloon {
    param([string]$Title, [string]$Text, [string]$Kind = 'Info')
    try {
        $icon = [System.Windows.Forms.ToolTipIcon]::Info
        if ($Kind -eq 'Error') { $icon = [System.Windows.Forms.ToolTipIcon]::Error }
        elseif ($Kind -eq 'Warning') { $icon = [System.Windows.Forms.ToolTipIcon]::Warning }
        $notify.ShowBalloonTip(4000, $Title, $Text, $icon)
    } catch { }
}

# ---------------------------------------------------------------- 状态刷新
function Update-State {
    $j = Get-SelfCheck -Port $script:Port
    $script:TickCount++

    if ($j) {
        $script:St.alive = $true
        $script:St.rank = [string]$j.rank
        $script:St.summary = [string]$j.summary
        $script:St.roundNo = [int]$j.roundNo
        # 待命判定：selfcheck 的 items 里有 key='hold' 就说明本次启动还没发出任何搜索请求
        $script:St.hold = $false
        if ($j.items) {
            foreach ($it in $j.items) { if ([string]$it.key -eq 'hold') { $script:St.hold = $true } }
        }
    } else {
        $script:St.alive = $false
        $script:St.rank = 'unknown'
        $script:St.summary = '监控没在跑'
        $script:St.roundNo = 0
    }

    # 首次探测：如果监控没在跑，自动拉起来（开机自启后就是这个路径）
    if (-not $script:BootAutoStarted -and $script:TickCount -ge 1) {
        $script:BootAutoStarted = $true
        if (-not $script:St.alive) {
            if ((Get-GuardPids).Count -eq 0) {
                $null = Start-All -Port $script:Port -NodeExe $script:NodeExe -Log { param($m) }
                $j2 = Get-SelfCheck -Port $script:Port
                if ($j2) {
                    $script:St.alive = $true; $script:St.rank = [string]$j2.rank
                    $script:St.summary = [string]$j2.summary; $script:St.roundNo = [int]$j2.roundNo
                }
            }
        }
    }

    # 图标
    switch ($script:St.rank) {
        'ok' { $notify.Icon = $script:IconOk }
        'warn' { $notify.Icon = $script:IconWarn }
        'bad' { $notify.Icon = $script:IconBad }
        default { $notify.Icon = $script:IconOff }
    }

    # 菜单
    if ($script:St.alive) {
        $miStatus.Text = [string]$script:St.summary
    } else {
        $miStatus.Text = '监控没在跑'
    }
    $miStart.Enabled = -not $script:St.alive
    $miStop.Enabled = $script:St.alive
    # 待命时提示「开始」，扫描中提示「暂停」；进程没跑就没得切
    $miHold.Enabled = $script:St.alive
    if ($script:St.hold) { $miHold.Text = '▶ 开始监控' } else { $miHold.Text = '⏸ 暂停扫描' }
    $miRestart.Enabled = $true
    $miOpen.Enabled = $script:St.alive

    # 托盘悬停提示（WinForms 上限 63 字符）
    $tip = '闲鱼扫货 · ' + $script:St.summary
    if ($script:St.alive) { $tip += ' · 第 ' + $script:St.roundNo + ' 轮' }
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $notify.Text = $tip

    # 开机自启勾选状态（每 10 次刷新一次就够，读注册表不贵但没必要每 3 秒读）
    if (($script:TickCount % 10) -eq 1) {
        $miAutostart.Checked = [bool](Get-AutostartValue)
    }

    # 心跳文件：托盘是纯 GUI 进程、没有控制台输出，出问题（卡死/图标不更新）时
    # 光看进程列表分不出"还活着"和"活着但定时器不转了"。看一眼这个文件的 mtime 就知道。
    # 写失败一律忽略 —— 心跳写不进去也绝不能影响托盘本身。
    try {
        $hb = Join-Path $root 'data\tray-heartbeat.json'
        $aliveJs = 'false'
        if ($script:St.alive) { $aliveJs = 'true' }
        $obj = '{"at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"tick":' + $script:TickCount +
               ',"alive":' + $aliveJs + ',"rank":"' + $script:St.rank + '","pid":' + $PID + '}'
        [System.IO.File]::WriteAllText($hb, $obj)
    } catch { }
}

# 首次同步刷新（阻塞一次，让图标一出现就是对的）
try { Update-State } catch { }

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 3000
$timer.Add_Tick({
        if ($script:Busy) { return }
        try { Update-State } catch { }
    })

# ---------------------------------------------------------------- 菜单事件
$miOpen.Add_Click({
        try { Start-Process "http://127.0.0.1:$($script:Port)/" } catch { Show-Balloon '打不开界面' $_.Exception.Message 'Error' }
    })

$miDataDir.Add_Click({
        try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + (Join-Path $root 'data') + '"') } catch { }
    })

$miLog.Add_Click({
        $f = Join-Path $root 'data\monitor.log'
        try {
            if (Test-Path -LiteralPath $f) { Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $f + '"') }
            else { Show-Balloon '还没有日志' '监控还没写过日志文件。' 'Warning' }
        } catch { }
    })

$miStart.Add_Click({
        if ($script:Busy) { return }
        $script:Busy = $true
        try {
            $ok = Start-All -Port $script:Port -NodeExe $script:NodeExe -Log { param($m) }
            try { Update-State } catch { }
            if ($ok) { Show-Balloon '监控已启动' '正在扫描，右下角图标变绿就说明一切正常。' }
            else { Show-Balloon '启动没成功' '过了 20 秒还没探通。到「打开日志文件」看最后几行。' 'Error' }
        } finally { $script:Busy = $false }
    })

$miHold.Add_Click({
        if ($script:Busy) { return }
        $script:Busy = $true
        try {
            $target = 'hold'
            if ($script:St.hold) { $target = 'resume' }
            $uri = "http://127.0.0.1:$($script:Port)/__scan/$target"
            try {
                Invoke-WebRequest -Uri $uri -Method POST -TimeoutSec 6 -UseBasicParsing | Out-Null
                if ($target -eq 'resume') { Show-Balloon '已开始监控' '正在扫描，右下角图标变绿就说明一切正常。' }
                else { Show-Balloon '已暂停扫描' '不再发出任何搜索请求，点「▶ 开始监控」随时继续。' }
            } catch {
                Show-Balloon '操作没成功' $_.Exception.Message 'Error'
            }
            Start-Sleep -Milliseconds 600
            try { Update-State } catch { }
        } finally { $script:Busy = $false }
    })

$miStop.Add_Click({
        if ($script:Busy) { return }
        if ([System.Windows.Forms.MessageBox]::Show('确定要停止监控吗？' + [Environment]::NewLine + [Environment]::NewLine + '停止后不会再扫货、也不会推送，直到你点「启动监控」。', '闲鱼扫货监控', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question) -ne 'OK') { return }
        $script:Busy = $true
        try {
            $null = Stop-All -Port $script:Port -Log { param($m) }
            try { Update-State } catch { }
            Show-Balloon '监控已停止' '守护也一起关了，所以不会自动重启。'
        } finally { $script:Busy = $false }
    })

$miRestart.Add_Click({
        if ($script:Busy) { return }
        $script:Busy = $true
        try {
            $null = Stop-All -Port $script:Port -Log { param($m) }
            Start-Sleep -Milliseconds 800
            $ok = Start-All -Port $script:Port -NodeExe $script:NodeExe -Log { param($m) }
            try { Update-State } catch { }
            if ($ok) { Show-Balloon '已重启' '监控重新跑起来了。' } else { Show-Balloon '重启没成功' '到「打开日志文件」看最后几行。' 'Error' }
        } finally { $script:Busy = $false }
    })

$miRelogin.Add_Click({
        $f = Join-Path $root '3-重新登录并恢复.cmd'
        if (-not (Test-Path -LiteralPath $f)) { Show-Balloon '找不到脚本' $f 'Error'; return }
        try {
            Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c "' + $f + '"') -WorkingDirectory $root
            Show-Balloon '正在重新登录' '会弹出一个窗口让你扫码；扫完它会自己恢复扫描。'
        } catch { Show-Balloon '打开失败' $_.Exception.Message 'Error' }
    })

if ($miAnnounce) {
    $miAnnounce.Add_Click({
        if ($script:Busy) { return }
        $content = Show-AnnounceDialog
        if ([string]::IsNullOrWhiteSpace($content)) { return }
        $script:Busy = $true
        try {
            $tmp = Join-Path $root 'data\announce-tmp.txt'
            $outFile = Join-Path $root 'data\announce-out.txt'
            $errFile = Join-Path $root 'data\announce-err.txt'
            [System.IO.File]::WriteAllText($tmp, $content, (New-Object System.Text.UTF8Encoding($false)))
            $ps1 = Join-Path $root 'publish-announce.cjs'
            if (-not (Test-Path -LiteralPath $ps1)) { Show-Balloon '找不到发布脚本' $ps1 'Error'; return }
            $argStr = '"' + $ps1 + '" --file "' + $tmp + '"'
            $proc = Start-Process -FilePath $script:NodeExe -ArgumentList $argStr -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -Wait
            $out = ''; $err = ''
            try { $out = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8) } catch { }
            try { $err = [System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8) } catch { }
            try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
            try { Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue } catch { }
            try { Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue } catch { }
            $ok = $false; $msg = ''
            try { $r = $out | ConvertFrom-Json; if ($r.ok) { $ok = $true; $msg = [string]$r.msg } } catch { }
            if ($ok) {
                Show-Balloon '公告已发布' '用户端最多 3 小时内会看到横幅。'
            } else {
                $msg = if ($err) { $err } else { $out }
                if ([string]::IsNullOrWhiteSpace($msg)) { $msg = '未知错误' }
                if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
                Show-Balloon '发布失败' $msg 'Error'
            }
        } catch {
            Show-Balloon '发布失败' $_.Exception.Message 'Error'
        } finally {
            $script:Busy = $false
        }
    })
}

$miAutostart.Add_Click({
        try {
            if ($miAutostart.Checked) {
                Set-Autostart -On $false
                $miAutostart.Checked = $false
                Show-Balloon '已取消开机自启' '下次开机不会自动出现托盘图标。'
            } else {
                Set-Autostart -On $true
                $miAutostart.Checked = $true
                Show-Balloon '已设置开机自启' '下次登录 Windows 后会出现在右下角，并自动把监控拉起来。'
            }
        } catch {
            Show-Balloon '设置失败' $_.Exception.Message 'Error'
        }
    })

$miQuit.Add_Click({
        if ($script:Busy) { return }
        $msg = '确定要退出整个程序吗？' + [Environment]::NewLine + [Environment]::NewLine +
               '会做这些事：' + [Environment]::NewLine +
               '  · 停掉正在跑的扫描（不再扫货、不再推送）' + [Environment]::NewLine +
               '  · 停掉守护（不会自动重启）' + [Environment]::NewLine +
               '  · 关闭浏览器内核' + [Environment]::NewLine +
               '  · 移除右下角图标' + [Environment]::NewLine + [Environment]::NewLine +
               '已抓到的记录、价格历史、登录态都不会丢。' + [Environment]::NewLine +
               '想再开始就双击 闲鱼扫货监控.exe。'
        $r = [System.Windows.Forms.MessageBox]::Show($msg, '退出闲鱼扫货监控',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question,
            [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
        if ($r -ne 'Yes') { return }

        $script:Busy = $true
        try {
            # 停监控 + 守护 + 兜底收掉占端口的进程 + 本目录的 Chromium + 清残留标记
            $null = Stop-Everything -Port $script:Port -Log { param($m) }

            # 收尾：图标、定时器、消息循环
            $timer.Stop()
            $notify.Visible = $false
            $notify.Dispose()
            [System.Windows.Forms.Application]::Exit()
        } catch {
            Show-Balloon '退出时出错' $_.Exception.Message 'Error'
        } finally { $script:Busy = $false }
    })

$notify.Add_MouseDoubleClick({
        try { Start-Process "http://127.0.0.1:$($script:Port)/" } catch { }
    })

$notify.Add_BalloonTipClicked({
        try { Start-Process "http://127.0.0.1:$($script:Port)/" } catch { }
    })

# ---------------------------------------------------------------- 跑起来
$miAutostart.Checked = [bool](Get-AutostartValue)
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Stop()
