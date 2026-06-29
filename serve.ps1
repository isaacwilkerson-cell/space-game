$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8080/")
$listener.Start()
Write-Host "Serving at http://localhost:8080/"

$root = "$PSScriptRoot\client"
$mimeTypes = @{
  ".html" = "text/html"
  ".js"   = "application/javascript"
  ".css"  = "text/css"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response

  $path = $req.Url.LocalPath
  if ($path -eq "/") { $path = "/index.html" }
  $file = Join-Path $root $path.TrimStart("/").Replace("/", "\")

  if (Test-Path $file -PathType Leaf) {
    $ext = [System.IO.Path]::GetExtension($file)
    $mime = if ($mimeTypes[$ext]) { $mimeTypes[$ext] } else { "application/octet-stream" }
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $res.ContentType = $mime
    $res.Headers.Add("Cache-Control", "no-store, no-cache, must-revalidate")
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
  }
  $res.Close()
}
