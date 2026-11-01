# Clarify dev environment (PowerShell)
# 用法：. .\scripts\dev-env.ps1
# 说明：当前机器没有管理员权限，使用便携 MinGW 工具链 + Rust GNU 工具链。
$clarifyLocalAppData = $env:LOCALAPPDATA
if (-not $clarifyLocalAppData) { $clarifyLocalAppData = [Environment]::GetFolderPath('LocalApplicationData') }
$clarifyPkgRoot = Join-Path $clarifyLocalAppData 'Microsoft\WinGet\Packages'
$clarifyPkg = Get-ChildItem $clarifyPkgRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'BrechtSanders.WinLibs.POSIX.UCRT*' } |
    Select-Object -First 1
if (-not $clarifyPkg) { throw "WinLibs package not found under $clarifyPkgRoot" }
$clarifyMingw = Join-Path $clarifyPkg.FullName 'mingw64\bin'
if (-not (Test-Path $clarifyMingw)) { throw "MinGW not found: $clarifyMingw" }
$env:PATH = "$env:USERPROFILE\.cargo\bin;$clarifyMingw;$env:PATH"
$env:CC  = Join-Path $clarifyMingw 'x86_64-w64-mingw32-gcc.exe'
$env:CXX = Join-Path $clarifyMingw 'x86_64-w64-mingw32-g++.exe'
$env:AR  = Join-Path $clarifyMingw 'x86_64-w64-mingw32-gcc-ar.exe'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
Write-Host "[clarify] GNU toolchain ready: $($env:CC)"
