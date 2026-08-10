@echo off
setlocal
chcp 65001 > nul
cd /d "%~dp0"

set "PYTHON_EXE=%CD%\.venv\Scripts\python.exe"
set "BASE_URL=http://127.0.0.1:5050"
set "HEALTH_URL=%BASE_URL%/health"

echo.
echo  ============================================
echo    CryptoDATEX Dashboard
echo    BTC Futures + Options Analyzer
echo  ============================================
echo.

if not exist "%PYTHON_EXE%" (
    echo [ERROR] Missing virtual environment: .venv\Scripts\python.exe
    echo         Create it with:
    echo         py -m venv .venv
    echo.
    pause
    exit /b 1
)

echo [1/4] Checking project dependencies...
"%PYTHON_EXE%" -c "import flask, flask_cors, requests, pandas, numpy" > nul 2>&1
if errorlevel 1 (
    echo       Installing requirements into .venv...
    "%PYTHON_EXE%" -m pip install -r requirements.txt --quiet --disable-pip-version-check
    if errorlevel 1 (
        echo [ERROR] Failed to install requirements into .venv.
        echo.
        pause
        exit /b 1
    )
)
echo       OK

echo [2/4] Checking for a running server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $resp = Invoke-WebRequest -Uri '%HEALTH_URL%' -UseBasicParsing -TimeoutSec 2; if ($resp.StatusCode -eq 200) { exit 0 } } catch { } exit 1"
if errorlevel 1 (
    echo [3/4] Starting backend server on 5050...
    start "CryptoDATEX Server" /MIN "%PYTHON_EXE%" server.py
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(20); do { try { $resp = Invoke-WebRequest -Uri '%HEALTH_URL%' -UseBasicParsing -TimeoutSec 2; if ($resp.StatusCode -eq 200) { exit 0 } } catch { } Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1"
    if errorlevel 1 (
        echo [ERROR] Server did not come up on 5050.
        echo         Try running: .venv\Scripts\python.exe server.py
        echo.
        pause
        exit /b 1
    )
) else (
    echo [3/4] Server already running on 5050.
)

echo [4/4] Opening dashboard...
start "" "%BASE_URL%/"
echo.
echo Dashboard is live:
echo   %BASE_URL%/
echo   %BASE_URL%/options
echo.
pause
