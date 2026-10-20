@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
call _config.bat
title Subir todo

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
echo   SUBIR TODO                    Cloudflare + GitHub
echo   %AZUL%----------------------------------------------------%FIN%
set "SINVER="
echo.
echo   %AZUL%[1/4]%FIN%  Credenciales . . . . . . . . . . . .
call _seguro.bat
if errorlevel 1 goto FUGA
echo          limpio

echo   %AZUL%[2/4]%FIN%  Sintaxis del worker . . . . . . . .
if not exist "worker\src\index.js" goto VACIO
node --check "worker\src\index.js" 2>"%TEMP%\chk_n.txt"
if errorlevel 1 goto SINTAXIS
del "%TEMP%\chk_n.txt" >nul 2>&1
echo          ok

echo   %AZUL%[3/4]%FIN%  Cloudflare . . . . . . . . . . . . .
call :CHECALOGIN
if errorlevel 1 goto SINSESION
pushd worker
call wrangler deploy > "%TEMP%\chk_d.txt" 2>&1
popd

REM Verde solo si es verdad. El codigo de salida de wrangler no sirve de
REM veredicto en esta PC (miente en los dos sentidos): se le pregunta al
REM worker QUE version esta sirviendo. Cloudflare tarda unos segundos en
REM cambiar, asi que se pregunta hasta 3 veces.
where curl >nul 2>&1
if errorlevel 1 goto SINCURL
set "TRIES=0"

:PREGUNTAVER
curl -s -m 25 "%WORKER_URL%" > "%TEMP%\chk_v.txt" 2>nul
findstr /C:"OK %WORKER_VERSION%" "%TEMP%\chk_v.txt" >nul 2>&1
if not errorlevel 1 goto VERSIONOK
set /a TRIES+=1
if !TRIES! lss 3 (
    timeout /t 4 /nobreak >nul
    goto PREGUNTAVER
)
goto NOSIRVE

:VERSIONOK
del "%TEMP%\chk_v.txt" >nul 2>&1
del "%TEMP%\chk_d.txt" >nul 2>&1
echo          desplegado y verificado
goto GITHUB

:SINCURL
del "%TEMP%\chk_d.txt" >nul 2>&1
echo          desplegado, sin verificar
set "SINVER=1"

:GITHUB
echo   %AZUL%[4/4]%FIN%  GitHub . . . . . . . . . . . . . . .
call :BUSCARGIT
if errorlevel 1 goto NOGIT
REM Candados que quedan cuando un git muere a medias. Antes solo se
REM borraba index.lock, pero HEAD.lock tumbaba el commit y el bat
REM seguia contento.
del /f /q ".git\index.lock" ".git\HEAD.lock" ".git\config.lock" >nul 2>&1
del /f /q ".git\objects\maintenance.lock" >nul 2>&1
del /f /q ".git\refs\heads\*.lock" >nul 2>&1
"!GIT!" status --porcelain > "%TEMP%\chk_s.txt" 2>nul
set CAMBIOS=0
for /f %%C in ('find /c /v "" ^< "%TEMP%\chk_s.txt"') do set CAMBIOS=%%C
del "%TEMP%\chk_s.txt" >nul 2>&1

REM Commits hechos y sin subir. Con el arbol limpio el bat decia "sin
REM cambios" y se saltaba el push: la version se quedaba en la compu.
set PENDIENTES=0
"!GIT!" rev-list --count @{u}..HEAD > "%TEMP%\chk_p.txt" 2>nul
if exist "%TEMP%\chk_p.txt" set /p PENDIENTES=<"%TEMP%\chk_p.txt"
del "%TEMP%\chk_p.txt" >nul 2>&1
if not defined PENDIENTES set PENDIENTES=0

if "!CAMBIOS!"=="0" (
    if "!PENDIENTES!"=="0" (
        echo          sin cambios
        goto FIN
    )
    "!GIT!" push origin %GH_BRANCH% > "%TEMP%\chk_push.txt" 2>&1
    if errorlevel 1 goto PUSHFAIL
    goto VERIFICA
)
set "MSG=%MSG_DEFAULT%"
"!GIT!" add -A >nul 2>"%TEMP%\chk_a.txt"
if errorlevel 1 goto ADDFAIL
"!GIT!" commit -q -m "!MSG!" >nul 2>"%TEMP%\chk_c.txt"
if errorlevel 1 goto COMMITFAIL
"!GIT!" push origin %GH_BRANCH% > "%TEMP%\chk_push.txt" 2>&1
if errorlevel 1 goto PUSHFAIL

:VERIFICA
del "%TEMP%\chk_a.txt" "%TEMP%\chk_c.txt" >nul 2>&1
REM Se compara lo que quedo en GitHub contra lo que hay en esta carpeta.
set LOCAL=
set REMOTO=
"!GIT!" rev-parse HEAD > "%TEMP%\chk_l.txt" 2>nul
if exist "%TEMP%\chk_l.txt" set /p LOCAL=<"%TEMP%\chk_l.txt"
del "%TEMP%\chk_l.txt" >nul 2>&1
"!GIT!" ls-remote origin %GH_BRANCH% > "%TEMP%\chk_r.txt" 2>nul
if exist "%TEMP%\chk_r.txt" set /p REMOTO=<"%TEMP%\chk_r.txt"
del "%TEMP%\chk_r.txt" >nul 2>&1
if not defined LOCAL goto NOCUADRA
if not defined REMOTO goto NOCUADRA
if /i not "!LOCAL:~0,10!"=="!REMOTO:~0,10!" goto NOCUADRA
echo          subido y verificado

