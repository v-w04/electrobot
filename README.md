# electrobot

Bot interno de Electronics México. Dos piezas en un solo repo:

| Carpeta | Qué es | Dónde vive |
|---|---|---|
| raíz (`index.html`, `service-worker.js`) | app web (PWA) | GitHub Pages → https://v-w04.github.io/electrobot/ |
| `worker/` | el cerebro: Telegram + `/api/query` | Cloudflare Worker `electronics-bot` |

## Bats

| | |
|---|---|
| `0-ACTUALIZAR.bat` | baja de GitHub antes de ponerte a trabajar |
| `1-INSTALAR-WRANGLER.bat` | una vez por computadora: wrangler, secretos y webhook |
| `3-VERIFICAR.bat` | dice si esta PC y el worker publicado están en orden |
| `5-SUBIR-TODO.bat` | despliega el worker y sube a GitHub, verificando los dos |

## Secretos

Ninguna credencial vive en el repo. Son secretos de Cloudflare
(`wrangler secret put`) y los pone `1-INSTALAR-WRANGLER.bat`:

- `TELEGRAM_TOKEN` — token del bot (BotFather)
- `TELEGRAM_WEBHOOK_SECRET` — se genera solo; valida que quien llama es Telegram
- `GOOGLE_SA_JSON` — opcional: cuenta de servicio para leer hojas no públicas.
  Pon el JSON como `worker/sa.json` (el `.gitignore` lo tapa) y corre el 1.

## Fuentes de datos

El bot lee **solo dos libros** de Google Sheets (no usa Odoo ni ninguna otra API):

| Libro | Pestañas que usa |
|---|---|
| **Sheet Site** | Inventarios · Precios EM/CVA (Minimo, Normal, Maximo) · Concentrado · Killers |
| **Venta Diaria Odoo 2026** | WALMART · PEDIDOS CVA · KILLERS ACTIVOS · KILLERS HISTORICO · Histórico de alertas · SKU ASIGNADOS · Sobreventa WFS · Sobreventa Pick |

Retirados (ya no tienen hoja): Checador (asistencia, bonos, vacaciones, turnos,
cumpleaños, departamentos), Traslados, Ventiapp y el Chatbot de frases. Esos
comandos contestan "se retiró" en vez de buscar datos.

Un precio solo cuenta como erróneo si está debajo del mínimo y **no** hay un
killer ni una promo que lo justifique ese día (se revisa contra las hojas, no
solo contra la lista de alertas ya levantadas).

## Versión

`BOT_VERSION` en `worker/src/index.js` y `WORKER_VERSION` en `_config.bat` tienen
que coincidir: el `5` le pregunta su versión al worker publicado y solo pinta
verde si Cloudflare está sirviendo este código. Si cambias una, cambia la otra.
