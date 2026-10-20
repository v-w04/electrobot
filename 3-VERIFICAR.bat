@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
call _config.bat
title Verificar

set "ESC="
for /f %%E in ('echo prompt $E ^| cmd') do set "ESC=%%E"
set "AZUL="
set "VERDE="
set "ROJO="
set "FIN="
if defined ESC set "AZUL=%ESC%[38;2;31;148;249m"
if defined ESC set "VERDE=%ESC%[38;2;63;185;80m"
if defined ESC set "ROJO=%ESC%[38;2;248;81;73m"
if defined ESC set "FIN=%ESC%[0m"

echo.
echo   VERIFICAR                      estado de esta PC
echo   %AZUL%----------------------------------------------------%FIN%
echo.
set FALTA=0

where node >nul 2>&1
if errorlevel 1 (echo   %ROJO%x  Node.js%FIN% & set FALTA=1) else (echo   ok Node.js)

where wrangler >nul 2>&1
if errorlevel 1 (echo   %ROJO%x  wrangler%FIN% & set FALTA=1) else (echo   ok wrangler)

call :CHECALOGIN
if errorlevel 1 (echo   %ROJO%x  sesion de Cloudflare - corre el 1%FIN% & set FALTA=1) else (echo   ok sesion de Cloudflare)

if exist "worker\src\index.js" (echo   ok codigo del worker) else (echo   %ROJO%x  falta worker\src\index.js%FIN% & set FALTA=1)
if exist "worker\wrangler.toml" (echo   ok wrangler.toml) else (echo   %ROJO%x  falta worker\wrangler.toml%FIN% & set FALTA=1)
if exist "index.html" (echo   ok app web) else (echo   %ROJO%x  falta index.html%FIN% & set FALTA=1)

if not exist "worker\src\index.js" goto SALTASINTAXIS
node --check "worker\src\index.js" >nul 2>&1
if errorlevel 1 (echo   %ROJO%x  el worker tiene un error de sintaxis%FIN% & set FALTA=1) else (echo   ok sintaxis del worker)

:SALTASINTAXIS
call _seguro.bat >nul 2>&1
if errorlevel 1 (echo   %ROJO%x  credenciales en el codigo%FIN% & set FALTA=1) else (echo   ok sin credenciales)

REM Lo que de verdad importa: que la version publicada sea esta. Si
REM Cloudflare sirve codigo viejo, el bot contesta con datos viejos y
REM nada en esta PC lo delata.
where curl >nul 2>&1
if errorlevel 1 goto SALTAWORKER
curl -s -m 20 "%WORKER_URL%" > "%TEMP%\chk_v.txt" 2>nul
findstr /C:"OK %WORKER_VERSION%" "%TEMP%\chk_v.txt" >nul 2>&1
if errorlevel 1 (echo   %ROJO%x  Cloudflare no sirve %WORKER_VERSION% - corre el 5%FIN% & set FALTA=1) else (echo   ok worker en linea %WORKER_VERSION%)
del "%TEMP%\chk_v.txt" >nul 2>&1

:SALTAWORKER
echo.
echo   %AZUL%----------------------------------------------------%FIN%
echo.
if "!FALTA!"=="1" (
    echo   %ROJO%^^!  FALTA ALGO%FIN%
    echo.
    pause
    exit /b 1
)
echo %VERDE%  Todo en orden.%FIN%
echo.
call :LOGO
exit /b 0

:CHECALOGIN
REM errorlevel 0 = hay sesion. `wrangler whoami` contesta 0 aunque NO haya
REM sesion: se lee el texto que imprime.
call wrangler whoami > "%TEMP%\chk_who.txt" 2>&1
findstr /I /C:"not authenticated" /C:"not logged in" "%TEMP%\chk_who.txt" >nul 2>&1
if not errorlevel 1 exit /b 1
findstr /I /C:"logged in" "%TEMP%\chk_who.txt" >nul 2>&1
exit /b %errorlevel%

:LOGO
where node >nul 2>&1
if errorlevel 1 goto SINLOGO
if not exist "%~dp0logo-animado.js" goto SINLOGO
node "%~dp0logo-animado.js" giro marca 0 12
goto :eof

:SINLOGO
pause
goto :eof