:FIN
echo.
echo   %AZUL%----------------------------------------------------%FIN%
echo.
if defined SINVER (
    echo   %ROJO%^^!  NO PUDE CONFIRMAR LA VERSION DEL WORKER%FIN%
) else (
    echo %VERDE%  Listo. El bot y la app web ya traen los cambios.%FIN%
)
echo.
call :LOGO
exit /b 0

:FUGA
echo.
echo   %ROJO%x  POSIBLE CREDENCIAL - no se subio nada%FIN%
echo      Borra el archivo que te senala arriba y repite.
echo.
pause
exit /b 1

:VACIO
echo.
echo   %ROJO%x  FALTA worker\src\index.js - no se subio nada%FIN%
echo.
pause
exit /b 1

:SINTAXIS
type "%TEMP%\chk_n.txt" 2>nul
del "%TEMP%\chk_n.txt" >nul 2>&1
echo.
echo   %ROJO%x  EL WORKER NO COMPILA - no se subio nada%FIN%
echo.
pause
exit /b 1

:SINSESION
echo.
echo   %ROJO%x  SIN SESION DE CLOUDFLARE - no se subio nada%FIN%
echo      Corre 1-INSTALAR-WRANGLER.bat
echo.
pause
exit /b 1

:NOSIRVE
del "%TEMP%\chk_v.txt" >nul 2>&1
echo.
echo      Lo que dijo wrangler al desplegar:
type "%TEMP%\chk_d.txt" 2>nul
del "%TEMP%\chk_d.txt" >nul 2>&1
echo.
echo   %ROJO%x  CLOUDFLARE NO ESTA SIRVIENDO %WORKER_VERSION%%FIN%
echo      Repite el bat; si sigue, manda este texto a Claude.
echo.
pause
exit /b 1

:NOGIT
echo.
echo   %ROJO%x  NO ENCUENTRO GIT%FIN%
echo      Instala GitHub Desktop o Git para Windows
echo.
pause
exit /b 1

:ADDFAIL
type "%TEMP%\chk_a.txt" 2>nul
del "%TEMP%\chk_a.txt" >nul 2>&1
echo.
echo   %ROJO%x  FALLO GIT ADD - no se subio a GitHub%FIN%
echo      Cierra otras ventanas de git y repite
echo.
pause
exit /b 1

:COMMITFAIL
type "%TEMP%\chk_c.txt" 2>nul
del "%TEMP%\chk_c.txt" >nul 2>&1
echo.
echo   %ROJO%x  FALLO EL COMMIT - no se subio a GitHub%FIN%
echo      Cierra otras ventanas de git y repite
echo.
pause
exit /b 1

:PUSHFAIL
echo.
echo   %ROJO%x  FALLO EL PUSH A GITHUB%FIN%
echo.
findstr /I /C:"Internal Server Error" /C:"HTTP 500" /C:"HTTP 502" /C:"HTTP 503" "%TEMP%\chk_push.txt" >nul 2>&1
if not errorlevel 1 (
    echo      Es GitHub, no tu: su servidor contesto con un error interno.
    echo      %VERDE%Espera unos minutos y repite este mismo bat.%FIN%
    goto PUSHFAIL_FIN
)
findstr /I /C:"non-fast-forward" /C:"fetch first" /C:"behind" "%TEMP%\chk_push.txt" >nul 2>&1
if not errorlevel 1 (
    echo      GitHub tiene cambios que no estan en esta computadora.
    echo      %VERDE%Corre 0-ACTUALIZAR.bat y repite este bat.%FIN%
    goto PUSHFAIL_FIN
)
findstr /I /C:"Authentication failed" /C:"could not read Username" /C:"Permission denied" "%TEMP%\chk_push.txt" >nul 2>&1
if not errorlevel 1 (
    echo      GitHub no te reconocio ^(sesion o permisos^).
    echo      %VERDE%Abre GitHub Desktop, inicia sesion y repite.%FIN%
    goto PUSHFAIL_FIN
)
echo      Lo que contesto GitHub:
echo.
type "%TEMP%\chk_push.txt" 2>nul
echo.
echo      %VERDE%Manda este texto a Claude para que lo revise.%FIN%
:PUSHFAIL_FIN
echo.
pause
exit /b 1

:NOCUADRA
echo.
echo   %ROJO%x  GITHUB NO QUEDO IGUAL QUE TU CARPETA%FIN%
echo      Repite el bat; si sigue, corre 0-ACTUALIZAR.bat
echo.
pause
exit /b 1

:BUSCARGIT
set "GIT=git"
where git >nul 2>&1
if not errorlevel 1 exit /b 0
for /d %%D in ("%LOCALAPPDATA%\GitHubDesktop\app-*") do (
    if exist "%%D\resources\app\git\cmd\git.exe" set "GIT=%%D\resources\app\git\cmd\git.exe"
)
if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if "!GIT!"=="git" exit /b 1
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
