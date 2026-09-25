@echo off
chcp 65001 >nul
cd /d "%~dp0"
title EAG 服务管理

REM ============================================================
REM  EAG 服务管理脚本
REM    启动   : start.bat            (幂等: 已在运行则跳过)
REM    停止   : start.bat stop
REM    重启   : start.bat restart
REM
REM  说明：服务以两个最小化窗口运行（EAG-API / EAG-UI），
REM        直接关闭那两个窗口即可停止，无需运行 stop。
REM ============================================================

set "API_PORT=3789"
set "UI_PORT=5173"

if /i "%1"=="stop"    goto STOP
if /i "%1"=="restart" goto RESTART
goto START


:START
echo.
echo  ============================================
echo    EAG 服务启动
echo  ============================================
echo.

REM ---- API ----
netstat -ano | findstr ":%API_PORT% " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo  [API] 端口 %API_PORT% 已在运行，跳过
) else (
  echo  [API] 启动中 ...
  start "EAG-API" /MIN node node_modules\tsx\dist\cli.mjs src\server\index.ts
)

REM ---- UI ----
netstat -ano | findstr ":%UI_PORT% " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo  [UI ] 端口 %UI_PORT% 已在运行，跳过
) else (
  echo  [UI ] 启动中 ...
  start "EAG-UI" /MIN node node_modules\vite\bin\vite.js --config src\desktop\renderer\vite.config.ts
)

echo.
echo  等待服务就绪，请稍候
set RETRY=0

:WAIT
set /a RETRY+=1
netstat -ano | findstr ":%API_PORT% " | findstr "LISTENING" >nul
if errorlevel 1 goto NOAPI
netstat -ano | findstr ":%UI_PORT% " | findstr "LISTENING" >nul
if errorlevel 1 goto NOAPI
goto READY

:NOAPI
if %RETRY% GEQ 40 goto TIMEOUT
<nul set /p=.
ping -n 2 127.0.0.1 >nul
goto WAIT

:READY
echo.
echo.
echo   ============================================
echo    服务已就绪
echo   --------------------------------------------
echo    访问地址 : http://localhost:5173/
echo    后台 API : http://localhost:3789/
echo    登录账号 : admin
echo   --------------------------------------------
echo    停止服务 : 关闭 EAG-API / EAG-UI 两个窗口
echo              或运行 start.bat stop
echo   ============================================
echo.
set "OPEN_BROWSER="
set /p "OPEN_BROWSER=  是否在浏览器打开? (Y/N) "
if /i "%OPEN_BROWSER%"=="Y" start http://localhost:5173/
goto END

:TIMEOUT
echo.
echo   [!] 等待超时（40 秒），请检查：
echo       - node 是否已加入 PATH
echo       - 日志 .eag\server.out.log / .eag\server.err.log
goto END


:STOP
echo.
echo  停止 EAG 服务 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%API_PORT% " ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p /T >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%UI_PORT% " ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p /T >nul 2>&1
)
echo  已停止。
goto END


:RESTART
call :STOP
ping -n 3 127.0.0.1 >nul
goto START


:END
echo.
pause
