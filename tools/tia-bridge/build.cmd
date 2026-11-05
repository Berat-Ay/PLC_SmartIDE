@echo off
rem Builds TiaBridge.exe with the C# compiler included in Windows. TIA Portal is not needed for this step.
setlocal
set "HERE=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo csc.exe was not found at %CSC%
  exit /b 1
)
if "%~1"=="" (set "OUT=%HERE%TiaBridge.exe") else (set "OUT=%~1")
"%CSC%" /nologo /optimize+ /platform:x64 /target:exe "/out:%OUT%" /reference:System.Core.dll /reference:Microsoft.CSharp.dll /reference:System.Web.Extensions.dll "%HERE%TiaBridge.cs"
if errorlevel 1 exit /b 1
echo Built %OUT%
