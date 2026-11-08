@echo off
rem Run a command inside the MSVC x64 build environment (for shells that lack vcvars).
rem Usage: scripts\msvc.cmd cargo test -p clarify-core
set "VCVARS="
for %%E in (BuildTools Community Professional Enterprise) do (
  if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%E\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%E\VC\Auxiliary\Build\vcvars64.bat"
  if exist "%ProgramFiles%\Microsoft Visual Studio\2022\%%E\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles%\Microsoft Visual Studio\2022\%%E\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCVARS (
  echo [msvc] Visual Studio 2022 Build Tools not found
  exit /b 1
)
call "%VCVARS%" >nul || exit /b 1
cd /d "%~dp0.."
%*
