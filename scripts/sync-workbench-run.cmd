@echo off
chcp 65001 >nul
set ROOT=C:\Users\Administrator\Desktop\库存管理\AI智能管理进销存系统
cd /d "%ROOT%"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
echo [%date% %time%] === SYNC START === >> "%ROOT%\logs\sync-workbench.log"
node "%ROOT%\sync-workbench.mjs" >> "%ROOT%\logs\sync-workbench.log" 2>&1
echo [%date% %time%] === SYNC END === >> "%ROOT%\logs\sync-workbench.log"
