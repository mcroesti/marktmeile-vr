# Minimal static file HTTP server for WebXR dev.
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1
$port = 8080
$root = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port"

$mime = @{
  ".html"="text/html; charset=utf-8"
  ".js"  ="application/javascript; charset=utf-8"
  ".css" ="text/css; charset=utf-8"
  ".json"="application/json; charset=utf-8"
  ".png" ="image/png"
  ".jpg" ="image/jpeg"
  ".svg" ="image/svg+xml"
  ".ico" ="image/x-icon"
  ".glb" ="model/gltf-binary"
  ".gltf"="model/gltf+json"
  ".hdr" ="image/vnd.radiance"
  ".exr" ="image/x-exr"
  ".ktx2"="image/ktx2"
  ".webp"="image/webp"
  ".bin" ="application/octet-stream"
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    $path = $req.Url.LocalPath
    if ($path -eq "/") { $path = "/index.html" }
    $file = Join-Path $root $path.TrimStart("/")

    # CORS + no-cache for dev
    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    $res.Headers.Add("Cache-Control", "no-store")

    if (Test-Path $file -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.ContentType = $ct
      $res.ContentLength64 = $bytes.Length
      $res.StatusCode = 200
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "200 $path ($ct, $($bytes.Length)B)"
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404: $path")
      $res.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host "404 $path"
    }
    $res.OutputStream.Close()
  } catch {
    Write-Host "ERR: $_"
  }
}
