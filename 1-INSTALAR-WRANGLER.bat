@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
call _config.bat
title Instalar wrangler

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
echo   INSTALAR WRANGLER            Cloudflare + webhook
echo   %AZUL%----------------------------------------------------%FIN%
set "CONSA="
echo.

echo   %AZUL%[1/5]%FIN%  Node.js . . . . . . . . . . . . . .
where node >nul 2>&1
if errorlevel 1 goto NONODE
echo          ok

echo   %AZUL%[2/5]%FIN%  wrangler . . . . . . . . . . . . . .
where wrangler >nul 2>&1
if not errorlevel 1 goto YAWRANGLER
call npm install -g wrangler >nul 2>"%TEMP%\chk_w.txt"
if errorlevel 1 goto NPMFAIL
where wrangler >nul 2>&1
if errorlevel 1 goto NPMFAIL
del "%TEMP%\chk_w.txt" >nul 2>&1
echo          instalado
goto SESION

:YAWRANGLER
echo          ok

:SESION
echo   %AZUL%[3/5]%FIN%  Sesion de Cloudflare . . . . . . . .
call :CHECALOGIN
if not errorlevel 1 goto YASESION
echo          abriendo el navegador
call wrangler login
call :CHECALOGIN
if errorlevel 1 goto LOGINFAIL

:YASESION
echo          ok

echo   %AZUL%[4/5]%FIN%  Secretos . . . . . . . . . . . . . .
echo.
set "TOKEN="
set /p "TOKEN=         Token del bot de Telegram: "
if not defined TOKEN goto SINTOKEN
echo.

REM El secreto del webhook es un valor al azar que solo conocen Cloudflare
REM y Telegram. Se genera de nuevo en cada corrida y se usa en las dos
REM puntas (secreto del worker + setWebhook), asi quedan iguales.
set "WHSEC="
node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))" > "%TEMP%\em_w.txt" 2>nul
if exist "%TEMP%\em_w.txt" set /p WHSEC=<"%TEMP%\em_w.txt"
del "%TEMP%\em_w.txt" >nul 2>&1
if not defined WHSEC goto NOWHSEC

REM Los secretos van en UN archivo temporal y `secret bulk` los sube. Antes
REM se mandaban por tuberia (secret put < archivo) y wrangler, sin entrada
REM interactiva, se negaba a trabajar sin un CLOUDFLARE_API_TOKEN.
REM La cuenta de servicio de Google (worker\sa.json) se agrega sola si existe.
if exist "worker\sa.json" set "CONSA=1"
set "EM_T=!TOKEN!"
set "EM_W=!WHSEC!"
set "EM_F=%TEMP%\em_s.json"
node "%~dp0_secretos.js" 2>"%TEMP%\chk_j.txt"
if errorlevel 1 goto JSONFAIL
set "EM_T="
set "EM_W="
del "%TEMP%\chk_j.txt" >nul 2>&1

pushd worker
call wrangler secret bulk "!EM_F!" --name %WORKER_NAME% > "%TEMP%\chk_s.txt" 2>&1
popd
del /f /q "!EM_F!" >nul 2>&1
set "EM_F="

REM El veredicto NO sale del codigo de salida de wrangler (en esta PC miente:
REM devolvio 0 con el secreto sin guardar). Sale de preguntarle a Cloudflare
REM que secretos tiene. Tarda unos segundos en reflejarlos: hasta 3 intentos.
set "TRIES=0"

:LISTAR
pushd worker
call wrangler secret list --name %WORKER_NAME% < nul > "%TEMP%\chk_sl.txt" 2>"%TEMP%\chk_sle.txt"
popd
set "FALTAN="
findstr /C:"TELEGRAM_TOKEN" "%TEMP%\chk_sl.txt" >nul 2>&1
if errorlevel 1 set "FALTAN=!FALTAN! TELEGRAM_TOKEN"
findstr /C:"TELEGRAM_WEBHOOK_SECRET" "%TEMP%\chk_sl.txt" >nul 2>&1
if errorlevel 1 set "FALTAN=!FALTAN! TELEGRAM_WEBHOOK_SECRET"
if defined CONSA (
    findstr /C:"GOOGLE_SA_JSON" "%TEMP%\chk_sl.txt" >nul 2>&1
    if errorlevel 1 set "FALTAN=!FALTAN! GOOGLE_SA_JSON"
)
if not defined FALTAN goto SECRETOSOK
set /a TRIES+=1
if !TRIES! lss 3 (
    timeout /t 3 /nobreak >nul
    goto LISTAR
)
goto FALTASECRETO

:SECRETOSOK
del "%TEMP%\chk_s.txt" >nul 2>&1
del "%TEMP%\chk_sl.txt" >nul 2>&1
del "%TEMP%\chk_sle.txt" >nul 2>&1
if defined CONSA (
    echo          guardados, con cuenta de servicio
) else (
    echo          guardados, sin sa.json
)

