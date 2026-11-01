# Clarify dev environment (PowerShell)
# 用法：. .\scripts\dev-env.ps1
# 说明：当前机器没有管理员权限，使用便携 MinGW 工具链 + Rust GNU 工具链。
$mingw = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin'
if (-not (Test-Path $mingw)) { throw "MinGW not found: $mingw" }
$env:PATH = "$env:USERPROFILE\.cargo\bin;$mingw;$env:PATH"
$env:CC  = Join-Path $mingw 'x86_64-w64-mingw32-gcc.exe'
$env:CXX = Join-Path $mingw 'x86_64-w64-mingw32-g++.exe'
$env:AR  = Join-Path $mingw 'x86_64-w64-mingw32-gcc-ar.exe'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
Write-Host "[clarify] GNU toolchain ready: $($env:CC)"
