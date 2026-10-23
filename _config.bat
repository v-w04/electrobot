@echo off
REM ============================================================
REM  Configuracion del proyecto - EDITA SOLO ESTE ARCHIVO
REM ============================================================
REM  Los demas .bat leen de aqui.
REM
REM  AQUI NO VA NINGUNA CREDENCIAL. El token de Telegram, el
REM  secreto del webhook y la cuenta de servicio de Google viven
REM  en los secretos de Cloudflare (wrangler secret put).
REM ============================================================

set "PROYECTO=electrobot"
set "GH_USER=v-w04"
set "GH_REPO=electrobot"
set "GH_BRANCH=main"
set "MSG_DEFAULT=Actualiza bot"

REM Worker de Cloudflare. El nombre tiene que ser el mismo que
REM worker\wrangler.toml, y la URL es la publica del worker.
set "WORKER_NAME=electronics-bot"
set "WORKER_URL=https://electronics-bot.victor-walmart-04.workers.dev"

REM Sello que devuelve el GET del worker. Tiene que coincidir con
REM BOT_VERSION de worker\src\index.js: es lo que hace honesto el
REM verde del 5 - si Cloudflare sirve codigo viejo, sale rojo.
set "WORKER_VERSION=v8.3"
