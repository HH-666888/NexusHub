@echo off
chcp 65001 >nul
title 启动 NexusHub
cd /d "%~dp0"
echo 正在启动后端（前端由它一起托管）...
start "" "http://127.0.0.1:8000/"
call "backend\start.bat"