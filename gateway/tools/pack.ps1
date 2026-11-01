$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path node_modules)) {
  npm install --omit=dev
}

$target = Join-Path (Get-Location) 'clarify-gateway.zip'
if (Test-Path $target) { Remove-Item -Force $target }

Compress-Archive -Path index.js, dev-server.js, lib, node_modules, package.json -DestinationPath $target -Force
Write-Output "Created $target. Upload it to Aliyun Function Compute."
