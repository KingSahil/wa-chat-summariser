@echo off
title WA Summariser
color 0A

echo ==========================================
echo   WA Chat Summariser - Starting...
echo ==========================================
echo.

:: Build frontend so server serves latest client/dist
echo [0/3] Building frontend...
call npm run build >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Frontend build failed. Run "npm run build" manually to inspect errors.
    pause
    exit /b 1
)

:: Add cloudflared to PATH
set PATH=%PATH%;C:\Program Files (x86)\cloudflared

:: Kill any existing node/chrome and free port 3000
echo [1/4] Freeing port 3000 and cleaning up...
taskkill /IM node.exe /F >nul 2>&1
taskkill /IM chrome.exe /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
:: Remove stale Puppeteer lock files
del /f /q "%~dp0.wwebjs_auth\session\SingletonLock" >nul 2>&1
del /f /q "%~dp0.wwebjs_auth\session\SingletonSocket" >nul 2>&1
timeout /t 1 /nobreak >nul

:: Start backend silently in background (no new window)
echo [2/4] Starting backend server...
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -NoNewWindow"
timeout /t 3 /nobreak >nul

:: Start quick tunnel, log stdout/stderr to separate temp files
echo [3/4] Starting Cloudflare tunnel...
set CFOUT=%TEMP%\cf_out.log
set CFERR=%TEMP%\cf_err.log
if exist "%CFOUT%" del "%CFOUT%"
if exist "%CFERR%" del "%CFERR%"

powershell -NoProfile -Command "Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel','--url','http://localhost:3000' -RedirectStandardOutput '%CFOUT%' -RedirectStandardError '%CFERR%' -NoNewWindow"

:: Wait up to 20 seconds for URL to appear
echo Waiting for tunnel URL...
set TUNNEL_URL=
for /l %%i in (1,1,20) do (
    timeout /t 1 /nobreak >nul
    for /f "tokens=*" %%U in ('powershell -NoProfile -Command "$c=(Get-Content '%CFOUT%' -Raw -EA SilentlyContinue)+(Get-Content '%CFERR%' -Raw -EA SilentlyContinue); if ($c -match '(https://[a-z0-9-]+\.trycloudflare\.com)') { $matches[1] }" 2^>nul') do set TUNNEL_URL=%%U
    if defined TUNNEL_URL goto :show_url
)

:show_url
echo.
echo ==========================================
if defined TUNNEL_URL (
    echo   YOUR URL: %TUNNEL_URL%
) else (
    echo   Check logs: %CFOUT% and %CFERR%
)
echo ==========================================
echo  NOTE: URL changes each restart.
echo ==========================================
pause
