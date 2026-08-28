@echo off
chcp 65001 >nul
echo ============================================
echo   安装进销存云同步为 Windows 后台服务
echo   （开机自启，无需手动开窗口）
echo ============================================
echo.
echo 使用 PM2 管理（需先 npm i -g pm2）...
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
  echo 未安装 pm2，先安装：npm install -g pm2
  pause
  exit /b 1
)

pm2 start index.js --name inventory-cloud --cwd "%CD%" --env PORT=3100 --env ADMIN_KEY=change-me-admin-key --env CLOUD_DATA_ROOT="%CD%\data"
pm2 save
echo.
echo 已安装为后台服务！开机自动启动。
echo 管理: pm2 logs inventory-cloud  /  pm2 stop inventory-cloud
pause
