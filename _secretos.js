// Arma el JSON que lee `wrangler secret bulk`. Lo llama 1-INSTALAR-WRANGLER.bat.
// Este archivo NO contiene ningun secreto: los toma del entorno del .bat
// (EM_T, EM_W) y, si existe, del JSON de la cuenta de servicio en
// worker/sa.json (que el .gitignore tapa). Escribe el resultado en EM_F;
// el .bat lo borra en cuanto wrangler termina.
const fs = require('fs');
const path = require('path');

const tok = String(process.env.EM_T || '').trim();
const wh  = String(process.env.EM_W || '').trim();
const out = String(process.env.EM_F || '').trim();
if (!tok || !wh || !out) { console.error('faltan valores para armar los secretos'); process.exit(2); }

const o = { TELEGRAM_TOKEN: tok, TELEGRAM_WEBHOOK_SECRET: wh };

const sa = path.join(__dirname, 'worker', 'sa.json');
if (fs.existsSync(sa)) {
  try {
    const txt = fs.readFileSync(sa, 'utf8');
    JSON.parse(txt);                      // que al menos sea JSON valido
    o.GOOGLE_SA_JSON = txt;
  } catch (e) {
    console.error('worker\\sa.json no es un JSON valido: ' + e.message);
    process.exit(3);
  }
}

fs.writeFileSync(out, JSON.stringify(o));
