@echo off
rem Runs the verification next to this file and keeps the window open so the result can be read.
setlocal
cd /d "%~dp0"
if not exist TiaBridge.exe call build.cmd
if not exist TiaBridge.exe goto :end
TiaBridge.exe verify bundle --out result %*
echo.
echo Exit code: %errorlevel%   (0 = compiled, 2 = TIA found problems in the project, 1 = could not run)
echo Bring back the whole "result" folder, including tia-report.json and exported.
:end
pause
