@echo off
rem Double-click to start the voice booth and open it in the browser.
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:4455"
node server.mjs
if errorlevel 1 pause
