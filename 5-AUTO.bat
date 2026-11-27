@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Subida automatica - Electrobot
REM ============================================================
REM  5-AUTO.bat (Electrobot)  -  lo crea y lo programa el 5-AUTO de Site Sheet (FORCEV).
REM  Cada 15 min: si hay cambios sin subir, espera a que no se esten editando (4 min)
REM  y corre 5-SUBIR-TODO.bat (credenciales, sintaxis, Cloudflare, GitHub).
REM  Sin ventana (tarea de Windows). Lo que hace queda en .git\electrobot-auto\auto.log
REM  Modos:  (sin nada) o "instalar" = crea la tarea  |  "auto" = una vuelta  |  "quitar" = borra la tarea
REM ============================================================
set "MODO=%~1"
set "RAIZ=%~dp0"
set "CFG=%RAIZ%.git\electrobot-auto"
set "LOG=%CFG%\auto.log"
set "LOCK=%CFG%\lock.txt"
set "TAREA=Electrobot-Auto-Subir"
set "EA_LOCK=%LOCK%"
set "EA_RAIZ=%RAIZ%"

if not exist "%RAIZ%.git" (
  echo.
  echo   Esta carpeta no es el repositorio de Electrobot.
  if /i not "%MODO%"=="auto" pause
  exit /b 1
)
if not exist "%CFG%" mkdir "%CFG%"
call :BUSCARGIT
if errorlevel 1 (
  >>"%LOG%" echo %date% %time% no encuentro git
  if /i not "%MODO%"=="auto" pause
  exit /b 1
)
if /i "%MODO%"=="auto" goto AUTO
if /i "%MODO%"=="quitar" goto QUITAR
goto INSTALAR

:AUTO
REM Marca de vida: cada vuelta deja la hora aqui
>"%CFG%\latido.txt" echo %date% %time%
if exist "%LOCK%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "if (((Get-Date) - (Get-Item -LiteralPath $env:EA_LOCK).LastWriteTime).TotalMinutes -gt 30) { exit 1 } else { exit 0 }"
  if not errorlevel 1 exit /b 0
)
>"%LOCK%" echo %date% %time%
call :HAYCAMBIOS
if errorlevel 1 (
  del /f /q "%LOCK%" >nul 2>&1
  exit /b 0
)
call :ESTABLE
if errorlevel 1 (
  >>"%LOG%" echo %date% %time% hay archivos que cambiaron hace menos de 4 min: espero a la siguiente vuelta
  del /f /q "%LOCK%" >nul 2>&1
  exit /b 0
)
>>"%LOG%" echo %date% %time% hay cambios: corro 5-SUBIR-TODO.bat
call "%RAIZ%5-SUBIR-TODO.bat" <nul >"%CFG%\ultimo-5.txt" 2>&1
set "RC=!errorlevel!"
if "!RC!"=="0" (
  >>"%LOG%" echo %date% %time% SUBIDO: 5-SUBIR-TODO.bat termino bien
) else (
  >>"%LOG%" echo %date% %time% FALLO el 5-SUBIR-TODO.bat ^(codigo !RC!^): ver .git\electrobot-auto\ultimo-5.txt
)
del /f /q "%LOCK%" >nul 2>&1
exit /b !RC!

:INSTALAR
set "V=%CFG%\oculto.vbs"
>"%V%" echo Set sh = CreateObject("WScript.Shell")
>>"%V%" echo sh.Run "cmd /c ""%~f0"" auto", 0, True
schtasks /create /tn "%TAREA%" /tr "wscript.exe //B \"%V%\"" /sc minute /mo 15 /f >nul 2>&1
if errorlevel 1 (
  >>"%LOG%" echo %date% %time% no pude crear la tarea %TAREA%
  echo.
  echo   No pude crear la tarea de Windows.
  if /i not "%~2"=="callado" pause
  exit /b 1
)
>>"%LOG%" echo %date% %time% tarea %TAREA% creada: corre cada 15 min sin ventana
echo.
echo   Tarea creada: Electrobot sube solo cada 15 min.
echo   Lo que hace queda en .git\electrobot-auto\auto.log
if /i not "%~2"=="callado" timeout /t 8 /nobreak >nul
exit /b 0

:QUITAR
schtasks /delete /tn "%TAREA%" /f >nul 2>&1
>>"%LOG%" echo %date% %time% tarea %TAREA% quitada
echo.
echo   Tarea quitada. La subida vuelve a ser solo con 5-SUBIR-TODO.bat
timeout /t 8 /nobreak >nul
exit /b 0

:HAYCAMBIOS
"!GIT!" status --porcelain > "%CFG%\st.txt" 2>nul
set "N=0"
for /f %%C in ('find /c /v "" ^< "%CFG%\st.txt"') do set "N=%%C"
if not "!N!"=="0" exit /b 0
set "PEND=0"
"!GIT!" rev-list --count @{u}..HEAD > "%CFG%\pe.txt" 2>nul
if exist "%CFG%\pe.txt" set /p PEND=<"%CFG%\pe.txt"
if not "!PEND!"=="0" exit /b 0
exit /b 1

:ESTABLE
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=(Get-Date).AddMinutes(-4); $x=Get-ChildItem -LiteralPath $env:EA_RAIZ -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\/](\.git|_to_delete|node_modules)[\\/]' -and $_.LastWriteTime -gt $c } | Select-Object -First 1; if ($x) { exit 1 } else { exit 0 }"
exit /b %errorlevel%

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
