@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Run npm install and npm start in this folder first.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
powershell.exe -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'scripts/start.mjs' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"
