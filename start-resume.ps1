# start-resume.ps1 —— 启动器专用：等监控起来后自动解除「启动待命」
#
# 为什么需要它：
#   程序默认 startMode=hold，启动后停在待命，一个搜索请求都不发，必须点
#   【▶ 开始监控】才会动网。但用户点「立即重新登录并恢复」本身就已经是
#   「我要继续扫」的明确意图 —— 停在待命会让人以为在扫、实际什么都没抓。
#
# 谁调用它：
#   3-重新登录并恢复.cmd（面板「登录 / 换号」的兜底按钮也会走它）
#
# 谁不调用：
#   闲鱼扫货监控.exe（托盘）—— 从托盘启动仍然停在待命，这是设计意图：
#   日常开机自启不该自动动网，想扫再点【▶ 开始监控】。

$ErrorActionPreference = 'SilentlyContinue'

$root = $PSScriptRoot
$port = 59288

# 端口以 config.json 为准（用户可能改过，别写死）
try {
    $cfgPath = Join-Path $root 'config.json'
    if (Test-Path -LiteralPath $cfgPath) {
        $txt = [IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8)
        $cfg = $txt | ConvertFrom-Json
        if ($cfg.port) { $port = [int]$cfg.port }
    }
} catch { }

# 等监控起来（最多 3 分钟），起来后如果还在待命就解除
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
    $ok = $false
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/__scan/hits.json" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) {
            $ok = $true
            $j = $r.Content | ConvertFrom-Json
            if ($j -and $j.hold -and $j.hold.on) {
                Invoke-WebRequest -Uri "http://127.0.0.1:$port/__scan/resume" -Method POST -UseBasicParsing -TimeoutSec 5 | Out-Null
            }
        }
    } catch { }

    if ($ok) { break }
    Start-Sleep -Milliseconds 800
}
