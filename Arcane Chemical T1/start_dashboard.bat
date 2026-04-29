@echo off
setlocal
cd /d "%~dp0"

set "PORT=8032"
if not "%~1"=="" set "PORT=%~1"

set "PYEXE="
if exist "C:\Users\devil\anaconda3\python.exe" set "PYEXE=C:\Users\devil\anaconda3\python.exe"
if "%PYEXE%"=="" for %%P in (py.exe python.exe) do (
  where %%P >nul 2>nul
  if not errorlevel 1 (
    if "%%P"=="py.exe" set "PYEXE=py -3"
    if "%%P"=="python.exe" set "PYEXE=python"
    goto :py_ok
  )
)

:py_ok
if "%PYEXE%"=="" (
  echo [ERROR] Python not found.
  echo Install Python or update start_dashboard.bat with your python path.
  pause
  exit /b 1
)

echo Starting Archean dashboard on http://localhost:%PORT%
echo Wait until you see "Serving Arcane Chemical dashboard" below, then open the URL.
echo.

start "" powershell -NoProfile -Command "for($i=0;$i -lt 120;$i++){try{Invoke-WebRequest -Uri ('http://localhost:%PORT%') -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process ('http://localhost:%PORT%'); break}catch{Start-Sleep -Seconds 1}}"

%PYEXE% -u serve_local.py %PORT%

endlocal
