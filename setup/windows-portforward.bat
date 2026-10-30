@echo off
setlocal EnableDelayedExpansion
title Arena to Kali - open the port
cd /d "%~dp0"

echo.
echo   Arena -^> Kali : port forwarding
echo   --------------------------------
echo   Makes 127.0.0.1:8787 on this PC reach the agent inside your VM.
echo.

set "VBM="
if exist "%ProgramFiles%\Oracle\VirtualBox\VBoxManage.exe" set "VBM=%ProgramFiles%\Oracle\VirtualBox\VBoxManage.exe"
if not defined VBM if exist "%ProgramFiles(x86)%\Oracle\VirtualBox\VBoxManage.exe" set "VBM=%ProgramFiles(x86)%\Oracle\VirtualBox\VBoxManage.exe"
if not defined VBM for %%P in (VBoxManage.exe) do if exist "%%~$PATH:P" set "VBM=%%~$PATH:P"

if not defined VBM (
  echo   [X] Could not find VBoxManage.exe.
  echo       Install VirtualBox, or open the VirtualBox install folder and run
  echo       this file from there.
  echo.
  pause
  exit /b 1
)

echo   VirtualBox: !VBM!
echo.
echo   Running VMs:
"!VBM!" list runningvms
echo.

if "%~1"=="" (
  set /p "VMNAME=VM name (copy it exactly, without quotes): "
) else (
  set "VMNAME=%~1"
)
if "!VMNAME!"=="" (
  echo   No name given - nothing changed.
  pause
  exit /b 1
)

echo.
echo   Adding 127.0.0.1:8787 -^> guest 8787 on "!VMNAME!" ...
"!VBM!" controlvm "!VMNAME!" natpf1 delete "arena-kali" >nul 2>&1
"!VBM!" controlvm "!VMNAME!" natpf1 "arena-kali,tcp,127.0.0.1,8787,,8787"
if errorlevel 1 (
  echo.
  echo   [X] VirtualBox refused it.
  echo       - Is the VM actually running?  ^(rule must be added while running^)
  echo       - Is Adapter 1 set to NAT?  ^(Settings ^> Network^)
  pause
  exit /b 1
)

echo.
echo   [OK] Port forwarded.
echo.
echo   Test it on this PC:
echo        curl -i http://127.0.0.1:8787/health
echo   "unauthorised" ^(401^) is the correct answer. "connection refused" means
echo   the agent inside the VM is not listening on the VM's own address - run
echo   kali/start.sh again and look for "VirtualBox NAT detected".
echo.
echo   Keep the VM running. Next: load the extension and click Pair.
echo.
pause
