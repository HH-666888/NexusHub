@echo off
setlocal
title 启动 NexusHub
cd /d "%~dp0"

echo 正在启动后端（前端页面由它一起托管）...
echo 浏览器会在 6 秒后自动打开首页，没打开就手动访问 http://127.0.0.1:8000/
echo.

rem 后台等 6 秒再开浏览器，避免页面比服务先到；默认直接进首页
start "" /b cmd /c "timeout /t 6 /nobreak >nul & start "" http://127.0.0.1:8000/"

call "backend\start.bat" %*
