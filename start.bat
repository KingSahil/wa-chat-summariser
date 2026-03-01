@echo off
title WA Summariser
color 0A

echo ==========================================
echo   WA Chat Summariser - Starting...
echo ==========================================
echo.

:: Add cloudflared to PATH
set PATH=%PATH%;C:\Program Files (x86)\cloudflared

:: Kill anything already on port 3000
echo [1/3] Freeing port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Start backend in new window
echo [2/3] Starting backend server...
start "WA Backend" cmd /k "cd /d %~dp0 && node server.js"
timeout /t 3 /nobreak >nul

:: Start quick tunnel, log output to temp file
echo [3/3] Starting Cloudflare tunnel...
set CFLOG=%TEMP%\cf_tunnel.log
if exist "%CFLOG%" del "%CFLOG%"
start "Cloudflare Tunnel" cmd /k "cloudflared tunnel --url http://localhost:3000 > "%CFLOG%" 2>&1"

:: Wait for URL to appear in log (up to 20 seconds)
echo Waiting for tunnel URL...
set TUNNEL_URL=
for /l %%i in (1,1,20) do (
    timeout /t 1 /nobreak >nul
    if exist "%CFLOG%" (
        for /f "tokens=*" %%L in ('findstr /i "trycloudflare.com" "%CFLOG%" 2^>nul') do (
            set "LINE=%%L"
        )
    )
    if defined LINE goto :found
)

:found
:: Extract just the https URL from the line
for /f "tokens=*" %%U in ('powershell -NoProfile -Command "if (Test-Path \"%CFLOG%\") { (Get-Content \"%CFLOG%\" -Raw) -match '(https://[^\s]+trycloudflare\.com)' | Out-Null; $matches[1] }" 2^>nul') do set TUNNEL_URL=%%U

echo.
echo ==========================================
if defined TUNNEL_URL (
    echo   TUNNEL URL: %TUNNEL_URL%
) else (
    echo   Tunnel is running! Check the
    echo   "Cloudflare Tunnel" window for URL.
    echo   Look for: https://....trycloudflare.com
)
echo ==========================================
echo.
echo  NOTE: URL changes each restart.
echo  Bookmark it after each launch.
echo ==========================================
pause
