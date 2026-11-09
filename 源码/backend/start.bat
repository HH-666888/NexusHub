@echo off
setlocal
title NexusHub 后端
cd /d "%~dp0"

set "PORT=8000"
if not "%~1"=="" set "PORT=%~1"

echo ============================================
echo  NexusHub 后端
echo  v2 地址: http://127.0.0.1:%PORT%/v2/
echo  旧站:    http://127.0.0.1:%PORT%/
echo  停止:    按 Ctrl+C
echo ============================================
echo.

python -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 fastapi / uvicorn
  echo        请先在本目录执行: pip install -e ".[dev]"
  echo.
  pause
  exit /b 1
)

python -m uvicorn app.main:app --host 127.0.0.1 --port %PORT%
set "CODE=%ERRORLEVEL%"

echo.
echo 后端已退出（代码 %CODE%）。
if not "%CODE%"=="0" echo 如果提示端口被占用，换一个端口: start.bat 8001
pause
