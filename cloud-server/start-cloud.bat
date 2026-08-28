@echo off
chcp 65001 >nul
title 进销存云同步服务器
echo ============================================
echo   通用进销存 · 云同步服务器
echo   （一个账户多台电脑共享数据）
echo ============================================
echo.

REM 端口（默认 3100，可用环境变量 INV_CLOUD_PORT 覆盖）
if "%INV_CLOUD_PORT%"=="" set INV_CLOUD_PORT=3100

REM 管理员密钥（用于管理页；生产环境务必改掉）
if "%INV_ADMIN_KEY%"=="" set INV_ADMIN_KEY=change-me-admin-key

REM 数据目录（用户快照/备份存储位置）
if "%INV_CLOUD_DATA%"=="" set INV_CLOUD_DATA=%CD%\data

echo 端口: %INV_CLOUD_PORT%
echo 数据目录: %INV_CLOUD_DATA%
echo 管理页: http://localhost:%INV_CLOUD_PORT%/admin?key=%INV_ADMIN_KEY%
echo.
echo 启动中...
echo.

set PORT=%INV_CLOUD_PORT%
set ADMIN_KEY=%INV_ADMIN_KEY%
set CLOUD_DATA_ROOT=%INV_CLOUD_DATA%
node index.js

pause
