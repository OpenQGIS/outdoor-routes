@echo off
chcp 65001 >nul
title Outdoor Routes - KML 路线库与在线标注工作台
cd /d "%~dp0"
echo ==============================================================
echo  正在启动 Outdoor Routes 路线库与在线标注工作台...
echo  访问地址: http://127.0.0.1:8766/
echo ==============================================================
start "" http://127.0.0.1:8766/
if exist "D:\Miniforge3\python.exe" (
    "D:\Miniforge3\python.exe" server.py 8766
) else (
    python server.py 8766
)
if errorlevel 1 pause
