$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 59288
$cfg = Join-Path $root 'config.json'
if (Test-Path -LiteralPath $cfg) {
    try { $j = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json; if ($j.port) { $port = $j.port } } catch {}
}
$url = "http://127.0.0.1:$port/"
$ok = $false
try { $r = Invoke-WebRequest $url -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ok = $true } } catch {}
if ($ok) {
    Start-Process $url
    Write-Host "  已打开界面: $url" -ForegroundColor Green
} else {
    Write-Host "  监控还没启动。" -ForegroundColor Yellow
    Write-Host "  请先双击运行  1-启动监控.cmd"
}
Start-Sleep -Seconds 2