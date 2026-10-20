@echo off
REM ============================================================
REM  Seguro anti-credenciales - lo llaman 3- y 5-
REM ============================================================
REM
REM  El repo es PUBLICO y git guarda el historial para siempre.
REM  Una credencial subida no se quita borrandola en un commit
REM  posterior: hay que rotarla. Por eso se detiene ANTES del
REM  commit.
REM
REM  En este proyecto ninguna credencial debe estar en un archivo:
REM  el token de Telegram, el secreto del webhook y la cuenta de
REM  servicio de Google son secretos de Cloudflare.
REM
REM  Devuelve errorlevel 1 si encuentra algo sospechoso.
REM ============================================================

setlocal enabledelayedexpansion
set FUGA=0

REM ---- Archivos que nunca deben vivir en el repo ----
REM  Cloudflare.txt era el worker completo con el token dentro.
for %%F in (.env .dev.vars secretos.txt sa.json worker\sa.json Cloudflare.txt) do (
    if exist "%%F" (
        echo        ALERTA: existe el archivo %%F
        set FUGA=1
    )
)

REM ---- El .gitignore tiene que estar ----
if not exist ".gitignore" (
    echo        ALERTA: no hay .gitignore
    set FUGA=1
)

REM ---- Revision de patrones dentro del codigo ----
where powershell >nul 2>&1
if errorlevel 1 goto SINPOWERSHELL

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_seguro.ps1"
if errorlevel 1 set FUGA=1
goto FINAL

:SINPOWERSHELL
echo        AVISO: no hay PowerShell, revision de patrones omitida.
echo        Revisa a ojo que no haya credenciales antes de subir.

:FINAL
endlocal & exit /b %FUGA%
