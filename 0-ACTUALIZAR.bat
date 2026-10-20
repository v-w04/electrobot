@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
call _config.bat
title Actualizar

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
echo   ACTUALIZAR                        bajar de GitHub
echo   %AZUL%----------------------------------------------------%FIN%
echo.
call :BUSCARGIT
if errorlevel 1 goto NOGIT
del /f /q ".git\index.lock" ".git\HEAD.lock" ".git\config.lock" >nul 2>&1
del /f /q ".git\objects\maintenance.lock" >nul 2>&1
del /f /q ".git\refs\heads\*.lock" >nul 2>&1

echo   %AZUL%[1/2]%FIN%  Cambios locales . . . . . . . . . .
"!GIT!" diff-index --quiet HEAD -- 2>nul
if errorlevel 1 goto HAYLOCALES
echo          ninguno
goto BAJAR

:HAYLOCALES
echo          SI hay
echo.
echo   %ROJO%^^!  CAMBIOS SIN SUBIR - corre 5-SUBIR-TODO.bat%FIN%
echo.

:BAJAR
set "ANTES="
"!GIT!" rev-parse HEAD > "%TEMP%\chk_a.txt" 2>nul
if exist "%TEMP%\chk_a.txt" set /p ANTES=<"%TEMP%\chk_a.txt"
del "%TEMP%\chk_a.txt" >nul 2>&1

echo   %AZUL%[2/2]%FIN%  Bajando . . . . . . . . . . . . . .
"!GIT!" pull -q origin %GH_BRANCH%
if errorlevel 1 goto PULLFAIL

set "DESPUES="
"!GIT!" rev-parse HEAD > "%TEMP%\chk_d.txt" 2>nul
if exist "%TEMP%\chk_d.txt" set /p DESPUES=<"%TEMP%\chk_d.txt"
del "%TEMP%\chk_d.txt" >nul 2>&1

if "!ANTES!"=="!DESPUES!" (
    echo          nada nuevo
) else (
    "!GIT!" diff --name-only !ANTES! !DESPUES!
)
echo.
echo   %AZUL%----------------------------------------------------%FIN%
echo.
echo %VERDE%  Listo.%FIN%
echo.
call :LOGO
exit /b 0

:NOGIT
echo.
echo   %ROJO%x  NO ENCUENTRO GIT%FIN%
echo      Instala GitHub Desktop o Git para Windows
echo.
pause
exit /b 1

:PULLFAIL
echo.
echo   %ROJO%x  FALLO LA BAJADA%FIN%
echo      Conflicto: resuelvelo en GitHub Desktop
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

:LOGO
where node >nul 2>&1
if errorlevel 1 goto SINLOGO
if not exist "%~dp0logo-animado.js" goto SINLOGO
node "%~dp0logo-animado.js" giro marca 0 12
goto :eof

:SINLOGO
pause
goto :eof
