# 以本機網頁伺服器開啟會議紀錄系統：powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8791] [-Lan]
#   不加 -Lan：只有本機 http://localhost:8791/ 可開
#   加 -Lan  ：公司內網其他電腦可用 http://<本機IP>:8791/ 開啟（需先以系統管理員執行一次 tools\setup-lan.ps1）
param([int]$Port = 8791, [switch]$Lan)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\app')).Path
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json';
  '.pdf'='application/pdf'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.png'='image/png'; '.gif'='image/gif'; '.txt'='text/plain; charset=utf-8';
  '.docx'='application/vnd.openxmlformats-officedocument.wordprocessingml.document'; '.xlsx'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  '.pptx'='application/vnd.openxmlformats-officedocument.presentationml.presentation'; '.doc'='application/msword'; '.xls'='application/vnd.ms-excel'; '.ppt'='application/vnd.ms-powerpoint' }
$l = New-Object Net.HttpListener
if ($Lan) { $l.Prefixes.Add("http://+:$Port/") } else { $l.Prefixes.Add("http://localhost:$Port/") }
try { $l.Start() } catch {
  if ($Lan) { Write-Host "無法啟動內網模式：請先以「系統管理員」身分執行 tools\setup-lan.ps1（只需一次）。" -ForegroundColor Red }
  else { Write-Host "無法啟動：連接埠 $Port 可能已被使用（伺服器是否已經開著？）" -ForegroundColor Red }
  Write-Host $_.Exception.Message; Read-Host '按 Enter 關閉'; exit 1
}
Write-Host "會議紀錄管理系統已啟動（關閉此視窗即停止）"
Write-Host "  本機：http://localhost:$Port/"
if ($Lan) {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "  同事：http://$($_.IPAddress):$Port/   （$($_.InterfaceAlias)）" -ForegroundColor Green }
}
try {
  while ($l.IsListening) {
    $ctx = $l.GetContext(); $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if (-not $rel) { $rel = 'index.html' }
      $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $path.StartsWith($root) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { $res.StatusCode = 404; $res.Close(); continue }
      $ext = [IO.Path]::GetExtension($path).ToLower()
      $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
      if ($ext -in '.html', '.js', '.css') { $res.Headers.Add('Cache-Control', 'no-cache, no-store, must-revalidate') }
      $fs = [IO.File]::OpenRead($path); $res.ContentLength64 = $fs.Length
      try { $fs.CopyTo($res.OutputStream) } finally { $fs.Dispose() }
    } catch { try { $res.StatusCode = 500 } catch {} }
    finally { try { $res.Close() } catch {} }
  }
} finally { $l.Stop() }
