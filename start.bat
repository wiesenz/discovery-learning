@echo off
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto NOPY

python serve.py
if errorlevel 1 pause
exit /b

:NOPY
echo [ERROR] Python not found on this computer.
echo Install Python 3 from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" during installation.
echo.
pause
