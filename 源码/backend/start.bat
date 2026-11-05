@echo off
chcp 65001 >nul
title NexusHub 后端
cd /d "%~dp0"

echo ============================================
echo  NexusHub 后端  http://127.0.0.1:8000
echo  按 Ctrl+C 停止
echo ============================================
echo.

python -c "import fastapi, uvicorn" 2>nul
if errorlevel 1 (
  echo [错误] 没找到 fastapi / uvicorn，请先在 backend 目录执行：
  echo        pip install -e ".[dev]"
  echo.
  pause
  exit /b 1
)

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
echo.
echo 后端已停止。
pause