echo   %AZUL%[5/5]%FIN%  Webhook de Telegram . . . . . . . .
where curl >nul 2>&1
if errorlevel 1 goto NOCURL
curl -s -X POST "https://api.telegram.org/bot!TOKEN!/setWebhook" -d "url=%WORKER_URL%" -d "secret_token=!WHSEC!" -d "drop_pending_updates=true" > "%TEMP%\chk_wh.txt" 2>nul
if errorlevel 1 goto WHFAIL
REM El punto del patron casa con la comilla: meter comillas dentro de un
REM findstr desde un .bat es pedir que CMD se las coma.
findstr /R "ok.:true" "%TEMP%\chk_wh.txt" >nul 2>&1
if errorlevel 1 goto WHFAIL
del "%TEMP%\chk_wh.txt" >nul 2>&1

REM Verde solo si Telegram CONFIRMA a donde esta apuntando. Que el
REM setWebhook conteste ok no prueba que la URL sea la correcta.
curl -s "https://api.telegram.org/bot!TOKEN!/getWebhookInfo" > "%TEMP%\chk_wi.txt" 2>nul
if errorlevel 1 goto WHNOCUADRA
findstr /C:"%WORKER_URL%" "%TEMP%\chk_wi.txt" >nul 2>&1
if errorlevel 1 goto WHNOCUADRA
del "%TEMP%\chk_wi.txt" >nul 2>&1
echo          apuntando al worker

echo.
echo   %AZUL%----------------------------------------------------%FIN%
echo.
echo %VERDE%  Listo. Ahora corre 5-SUBIR-TODO.bat.%FIN%
echo.
call :LOGO
exit /b 0

:NONODE
echo.
echo   %ROJO%x  NO HAY NODE.JS%FIN%
echo      Instalalo de nodejs.org y repite este bat.
echo.
pause
exit /b 1

:NPMFAIL
type "%TEMP%\chk_w.txt" 2>nul
del "%TEMP%\chk_w.txt" >nul 2>&1
echo.
echo   %ROJO%x  NO SE INSTALO WRANGLER%FIN%
echo      Abre esta ventana como administrador y repite.
echo.
pause
exit /b 1

:LOGINFAIL
echo.
type "%TEMP%\chk_who.txt" 2>nul
del "%TEMP%\chk_who.txt" >nul 2>&1
echo.
echo   %ROJO%x  NO ENTRO A CLOUDFLARE%FIN%
echo      Termina el login en el navegador y repite.
echo.
pause
exit /b 1

:SINTOKEN
echo.
echo   %ROJO%x  SIN TOKEN NO SE PUEDE SEGUIR%FIN%
echo      Pidelo a BotFather con /mybots y repite.
echo.
pause
exit /b 1

:NOWHSEC
echo.
echo   %ROJO%x  NO SE PUDO GENERAR EL SECRETO DEL WEBHOOK%FIN%
echo      Repite el bat; si sigue, reinstala Node.js.
echo.
pause
exit /b 1

:JSONFAIL
set "EM_T="
set "EM_W="
del /f /q "!EM_F!" >nul 2>&1
set "EM_F="
type "%TEMP%\chk_j.txt" 2>nul
del "%TEMP%\chk_j.txt" >nul 2>&1
echo.
echo   %ROJO%x  NO SE ARMARON LOS SECRETOS%FIN%
echo      Revisa worker\sa.json o borralo y repite.
echo.
pause
exit /b 1

:FALTASECRETO
echo.
echo   %ROJO%x  CLOUDFLARE NO TIENE:!FALTAN!%FIN%
echo.
echo      Al subir los secretos wrangler dijo:
type "%TEMP%\chk_s.txt" 2>nul
echo.
echo      Al listarlos dijo:
type "%TEMP%\chk_sl.txt" 2>nul
type "%TEMP%\chk_sle.txt" 2>nul
echo.
echo      %VERDE%Manda este texto a Claude.%FIN%
echo.
pause
exit /b 1

:NOCURL
echo.
echo   %ROJO%x  NO HAY CURL EN ESTA PC%FIN%
echo      Actualiza Windows 10 o corre el setWebhook a mano.
echo.
pause
exit /b 1

:WHFAIL
type "%TEMP%\chk_wh.txt" 2>nul
del "%TEMP%\chk_wh.txt" >nul 2>&1
echo.
echo   %ROJO%x  TELEGRAM NO ACEPTO EL WEBHOOK%FIN%
echo      Token mal copiado: repite el bat.
echo.
pause
exit /b 1

:WHNOCUADRA
del "%TEMP%\chk_wi.txt" >nul 2>&1
echo.
echo   %ROJO%x  EL WEBHOOK NO APUNTA AL WORKER%FIN%
echo      Revisa WORKER_URL en _config.bat y repite.
echo.
pause
exit /b 1

:CHECALOGIN
REM errorlevel 0 = hay sesion. `wrangler whoami` contesta 0 aunque NO haya
REM sesion (por eso este bat decia "ok" sin haber entrado): se lee el texto.
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
