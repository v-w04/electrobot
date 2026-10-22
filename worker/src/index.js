// ============================================================
// ELECTRONICS MÉXICO - BOT (Telegram + app web)
// Cloudflare Worker v8.2
// Fuentes: SOLO dos libros de Google Sheets:
//          Sheet Site (inventario, precios, Killers, Concentrado)
//          Venta Diaria Odoo 2026 (ventas, alertas, killers, sobreventa)
//          El bot NO usa Odoo, Checador, Traslados, Ventiapp ni Chatbot.
//
// SECRETOS: nada sensible vive en este archivo. Se cargan de env
// (wrangler secret put …) en cargarEnv() al inicio de cada request:
//   TELEGRAM_TOKEN · TELEGRAM_WEBHOOK_SECRET · GOOGLE_SA_JSON (opcional)
// ============================================================

// Sello de version. El GET de la raiz lo devuelve y 5-SUBIR-TODO.bat lo
// compara contra WORKER_VERSION de _config.bat: asi el verde solo sale si
// Cloudflare de verdad esta sirviendo este codigo y no el anterior.
const BOT_VERSION    = 'v8.2';

let TELEGRAM_API     = '';     // se arma en cargarEnv() con env.TELEGRAM_TOKEN
let GOOGLE_SA        = null;   // env.GOOGLE_SA_JSON parseado (cuenta de servicio)
const MAX_RES        = 20;     // Tope para Telegram (límite 4096 chars)
const UMBRAL_AVISO   = 200;    // Si un resultado supera esto → avisar posible filtro amplio

// Copia los secretos de env a variables de módulo. Se llama al inicio de
// fetch(); los isolates de Workers reutilizan el módulo, así que es barato.
function cargarEnv(env) {
  env = env || {};
  // .trim(): los secretos se suben por tuberia desde el .bat y un salto de
  // linea pegado al final rompia la URL de Telegram sin decir por que.
  const tok = String(env.TELEGRAM_TOKEN || '').trim();
  TELEGRAM_API = tok ? 'https://api.telegram.org/bot' + tok : '';
  if (env.GOOGLE_SA_JSON && !GOOGLE_SA) {
    try { GOOGLE_SA = JSON.parse(env.GOOGLE_SA_JSON); }
    catch (e) { console.error('GOOGLE_SA_JSON inválido: ' + e.message); }
  }
}

// ── Helpers de canal ────────────────────────────────────────
// La app web NO tiene límite de longitud → mostramos TODO.
// Telegram mantiene MAX_RES (20) + "...y X más".
function esWeb(chatId) { return String(chatId).indexOf('web:') === 0; }
function limCanal(chatId) { return esWeb(chatId) ? 999999 : MAX_RES; }

// Devuelve un banner de aviso (o '') cuando hay demasiados registros.
function avisoFiltroAmplio(total) {
  if (total <= UMBRAL_AVISO) return '';
  return '⚠️ <b>'+total+' registros</b> — ¿filtro demasiado amplio? '+
         'Prueba acotar por <b>fecha</b> o <b>nombre</b>.\n━━━━━━━━━━━━━━━━━\n\n';
}

// ── Sheet IDs (fuentes vivas, sept 2026) ────────────────────
const ID = {
  SITE:         '1Yjwyyv7EF5CJ3tJ2DgGzXO7QHxyrC0aCCSj1MHL5AKY', // Sheet Site: inventario, precios, Killers, Walmart
  VENTA_DIARIA: '17S65PqXK1DfJeHloJ4IFt-3K-MnQKOQaN_BiE9RUYaw'  // Venta Diaria Odoo 2026: ventas, alertas, killers, sobreventa
};


// Comandos que se dieron de baja (su fuente ya no existe). El router
// contesta con este texto en vez de mostrar datos viejos.
const RETIRADO = {
  gym:         '🏋️ El gym ya no se lleva. Comando retirado.',
  porRecibir:  '🚚 <i>Por recibir</i> se dio de baja: ya no hay fuente que lo actualice.',
  vendedor:    '👤 <i>Vendedor incorrecto</i> se dio de baja: Venta Diaria ya no lleva esa revisión.',
  entradas:    '📥 <i>Entradas</i> se dio de baja: su hoja dejó de actualizarse.',
  bodega:      '🏭 El inventario del Sheet Site ya no trae la bodega de cada SKU. Usa <code>stock [sku o nombre]</code>.',
  checador:    '⏰ El <i>Checador</i> (asistencia, bonos, vacaciones, turnos, cumpleaños) se retiró del bot: su hoja ya no existe. El bot solo lee Sheet Site y Venta Diaria.',
  traslados:   '🚛 <i>Traslados</i> se retiró del bot: su hoja ya no existe. El bot solo lee Sheet Site y Venta Diaria.',
  ventiapp:    '🛒 <i>Ventiapp</i> se retiró del bot: su hoja ya no existe. Para existencias usa <code>stock [sku o nombre]</code>.',
  interno:     '🛠️ Los comandos internos eran del Checador 6.0, que ya no se usa. Se retiraron.'
};








const INV = { REF:0, CAT:1, MARCA:2, NOMBRE:3, MODELO:4, COLOR:5, DISP:9, SKU:10, BODEGA:11 };

// ── Columnas hojas de canal de venta ────────────────────────
const CANAL = { ID_LINEA:0, SO:1, FECHA:2, CLIENTE:3, VENDEDOR:4,
                ESTADO:5, SKU:6, PRODUCTO:7, CANTIDAD:8,
                PRECIO:9, IMPORTE:10, TOTAL:11, PRECIO_REF:12 };








// Hojas de canal donde buscar por SO (excluye históricas)
// Venta Diaria Odoo 2026 (desde 21/09/2026) solo lleva dos hojas de venta:
//   WALMART      → ventas del cliente Walmart (A–L venta + M precio referencia)
//   PEDIDOS CVA  → ventas de SKUs -CVA de todas las plataformas (A–L)
// Las hojas por canal (ML, Liverpool, Coppel…) se eliminaron del libro.
const HOJAS_CANAL = ['WALMART', 'PEDIDOS CVA'];

const CANALES = {
  'walmart':  'WALMART',
  'cva':      'PEDIDOS CVA'
};
// Canales que antes tenían hoja y ya no: se avisa en vez de "sin ventas".
const CANALES_RETIRADOS = ['sears','liverpool','liv','sanborns','tiktok','coppel','mercado libre',
                           'ml','meli','tiendanube','tienda nube','elektra','totalplay'];

// ── PIN desactivado por el momento ─────────────────────────

// ── Memoria de conversación por usuario ─────────────────────
// Guarda los últimos mensajes por chatId con TTL de 10 minutos
const conversaciones = {};
const CONV_TTL     = 10 * 60 * 1000; // 10 minutos
const CONV_MAX_MSG = 6;               // máximo 6 mensajes (3 intercambios)

// ── Cloudflare AI (incluido en Workers, sin API key externa) ─
const CF_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const WHATSAPP = [];
const USUARIOS = {};

// ============================================================
// ENTRY POINT
// ============================================================



export default {
  async fetch(request, env, ctx) {
    cargarEnv(env);
    const url = new URL(request.url);

    // ── CORS preflight para la app web ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // ── GET /api/empleados: ya no hay lista de empleados (se retiró el Checador).
    // Se deja contestando vacío para las apps web viejas que aún lo piden.
    if (url.pathname === '/api/empleados' && request.method === 'GET') {
      return jsonCors({ empleados: [] });
    }

    // ── Endpoint app web: POST /api/query { message: "..." } ──
    // Devuelve { messages: ["html1", "html2", ...] } con todas las respuestas
    if (url.pathname === '/api/query' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return jsonCors({ error: 'JSON inválido' }, 400);
      }
      const texto = String(body.message || '').trim();
      if (!texto) return jsonCors({ error: 'message vacío' }, 400);

      // chatId único para esta sesión web; el prefijo 'web:' activa el buffer
      const chatId = 'web:' + (body.session || Math.random().toString(36).slice(2));
      const nombre = body.user || 'Web';

      // Limpiar buffer previo de esta sesión
      _webBuffer.delete(chatId);

      try {
        await router(chatId, texto, nombre, env);
      } catch(e) {
        return jsonCors({ error: e.message, messages: _webBuffer.get(chatId) || [] }, 500);
      }

      const messages = _webBuffer.get(chatId) || [];
      _webBuffer.delete(chatId);
      return jsonCors({ messages: messages });
    }

    if (request.method === 'GET') {
      return new Response('BOT_EM OK ' + BOT_VERSION, {
        status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status:405 });
    // Webhook de Telegram: si hay TELEGRAM_WEBHOOK_SECRET, solo se aceptan
    // peticiones que traigan ese secreto (Telegram lo manda en este header).
    const whSecret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if (whSecret &&
        request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== whSecret) {
      return new Response('forbidden', { status:403 });
    }
    let body;
    try { body = await request.json(); } catch(e) { return ok200(); }
    ctx.waitUntil(procesarBody(body, env));
    return ok200();
  }
};

function ok200() {
  return new Response('{"ok":true}', { status:200, headers:{'Content-Type':'application/json'} });
}

function jsonCors(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function procesarBody(body, env) {
  try {
    // Mensaje de texto normal
    const msg = body.message || body.edited_message;
    if (msg && msg.text) {
      const chatId = String(msg.chat.id);
      const texto  = msg.text.trim();
      const nombre = msg.from.first_name || 'Usuario';
      console.log('['+chatId+']: '+texto);
      await router(chatId, texto, nombre, env);
      return;
    }

    // Callback de botón inline
    const cb = body.callback_query;
    if (cb) {
      const chatId  = String(cb.message.chat.id);
      const data    = cb.data || '';
      const nombre  = cb.from.first_name || 'Usuario';
      console.log('['+chatId+'] callback: '+data);
      await fetch(TELEGRAM_API+'/answerCallbackQuery', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ callback_query_id: cb.id })
      });
      if (data.startsWith('frase:')) {
        await router(chatId, data.replace('frase:', ''), nombre, env);
      }
    }
  } catch(e) { console.error('procesarBody:', e.message); }
}

// ============================================================
// ROUTER
// ============================================================

async function router(chatId, texto, nombre, env) {
  const cmd = texto.toLowerCase().trim();

  // Comandos slash de Telegram (puntuales)
  if (cmd === '/start' || cmd === '/ayuda') { await ayuda(chatId, nombre); return; }
  if (cmd === '/miid')    { await enviar(chatId, '🆔 <b>Chat ID:</b> <code>'+chatId+'</code>'); return; }
  if (cmd === '/stock')   { await stockBajo(chatId); return; }
  if (cmd === '/reporte') { await reporteInventario(chatId); return; }
  if (cmd === '/olvida' || cmd === 'olvida') { limpiarHistorial(chatId); await enviar(chatId, '🧹 Conversación borrada. Empezamos de cero.'); return; }

  // Comandos internos del Checador 6.0: retirados (el 6.0 ya no se usa)
  if (/\bcomando\s+interno\b/i.test(texto)) { await enviar(chatId, RETIRADO.interno); return; }

  // Normalizar texto para detección flexible (sin acentos, minúsculas)
  const tNorm = sinAcentos(texto.toLowerCase().trim());

  // ── Helpers de detección ──────────────────────────────────────────
  function tiene(re) { return re.test(tNorm); }

  // Extrae el argumento quitando las palabras clave del comando
  function args(...palabras) {
    let r = tNorm;
    palabras.forEach(function(p){ r = r.replace(new RegExp('\\b'+p+'\\b','g'),''); });
    return r.replace(/\s+/g,' ').trim();
  }

  // ── AYUDA / COMANDOS — debe ir AL INICIO antes que cualquier otro patrón
  // para que "ayuda" no caiga a la IA ni al inventario. Atrapa muchas
  // variantes: "ayuda", "lista de comandos", "ver comandos", "todos los
  // comandos", "que puedes hacer", "help", "menu", etc.
  if (
    /^(ayuda|comandos?|help|menu|menú|opciones?)\b/.test(tNorm) ||
    /^(que|cuales)\s+(comandos?|funciones?|cosas)/.test(tNorm) ||
    /^(que|qué)\s+(puedes|sabes|podemos)\s+hacer/.test(tNorm) ||
    /^(ver|listar?|dame|muestra|mostrar)\s+(los\s+|todos\s+los\s+)?comandos?/.test(tNorm) ||
    /^lista\s+(de\s+|completa\s+(de\s+)?)?comandos?/.test(tNorm) ||
    /^todos\s+los\s+comandos?/.test(tNorm)
  ) {
    await ayuda(chatId, nombre || '');
    return;
  }

  // ── STOCK / INVENTARIO — "stock <termino>" limpia la palabra "stock"
  // y busca solo por el término. Sin término, va al inventario general.
  if (/^stock\b/.test(tNorm)) {
    const a = tNorm.replace(/^stock\s*/, '').trim();
    if (!a) { await cmdInventario(chatId, ''); return; }
    // Si trae operador de stock (mayor a, menor a, etc.) → cmdInventario completo
    if (/(mayor|menor|igual)\b|[<>=]/.test(a)) {
      await cmdInventario(chatId, texto); return;
    }
    // Si solo es término libre → búsqueda directa en inventario
    await cmdInventario(chatId, a); return;
  }

  // ── COMANDOS RETIRADOS (su hoja ya no existe) ─────────────────────
  if (tiene(/\bgym\b/) || tiene(/\bgimnasio\b/)) { await enviar(chatId, RETIRADO.gym); return; }
  if (tiene(/\bcheck\b/) || tiene(/checador/) || tiene(/\bretardos?\b/) || tiene(/culpables/) ||
      tiene(/\bbonos?\b/) || tiene(/asistencia/) || tiene(/\bturno\b/) || tiene(/\bhorario\b/) ||
      tiene(/\bcumple(?:a[ñn]os)?\b/) || tiene(/\bbirthday\b/) || tiene(/\bdepartamentos?\b/) ||
      tiene(/\bdeptos?\b/) ||
      tiene(/^(faltas?|puntual(?:es)?|inhabil(?:es)?|vacaciones?|vacacion|enfermedades?|enfermedad|resumen)\b/) ||
      (tiene(/^alertas?(\s|$)/) && !tiene(/precios?/)) ||
      (tiene(/^reporte\b/))) {
    await enviar(chatId, RETIRADO.checador); return;
  }
  if (tiene(/traslados?/) || tiene(/rastreo/)) { await enviar(chatId, RETIRADO.traslados); return; }
  if (tiene(/ventiapp/) || tiene(/sin\s+publicar/) || tiene(/falta\s+poco/) || tiene(/urgente\s+publicar/) ||
      (tiene(/stock/) && tiene(/venti/))) {
    await enviar(chatId, RETIRADO.ventiapp); return;
  }

  // ── PESTAÑAS DE LOS DOS LIBROS ─────────────────────────────────────
  if (/^hojas?$/.test(tNorm) || /^pestanas?$/.test(tNorm)) { await cmdHojas(chatId); return; }
  if (/^hoja\s/.test(tNorm)) { await cmdHoja(chatId, tNorm.replace(/^hoja\s+/, '')); return; }
  if (/^buscar\s/.test(tNorm)) { await cmdBuscar(chatId, tNorm.replace(/^buscar\s+/, '')); return; }
  // Preguntas en español sobre los datos ("cuántos killers vigentes hay?")
  if (esPregunta_(texto) && !tiene(/sobreventa|precios?\s+err/)) {
    if (await preguntarHojas(chatId, texto, env)) return;
  }

  // KILLERS — "killers" / "killers 3027" / "killers Sony"
  if (tiene(/\bkillers?\b/)) {
    const a = args('killers','killer');
    await cmdKillers(chatId, a); return;
  }

  // ── BODEGA ─────────────────────────────────────────────────────────
  // "bodega A023" / "A023 bodega"
  if (tiene(/bodega/)) {
    await enviar(chatId, RETIRADO.bodega); return;
  }

  // ── SKU EXACTO ─────────────────────────────────────────────────────
  if (tiene(/^sku\s/)) {
    const a = args('sku');
    await buscarSKU(chatId, a); return;
  }

  // ── VENTAS ─────────────────────────────────────────────────────────
  // "venta walmart" / "walmart venta" / "ventas hoy walmart" / "venta 609107..."
  if (!tiene(/sobreventa/) && (tiene(/^ventas?\b/) || tiene(/venta/) && Object.keys(CANALES).some(function(k){ return tNorm.indexOf(k) !== -1; }))) {
    const a = args('venta','ventas');
    const tieneCanal = Object.keys(CANALES).some(function(k){ return a.indexOf(k) !== -1; }) ||
                       CANALES_RETIRADOS.some(function(k){ return new RegExp('\\b'+k+'\\b').test(a); });
    if (!tieneCanal && a.length > 3) { await cmdVentaBuscarSO(chatId, a); }
    else { await cmdVenta(chatId, a); }
    return;
  }

  // ── PRECIOS ERRÓNEOS ───────────────────────────────────────────────
  // "precios erroneos" / "erroneos precios" / "alertas precios"
  if (tiene(/precios?\s+err[oe]neos?/) || tiene(/err[oe]neos?\s+precios?/) || tiene(/alertas?\s+(?:de\s+)?precios?/)) {
    const a = args('precios','precio','erroneos','erroneas','alertas','alerta','de');
    await cmdPreciosErroneos(chatId, a); return;
  }

  // ── VENDEDORES INCORRECTOS ─────────────────────────────────────────
  // "vendedores incorrectos" / "incorrectos vendedores"
  if (tiene(/vendedores?\s+incorrectos?/) || tiene(/incorrectos?\s+vendedores?/)) {
    await enviar(chatId, RETIRADO.vendedor); return;
  }

  // ── SOBREVENTA ─────────────────────────────────────────────────────
  if (tiene(/sobreventa/)) {
    const a = args('sobreventa');
    await cmdSobreventa(chatId, a); return;
  }

  // ── POR RECIBIR ─────────────────────────────────────────────────────
  // "por recibir" / "recibir por" / "pendiente por recibir"
  if (tiene(/por\s+recibir/) || tiene(/recibir\s+por/) || (tiene(/recibir/) && tiene(/por/))) {
    await enviar(chatId, RETIRADO.porRecibir); return;
  }

  // ── PRECIOS ────────────────────────────────────────────────────────
  // "precio HP" / "HP precio" / "precio walmart Samsung" / "Samsung precio walmart"
  if (tiene(/\bprecios?\b/) && !tiene(/err[oe]neos?/)) {
    const a = args('precio','precios');
    await cmdPrecios(chatId, a); return;
  }

  // ── ENTRADAS ───────────────────────────────────────────────────────
  if (tiene(/^entradas?\b/)) {
    await enviar(chatId, RETIRADO.entradas); return;
  }

  // ── AUTOCORRECTOR DE COMANDOS ──────────────────────────────────────
  // Si la primera palabra del mensaje matchea APROXIMADAMENTE algún comando
  // conocido (ej. "vacasiones" → "vacaciones", "stok" → "stock"), avisamos
  // al usuario lo que entendimos y re-ejecutamos con la palabra corregida.
  // Solo aplica para palabras ≥4 chars (evita falsos positivos en palabras
  // cortas como "rh" o "ti").
  const COMANDOS_CONOCIDOS = [
    'ayuda','comandos','stock','venta','ventas','precio','precios',
    'sobreventa','killers','killer','sku','hojas','hoja','buscar'
  ];
  const palabras1 = tNorm.split(/\s+/);
  const primeraP = palabras1[0] || '';
  if (primeraP.length >= 4) {
    // ¿Es ya un comando exacto? Si no llegamos aquí, claramente no era válido.
    // Buscar comando aproximado (Levenshtein ≤ tolerancia por longitud).
    const maxDist = distanciaPermitida(primeraP);
    if (maxDist > 0) {
      const candidatos = COMANDOS_CONOCIDOS
        .filter(function(c){ return Math.abs(c.length - primeraP.length) <= 2; })
        .map(function(c){ return { cmd: c, d: levenshtein(primeraP, c) }; })
        .filter(function(x){ return x.d > 0 && x.d <= maxDist; })
        .sort(function(a,b){ return a.d - b.d; });

      if (candidatos.length) {
        const mejor = candidatos[0].cmd;
        // Reconstruir el mensaje con la palabra corregida
        const textoCorregido = mejor + (palabras1.length > 1 ? ' '+palabras1.slice(1).join(' ') : '');
        await enviar(chatId, '💡 <i>Interpretando como:</i> <code>'+esc(textoCorregido)+'</code>');
        // Re-llamar al router con el texto corregido (un solo nivel de recursión)
        await router(chatId, textoCorregido, nombre, env);
        return;
      }
    }
  }

  // Fallback final: inventario → AI si inventario no encuentra nada
  if (texto.length >= 2 && !texto.startsWith('/')) {
    // Intentar inventario primero
    const hayResultados = await cmdInventarioBuscando(chatId, texto);
    if (!hayResultados) {
      // ¿habla de algo que está en las pestañas? responder con datos reales
      if (await preguntarHojas(chatId, texto, env)) return;
      // Sin resultados en inventario → AI
      await preguntarGemini(chatId, texto, env);
    }
    return;
  }
  await enviar(chatId, '❓ No entendí. Escribe <b>ayuda</b>.');
}

// ============================================================
// INVENTARIO
// ============================================================

// ============================================================
// VENTIAPP — FALTA POCO (6-8 canales activos)
// ============================================================


// ============================================================
// VENTIAPP — URGENTE PUBLICAR (0 canales con stock significativo)
// ============================================================


// ============================================================
// VENTIAPP — CONCENTRADO (stock, precio, status por SKU)
// ============================================================


// ============================================================
// VENTIAPP — STOCK SIN CANAL
// ============================================================


// ============================================================
// VENTIAPP — MÁS STOCK VENTI QUE ODOO
// ============================================================


// ============================================================
// BODEGA — busca productos por ubicación en bodega
// ============================================================


// Versión silenciosa de inventario que devuelve true si encontró resultados
async function cmdInventarioBuscando(chatId, consulta) {
  const { termino, stockOp, stockVal } = parsearConsulta(consulta);

  // Si tiene filtros de stock explícitos → siempre es búsqueda de inventario
  if (stockOp) {
    await cmdInventario(chatId, consulta);
    return true;
  }

  const datos = await cargarInventario();
  if (!datos) return false;

  const tl = sinAcentos(termino);
  if (!tl || tl.length < 2) return false;

  const res = datos.slice(1).filter(function(r) {
    return [INV.REF, INV.CAT, INV.MARCA, INV.NOMBRE, INV.MODELO, INV.SKU].some(function(i) {
      const v = String(r[i]||'');
      return v !== '#N/A' && v !== 'NO ESTA' && contiene(v, tl);
    });
  });

  if (!res.length) return false; // no encontró nada → dejar pasar a AI

  // Sí encontró → mostrar resultados normales
  await cmdInventario(chatId, consulta);
  return true;
}

async function cmdInventario(chatId, consulta) {
  const { termino, stockOp, stockVal } = parsearConsulta(consulta);
  const terminos = splitTerminos(termino);

  // Si hay múltiples términos, ejecutar uno por uno
  if (terminos.length > 1) {
    for (const t of terminos) {
      const c = stockOp ? t + ' stock ' + (stockOp==='gt'?'mayor a':stockOp==='lt'?'menor a':'igual a') + ' ' + stockVal : t;
      await cmdInventario(chatId, c);
    }
    return;
  }
  const label = buildLabel(termino, stockOp, stockVal);
  await enviar(chatId, '🔍 Buscando <b>'+esc(label)+'</b>...');
  const datos = await cargarInventario();
  if (!datos) { await enviar(chatId,'❌ Sin acceso al inventario.'); return; }
  const tl = termino;
  let res = datos.slice(1).filter(function(r) {
    const d = num(r[INV.DISP]);
    if (!filtroStock(d, stockOp, stockVal)) return false;
    if (!tl) return true;
    return [INV.REF,INV.CAT,INV.MARCA,INV.NOMBRE,INV.MODELO,INV.SKU].some(function(i){
      const v=String(r[i]||'');
      return v!=='#N/A'&&v!=='NO ESTA'&&contiene(v, tl);
    });
  });
  console.log('Inv "'+consulta+'": '+res.length);
  if (!res.length) { await enviar(chatId,'😔 Sin resultados para <b>'+esc(label)+'</b>.'); return; }
  if (stockOp) res.sort(function(a,b){return num(b[INV.DISP])-num(a[INV.DISP]);});
  const top=res.slice(0, limCanal(chatId));
  let tg='📦 <b>'+esc(label)+'</b> — '+res.length+' resultado(s)\n━━━━━━━━━━━━━━━━━\n\n';
  let wa='📦 '+label+'\n'+res.length+' resultado(s)\n━━━━━━━━━━━━━━━━━\n\n';
  top.forEach(function(r,i){
    const d=num(r[INV.DISP]),ic=icon(d);
    const bodega = String(r[INV.BODEGA]||'').replace(/Almacén\/Existencias\//g,'').replace(/Almacen\/Existencias\//g,'').trim();
    tg+=(i+1)+'. <b>'+esc(r[INV.MARCA]||'-')+'</b> '+esc(r[INV.NOMBRE]||'-')+'\n'+
        '   📋 <code>'+esc(r[INV.REF]||'-')+'</code> | <code>'+esc(r[INV.SKU]||'-')+'</code>\n'+
        '   🎨 '+esc(r[INV.COLOR]||'-')+' | '+esc(r[INV.MODELO]||'-')+'\n'+
        (bodega?'   🏭 '+esc(bodega)+'\n':'')+
        '   '+ic+' Stock: <b>'+d.toLocaleString()+'</b>\n\n';
    wa+=(i+1)+'. '+(r[INV.MARCA]||'-')+' '+(r[INV.NOMBRE]||'-')+' | '+ic+' '+d.toLocaleString()+'\n';
  });
  if (res.length> limCanal(chatId)) tg+='...y '+(res.length- limCanal(chatId))+' más.';
  await enviar(chatId,tg); await wa_send(chatId,wa);
}

// ── Inventario (Sheet Site → hoja "Inventarios") ─────────────
// Encabezados actuales: REFERENCIA · CATEGORIA · MARCA · NOMBRE · MODELO ·
// COLOR · SKU · DISPONIBLE. Se leen por NOMBRE y se acomodan al layout que
// usan los comandos (INV): así mover columnas en el Sheet no rompe nada.
// DISPONIBLE = "Libre" de Inventario Actual (lo que se puede vender).
async function cargarInventario() {
  const datos = await csv(ID.SITE, 'Inventarios');
  const h = filaEncabezados(datos, ['SKU']);
  if (!h) return null;
  const c = {
    ref: colPor(h.fila, ['REFERENCIA','REF']), cat: colPor(h.fila, ['CATEGORIA']),
    marca: colPor(h.fila, ['MARCA']), nombre: colPor(h.fila, ['NOMBRE','PRODUCTO']),
    modelo: colPor(h.fila, ['MODELO']), color: colPor(h.fila, ['COLOR']),
    sku: colPor(h.fila, ['SKU']), disp: colPor(h.fila, ['DISPONIBLE','LIBRE','STOCK'])
  };
  const v = function(r, i) { return i === -1 ? '' : (r[i] == null ? '' : r[i]); };
  const out = [['REF','CAT','MARCA','NOMBRE','MODELO','COLOR','','','','DISP','SKU','BODEGA']];
  datos.slice(h.idx + 1).forEach(function(r) {
    const sku = String(v(r, c.sku)).trim();
    if (!sku) return;
    out.push([v(r,c.ref) || sku, v(r,c.cat), v(r,c.marca), v(r,c.nombre), v(r,c.modelo), v(r,c.color),
              '', '', '', v(r,c.disp), sku, '']);
  });
  return out;
}

async function stockBajo(chatId) {
  await enviar(chatId,'📊 Revisando stock...');
  const datos=await cargarInventario();
  if (!datos){await enviar(chatId,'❌ Sin acceso.');return;}
  const filas=datos.slice(1).filter(function(r){return String(r[0]||'').trim()&&r[0]!=='NO ESTA';});
  const sin=filas.filter(function(r){return num(r[INV.DISP])<=0;});
  const bajo=filas.filter(function(r){const d=num(r[INV.DISP]);return d>0&&d<=5;});
  if (!sin.length&&!bajo.length){await enviar(chatId,'✅ Todo el inventario con stock suficiente.');return;}
  let tg='⚠️ <b>ALERTA DE STOCK</b>\n━━━━━━━━━━━━━━━━━\n\n',wa='ALERTA DE STOCK\n\n';
  if (sin.length){
    tg+='🔴 <b>SIN STOCK ('+sin.length+'):</b>\n'; wa+='SIN STOCK ('+sin.length+'):\n';
    sin.slice(0,6).forEach(function(r){tg+='🔴 '+esc(r[INV.MARCA]||'-')+' '+esc(r[INV.NOMBRE]||'-')+'\n';wa+='🔴 '+(r[INV.MARCA]||'-')+' '+(r[INV.NOMBRE]||'-')+'\n';});
    if(sin.length>6)tg+='...y '+(sin.length-6)+' más\n';
    tg+='\n';wa+='\n';
  }
  if (bajo.length){
    tg+='🟡 <b>STOCK BAJO 1-5 ('+bajo.length+'):</b>\n'; wa+='STOCK BAJO 1-5 ('+bajo.length+'):\n';
    bajo.slice(0,8).forEach(function(r){const d=num(r[INV.DISP]);tg+='🟡 '+esc(r[INV.MARCA]||'-')+' '+esc(r[INV.NOMBRE]||'-')+' | '+d+' pzs\n';wa+='🟡 '+(r[INV.MARCA]||'-')+' | '+d+' pzs\n';});
    if(bajo.length>8)tg+='...y '+(bajo.length-8)+' más\n';
  }
  await enviar(chatId,tg);await wa_send(chatId,wa);
}

async function reporteInventario(chatId) {
  await enviar(chatId,'📊 Generando reporte...');
  const datos=await cargarInventario();
  if (!datos){await enviar(chatId,'❌ Sin acceso.');return;}
  const filas=datos.slice(1).filter(function(r){return String(r[0]||'').trim()&&r[0]!=='NO ESTA';});
  const total=filas.length,sin=filas.filter(function(r){return num(r[INV.DISP])<=0;}).length;
  const bajo=filas.filter(function(r){const d=num(r[INV.DISP]);return d>0&&d<=5;}).length;
  const ok=total-sin-bajo;
  const marcas=[...new Set(filas.map(function(r){return r[INV.MARCA];}).filter(Boolean))];
  const hora=new Date().toLocaleString('es-MX',{timeZone:'America/Mexico_City'});
  await enviar(chatId,'📊 <b>REPORTE DE INVENTARIO</b>\n📅 '+hora+'\n━━━━━━━━━━━━━━━━━\n\n'+
    '📦 Total: <b>'+total.toLocaleString()+'</b>\n'+
    '🟢 OK (&gt;5): <b>'+ok.toLocaleString()+'</b>\n'+
    '🟡 Bajo (1-5): <b>'+bajo.toLocaleString()+'</b>\n'+
    '🔴 Sin stock: <b>'+sin.toLocaleString()+'</b>\n\n'+
    '🏢 Marcas ('+marcas.length+'): '+marcas.slice(0,8).map(esc).join(', ')+(marcas.length>8?'...':''));
}

async function buscarSKU(chatId,sku){
  await enviar(chatId,'🔍 SKU <code>'+esc(sku)+'</code>...');
  const datos=await cargarInventario();
  if (!datos){await enviar(chatId,'❌ Sin acceso.');return;}
  const res=datos.slice(1).filter(function(r){return sinAcentos(r[INV.SKU])===sinAcentos(sku);});
  if (!res.length){await enviar(chatId,'😔 SKU no encontrado.');return;}
  const r=res[0],d=num(r[INV.DISP]),ic=icon(d);
  await enviar(chatId,'✅ <b>SKU Encontrado</b>\n\n'+
    '📋 Ref: <code>'+esc(r[INV.REF]||'-')+'</code>\n'+
    '🏷️ SKU: <code>'+esc(r[INV.SKU]||'-')+'</code>\n'+
    '🏢 <b>'+esc(r[INV.MARCA]||'-')+'</b>\n'+
    '📦 '+esc(r[INV.NOMBRE]||'-')+'\n'+
    '🔧 '+esc(r[INV.MODELO]||'-')+' | 🎨 '+esc(r[INV.COLOR]||'-')+'\n'+
    ic+' Stock: <b>'+d.toLocaleString()+'</b>');
}

// ============================================================
// VENTAS POR CANAL
// ============================================================

async function cmdVenta(chatId, consulta) {
  // Extraer fecha primero
  const {fechaISO, fechaISOFin, fechaLabel, resto: restoFecha} = extraerFecha(consulta);

  // Detectar todos los canales mencionados
  let restoLower = restoFecha.toLowerCase();
  const canalesEncontrados = [];
  const keys=Object.keys(CANALES).sort(function(a,b){return b.length-a.length;});
  for (const k of keys){
    if (restoLower.indexOf(k)!==-1){
      const hoja = CANALES[k];
      if (canalesEncontrados.indexOf(hoja)===-1) canalesEncontrados.push(hoja);
      restoLower=restoLower.replace(k,'').trim();
    }
  }

  if (!canalesEncontrados.length){
    const retirado = CANALES_RETIRADOS.find(function(k){ return new RegExp('\\b'+k+'\\b').test(sinAcentos(restoLower)); });
    if (retirado) {
      await enviar(chatId,'ℹ️ Venta Diaria ya solo lleva <b>Walmart</b> y <b>pedidos CVA</b>. '+
        'Las hojas de los demás canales se eliminaron del libro.\n\nEj: <code>venta walmart hoy</code> · <code>venta cva semana pasada</code>');
      return;
    }
    await enviar(chatId,'❓ Indica el canal: <b>walmart</b> o <b>cva</b>\n\nEj: <code>venta walmart 25/09/2026</code> · <code>venta cva hoy</code>');
    return;
  }

  // Ejecutar uno por uno si hay múltiples
  for (const hojaCanal of canalesEncontrados) {
    await enviar(chatId,'💰 <b>'+esc(hojaCanal)+'</b>'+(fechaLabel?' · <b>'+esc(fechaLabel)+'</b>':'')+'...');
    const datos=await csv(ID.VENTA_DIARIA, hojaCanal);
    if (!datos){await enviar(chatId,'❌ Sin acceso a "'+hojaCanal+'".');continue;}

    let filas=datos.slice(1).filter(function(r){
      return normalizarFecha(r[CANAL.FECHA]).length === 10;
    });
    if (fechaISO) filas=filas.filter(function(r){return coincideFecha(r[CANAL.FECHA], fechaISO, fechaISOFin);});
    const terminoExtra=restoLower.trim();
    if (terminoExtra){
      filas=filas.filter(function(r){return[CANAL.SKU,CANAL.PRODUCTO,CANAL.SO].some(function(i){return contiene(r[i], terminoExtra);});});
    }

    console.log('Ventas '+hojaCanal+': '+filas.length);
    if (!filas.length){await enviar(chatId,'😔 Sin ventas en <b>'+esc(hojaCanal)+'</b>'+(fechaLabel?' del '+fechaLabel:'')+'.');continue;}

    let totalCant=0,totalImp=0,totalOrdenes=new Set();
    filas.forEach(function(r){
      totalCant+=num(r[CANAL.CANTIDAD]);
      totalImp+=parseFloat(String(r[CANAL.IMPORTE]||'0').replace(/[$,]/g,''))||0;
      totalOrdenes.add(String(r[CANAL.SO]||''));
    });

    // Siempre mostrar resumen consolidado + top SKUs
    const porSKU = {};
    filas.forEach(function(r) {
      const sku  = String(r[CANAL.SKU]||'-');
      const prod = String(r[CANAL.PRODUCTO]||'-').replace(/^\[.+?\]\s*/,'');
      if (!porSKU[sku]) porSKU[sku] = { prod, cant:0, imp:0 };
      porSKU[sku].cant += num(r[CANAL.CANTIDAD]);
      porSKU[sku].imp  += parseFloat(String(r[CANAL.IMPORTE]||'0').replace(/[$,]/g,''))||0;
    });
    const topSKU = Object.entries(porSKU)
      .sort(function(a,b){ return b[1].cant - a[1].cant; })
      .slice(0, 10);

    let tg = '💰 <b>'+esc(hojaCanal)+'</b>'+(fechaLabel?' · '+esc(fechaLabel):'')+'\n'+
             '📦 '+filas.length+' líneas | '+totalOrdenes.size+' órdenes\n'+
             '🛒 Qty total: <b>'+totalCant.toLocaleString()+'</b>\n'+
             '💵 Importe: <b>$'+totalImp.toLocaleString('es-MX',{minimumFractionDigits:2})+'</b>\n'+
             '━━━━━━━━━━━━━━━━━\n'+
             '🔝 Top productos por cantidad:\n\n';

    topSKU.forEach(function(entry, i) {
      const [sku, d] = entry;
      const prod = d.prod.substring(0,45)+(d.prod.length>45?'...':'');
      tg += (i+1)+'. <b>'+esc(sku)+'</b>\n'+
            '   '+esc(prod)+'\n'+
            '   Qty: <b>'+d.cant.toLocaleString()+'</b> | $'+d.imp.toLocaleString('es-MX',{minimumFractionDigits:2})+'\n\n';
    });
    if (Object.keys(porSKU).length > 10) tg += '...y '+(Object.keys(porSKU).length-10)+' SKUs más.';
  await enviar(chatId, tg);
  }
}

// ============================================================
// KILLERS — para no reportar como "erróneo" un precio que fue killer
// ============================================================
// Venta Diaria alerta cuando el precio de venta queda bajo el mínimo, SALVO
// que ese SKU tuviera un killer a ESE precio en la fecha de la venta
// (killerQueAplica_ de su Alertas.gs / Killers.gs). Pero el "Histórico de
// alertas" no se limpia nunca: las alertas de los días en que el killer aún
// no estaba cargado se quedan ahí, y reportarlas tal cual es lo que hacía
// ver "precios erróneos" que no lo eran (1 al 5/oct/2026: 122 de 139 alertas
// vendieron justo al NEGOCIADO de un killer de octubre).
//
// Aquí cada alerta se vuelve a validar con la MISMA regla que Venta Diaria:
// SKU (o su base / variante / grupo de SKU ASIGNADOS) + precio negociado
// exacto (±0.01) + fecha dentro del rango del killer, con un día de colchón.
// Fuentes, leídas siempre por ENCABEZADO (nunca por letra):
//   · VENTA_DIARIA › KILLERS HISTORICO  SKU · SKU GENERAL · PRECIO NEGOCIADO · INICIO · FIN
//   · SITE › Killers                    SKU · SKU BASE · NEGOCIADO · INICIA · TERMINA
//   · VENTA_DIARIA › SKU ASIGNADOS      un grupo de SKUs por renglón

const DIA_MS = 86400000;
const SKU_VARIANTE_RE = /-(MSI(-[2-9])?|[2-9])$/;

// Igual que skuBase_ / skuSinVariante_ de Venta Diaria (Utils.gs).
function skuBaseVD(s) {
  let v = String(s || '').trim().toUpperCase();
  v = v.replace(/-OB$/, '').replace(SKU_VARIANTE_RE, '').replace(/-CVA$/, '').replace(SKU_VARIANTE_RE, '');
  return v;
}
function skuSinVarianteVD(s) {
  return String(s || '').trim().toUpperCase().replace(/-MSI-[2-9]$/, '-MSI').replace(/-[2-9]$/, '');
}

// "$2,879.00" · "2879" · 2879 → 2879
function montoNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// "1/10/2026 10:27:19" · "2026-10-01 18:00" · "1/9/2026" → ms (hora de pared,
// sin zona: las dos fechas que se comparan vienen de hojas en hora de México).
// Sin hora: el inicio cuenta desde 00:00 y el fin hasta 23:59:59 (finDia).
function fechaMs(v, finDia) {
  const s = String(v || '').trim();
  if (!s) return NaN;
  let y, mo, d, hh, mm, ss;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; hh = m[4]; mm = m[5]; ss = m[6]; }
  else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return NaN;
    d = +m[1]; mo = +m[2]; y = +m[3]; hh = m[4]; mm = m[5]; ss = m[6];
  }
  if (hh === undefined) return Date.UTC(y, mo - 1, d, finDia ? 23 : 0, finDia ? 59 : 0, finDia ? 59 : 0);
  return Date.UTC(y, mo - 1, d, +hh, +mm, +(ss || 0));
}

// Lee una hoja por encabezado. `cols` = { clave: [alias…] }, `ancla` = alias
// que identifica la fila de encabezados, `requeridas` = claves sin las que la
// hoja no sirve. Devuelve { filas, c, h } o { error }.
async function leerHojaPorEncabezado(sheetId, hoja, ancla, cols, requeridas) {
  const datos = await csv(sheetId, hoja);
  if (!datos) return { error: 'sin acceso a "' + hoja + '"' };
  const h = filaEncabezados(datos, ancla);
  if (!h) return { error: 'en "' + hoja + '" no encuentro la columna "' + [].concat(ancla)[0] + '"' };
  const c = {};
  Object.keys(cols).forEach(function (k) { c[k] = colPor(h.fila, cols[k]); });
  const faltan = (requeridas || []).filter(function (k) { return c[k] < 0; });
  if (faltan.length) {
    return { error: 'en "' + hoja + '" faltan las columnas: ' + faltan.map(function (k) { return cols[k][0]; }).join(', ') };
  }
  return { filas: datos.slice(h.idx + 1), c: c, h: h, datos: datos };
}

// Todos los killers conocidos, indexados por SKU / SKU general / SKU base.
// Devuelve { mapa, grupos, n, fuentes, fallos } o null si no se pudo leer
// ninguna fuente (en ese caso NO se filtra nada).
async function cargarKillers() {
  const mapa = {};
  const grupos = {};
  let n = 0, fuentes = 0;
  const fallos = [];

  const agrega = function (sku, general, precio, ini, fin) {
    sku = String(sku || '').trim().toUpperCase();
    if (!sku || !(precio > 0)) return;
    // KILLERS HISTORICO muestra INICIO solo como fecha (sin hora): ahí no hay
    // colchón al inicio; la hoja Killers del site trae la hora y sí lo lleva.
    const e = { precio: precio, ini: fechaMs(ini, false), fin: fechaMs(fin, true),
                iniSinHora: !/\d{1,2}:\d{2}/.test(String(ini || '')) };
    const llaves = new Set([sku, String(general || '').trim().toUpperCase(), skuBaseVD(sku)]);
    llaves.forEach(function (k) { if (k) (mapa[k] = mapa[k] || []).push(e); });
    n++;
  };

  const fuentesKillers = [
    { id: ID.VENTA_DIARIA, hoja: 'KILLERS HISTORICO', ancla: 'PRECIO NEGOCIADO',
      cols: { sku: ['SKU'], general: ['SKU GENERAL'], precio: ['PRECIO NEGOCIADO'], ini: ['INICIO'], fin: ['FIN'] } },
    { id: ID.SITE, hoja: 'Killers', ancla: 'NEGOCIADO',
      cols: { sku: ['SKU'], general: ['SKU BASE'], precio: ['NEGOCIADO'], ini: ['INICIA'], fin: ['TERMINA'] } }
  ];
  const lecturas = await Promise.all(fuentesKillers.map(function (f) {
    return leerHojaPorEncabezado(f.id, f.hoja, f.ancla, f.cols, ['sku', 'precio', 'ini', 'fin']);
  }));
  lecturas.forEach(function (r, i) {
    if (r.error) { fallos.push(r.error); console.error('killers: ' + r.error); return; }
    fuentes++;
    r.filas.forEach(function (f) {
      agrega(f[r.c.sku], r.c.general >= 0 ? f[r.c.general] : '', montoNum(f[r.c.precio]), f[r.c.ini], f[r.c.fin]);
    });
  });
  if (!fuentes) return null;

  // SKU ASIGNADOS: cada renglón es un grupo; vale el killer de cualquiera.
  try {
    const g = await csv(ID.VENTA_DIARIA, 'SKU ASIGNADOS');
    if (g && g.length > 1) {
      g.slice(1).forEach(function (fila) {
        const miembros = fila.map(function (x) { return String(x || '').trim().toUpperCase(); }).filter(Boolean);
        if (miembros.length < 2) return;
        miembros.forEach(function (x) {
          [x, skuBaseVD(x)].forEach(function (k) { grupos[k] = (grupos[k] || []).concat(miembros); });
        });
      });
    }
  } catch (e) { console.error('SKU ASIGNADOS: ' + e.message); }

  return { mapa: mapa, grupos: grupos, n: n, fuentes: fuentes, fallos: fallos };
}

// ¿Había un killer de este SKU a este precio en esa fecha? (killerQueAplica_)
function killerAplica(K, sku, precio, fechaTxt) {
  const s = String(sku || '').trim().toUpperCase();
  if (!s || !(precio > 0)) return null;
  const t = fechaMs(fechaTxt, false);
  const llaves = [s, skuSinVarianteVD(s), skuBaseVD(s)];
  (K.grupos[s] || K.grupos[skuBaseVD(s)] || []).forEach(function (x) { llaves.push(x, skuBaseVD(x)); });
  for (let i = 0; i < llaves.length; i++) {
    const lista = K.mapa[llaves[i]];
    if (!lista) continue;
    for (let j = 0; j < lista.length; j++) {
      const e = lista[j];
      if (Math.abs(e.precio - precio) > 0.01) continue;
      if (!isNaN(t)) {
        if (!isNaN(e.ini) && t < e.ini - (e.iniSinHora ? 0 : DIA_MS)) continue;
        if (!isNaN(e.fin) && t > e.fin + DIA_MS) continue;
      }
      return e;
    }
  }
  return null;
}

// ============================================================
// PRECIOS ERRÓNEOS — con filtro de fecha
// ============================================================
// Fuente: "Histórico de alertas" de Venta Diaria (ventas de Walmart que
// quedaron bajo el mínimo del site), columnas por encabezado. Se descartan
// las que vendieron al precio de un killer vigente (ver arriba).

async function cmdPreciosErroneos(chatId, consulta) {
  const {fechaISO, fechaISOFin, fechaLabel, resto} = extraerFecha(consulta);
  const terminos = splitTerminos(resto.trim());

  if (terminos.length > 1) {
    for (const t of terminos) {
      await cmdPreciosErroneos(chatId, t + (fechaLabel ? ' ' + fechaLabel : ''));
    }
    return;
  }

  const termino = terminos[0] || '';
  await enviar(chatId,'⚠️ Precios erróneos'+(fechaLabel?' · <b>'+esc(fechaLabel)+'</b>':'')+(termino?' "'+esc(termino)+'"':'')+'...');

  const [lec, K] = await Promise.all([
    leerHojaPorEncabezado(ID.VENTA_DIARIA, 'Histórico de alertas', 'DIFERENCIA', {
      FECHA: ['FECHA ALERTA', 'FECHA', 'VENTA DIARIA ODOO'], SO: ['SO', 'NUMERO SO'],
      CLIENTE: ['CLIENTE'], VENDEDOR: ['VENDEDOR'], SKU: ['SKU'], CANTIDAD: ['CANTIDAD'],
      VENTA: ['VENTA'], ERIK: ['ERIK'], DIFERENCIA: ['DIFERENCIA']
    }, ['FECHA', 'SKU', 'VENTA', 'ERIK', 'DIFERENCIA']),
    cargarKillers()
  ]);
  if (lec.error) {
    await enviar(chatId, lec.error.indexOf('sin acceso') === 0 ? '❌ Sin acceso.' : '❌ ' + esc(lec.error));
    return;
  }
  const c = lec.c;
  const g = function(r, k) { return c[k] >= 0 ? r[c[k]] : ''; };

  let filas = lec.filas.filter(function(r){
    const f = normalizarFecha(g(r,'FECHA'));
    return f.length === 10 && f.match(/^\d{4}-\d{2}-\d{2}$/);
  });

  // ── EXCLUSIONES ───────────────────────────────────────────
  // 1. SKU NIN-BR201CCO-NEG-2997: precio negociado para ganar Buy Box
  // 2. AMA-53034095-NEG-4699 en WALMART: idem
  // 3. Liverpool con centavos: descuentos legítimos (1ra compra, tarjeta Liverpool)
  filas = filas.filter(function(r) {
    const sku    = String(g(r,'SKU')||'').trim().toUpperCase();
    const venta  = montoNum(g(r,'VENTA'));
    const cliente= sinAcentos(String(g(r,'CLIENTE')||'').toLowerCase());
    if (sku === 'NIN-BR201CCO-NEG-2997') return false;
    if (sku === 'AMA-53034095-NEG-4699' && cliente.indexOf('walmart') !== -1) return false;
    const esLiverpool = cliente.indexOf('liv') !== -1;
    const tieneCentavos = Math.abs(venta - Math.round(venta)) > 0.001;
    if (esLiverpool && tieneCentavos) return false;
    return true;
  });

  if (fechaISO) filas=filas.filter(function(r){return coincideFecha(g(r,'FECHA'), fechaISO, fechaISOFin);});
  if (termino){
    const tl=termino;
    filas=filas.filter(function(r){return['SKU','CLIENTE','SO','VENDEDOR'].some(function(k){return contiene(g(r,k), tl);});});
  }

  // ── VALIDACIÓN CONTRA KILLERS ─────────────────────────────
  // Lo que vendió al precio de un killer vigente no es un precio erróneo.
  let descartadas = 0;
  if (K) {
    const antes = filas.length;
    filas = filas.filter(function(r){
      return !killerAplica(K, g(r,'SKU'), montoNum(g(r,'VENTA')), g(r,'FECHA'));
    });
    descartadas = antes - filas.length;
  }
  const notaKillers = K
    ? (descartadas ? 'ℹ️ Quité '+descartadas+' que vendieron al precio de un killer vigente.\n' : '') +
      (K.fallos.length ? '⚠️ Una fuente de killers no se pudo leer (' + esc(K.fallos[0]) + '): puede faltar alguno.\n' : '')
    : '⚠️ No pude leer los killers: salen TODAS las alertas, algunas pueden ser killers.\n';

  console.log('Precios erróneos "'+consulta+'": '+filas.length+' (killers quitados: '+descartadas+')');
  if (!filas.length){
    await enviar(chatId,'😔 Sin alertas de precios'+( fechaLabel||termino?' para los filtros indicados':'')+'.'+(notaKillers?'\n'+notaKillers.trim():''));
    return;
  }

  let totalDiff=0;
  filas.forEach(function(r){totalDiff+=montoNum(g(r,'DIFERENCIA'));});

  // Ordenar por fecha descendente (más reciente primero)
  filas.sort(function(a,b){ return normalizarFecha(g(b,'FECHA')).localeCompare(normalizarFecha(g(a,'FECHA'))); });
  const top=filas.slice(0, limCanal(chatId));
  let tg='⚠️ <b>Precios Erróneos</b>'+(fechaLabel?' · '+fechaLabel:'')+(termino?' · '+esc(termino):'')+'\n'+
         filas.length+' alertas | Diff total: <b>$'+totalDiff.toLocaleString('es-MX',{minimumFractionDigits:2})+'</b>\n'+
         notaKillers+'━━━━━━━━━━━━━━━━━\n\n';
  let wa='PRECIOS ERRÓNEOS'+(fechaLabel?' '+fechaLabel:'')+(termino?' - '+termino:'')+'\n'+filas.length+' alertas\n'+
         notaKillers.replace('ℹ️ ','').replace('⚠️ ','')+'\n';

  top.forEach(function(r,i){
    const fecha=normalizarFecha(g(r,'FECHA'));
    const diff=montoNum(g(r,'DIFERENCIA'));
    const so = String(g(r,'SO')||'').trim();
    tg+=(i+1)+'. <b>'+esc(g(r,'SKU')||'-')+'</b>'+(so?' · <code>'+esc(so)+'</code>':'')+'\n'+
        '   📅 '+esc(fecha)+' | 👤 '+esc(g(r,'CLIENTE')||'-')+'\n'+
        '   💵 Venta: '+String(g(r,'VENTA')||'-')+' | Erik: '+String(g(r,'ERIK')||'-')+' | <b>Diff: $'+Math.abs(diff).toFixed(2)+'</b>\n\n';
    wa+=(i+1)+'. '+(g(r,'SKU')||'-')+(so?' ['+so+']':'')+' | '+(g(r,'CLIENTE')||'-')+' | Diff:$'+Math.abs(diff).toFixed(2)+'\n';
  });
  if (filas.length> limCanal(chatId)) tg+='...y '+(filas.length- limCanal(chatId))+' más.';
  await enviar(chatId,tg);await wa_send(chatId,wa);
}

// ============================================================
// SOBREVENTA
// ============================================================
// Fuente: hojas "Sobreventa WFS" y "Sobreventa Pick" de Venta Diaria (foto de
// los pickings de Walmart sin surtir; se reescriben completas cada 30 min).
// Fila 1 = "Última actualización", fila 2 = encabezados. Todo por encabezado.

async function cmdSobreventa(chatId, consulta) {
  const {fechaISO, fechaISOFin, fechaLabel, resto} = extraerFecha(consulta);
  const terminos = splitTerminos(resto.trim());

  if (terminos.length > 1) {
    for (const t of terminos) {
      await cmdSobreventa(chatId, t + (fechaLabel ? ' ' + fechaLabel : ''));
    }
    return;
  }

  const termino = terminos[0] || '';
  await enviar(chatId,'🚨 Sobreventa'+(fechaLabel?' · <b>'+esc(fechaLabel)+'</b>':'')+(termino?' "'+esc(termino)+'"':'')+'...');

  const hojas = [{ hoja: 'Sobreventa WFS', tag: 'WFS' }, { hoja: 'Sobreventa Pick', tag: 'Pick' }];
  const cols = {
    REF: ['REFERENCIA'], CONTACTO: ['CONTACTO'], FECHA: ['FECHA PROGRAMADA'], DOC: ['DOCUMENTO ORIGEN'],
    ESTADO: ['ESTADO'], SKU: ['SKU'], NOMBRE: ['NOMBRE PRODUCTO'], QTY_DEM: ['QTY DEMANDADA'], QTY_REAL: ['QTY REALIZADA']
  };
  const lecturas = await Promise.all(hojas.map(function(h){
    return leerHojaPorEncabezado(ID.VENTA_DIARIA, h.hoja, 'QTY DEMANDADA', cols, ['REF', 'SKU', 'QTY_DEM', 'QTY_REAL']);
  }));
  if (lecturas.every(function(l){ return l.error; })) {
    const e = lecturas[0].error;
    await enviar(chatId, e.indexOf('sin acceso') === 0 ? '❌ Sin acceso.' : '❌ ' + esc(e));
    return;
  }

  let filas = [];
  let actualizada = '';
  lecturas.forEach(function(l, i){
    if (l.error) { console.error('sobreventa: ' + l.error); return; }
    const gg = function(r, k) { return l.c[k] >= 0 ? r[l.c[k]] : ''; };
    if (!actualizada && l.datos[0]) {
      const m = String(l.datos[0][0] || '').match(/actualizaci[oó]n:\s*(.+)$/i);
      if (m) actualizada = m[1].replace(/\s+Referencia\s*$/i, '').trim();
    }
    l.filas.forEach(function(r){
      const ref = String(gg(r,'REF') || '').trim();
      if (!ref) return;
      filas.push({ ref: ref, contacto: gg(r,'CONTACTO'), fecha: gg(r,'FECHA'), doc: gg(r,'DOC'),
                   estado: gg(r,'ESTADO'), sku: gg(r,'SKU'), nombre: gg(r,'NOMBRE'),
                   dem: montoNum(gg(r,'QTY_DEM')), real: montoNum(gg(r,'QTY_REAL')), tag: hojas[i].tag });
    });
  });

  if (fechaISO) filas=filas.filter(function(r){return coincideFecha(r.fecha, fechaISO, fechaISOFin);});
  if (termino){const tl=termino;filas=filas.filter(function(r){return[r.ref,r.contacto,r.doc,r.sku,r.nombre,r.estado].some(function(v){return contiene(v, tl);});});}
  if (!filas.length){await enviar(chatId,'😔 Sin sobreventas'+(fechaLabel||termino?' para los filtros indicados':'')+'.');return;}
  filas.sort(function(a,b){ return normalizarFecha(b.fecha).localeCompare(normalizarFecha(a.fecha)); });
  const top=filas.slice(0, limCanal(chatId));

  const nota = actualizada ? '🕒 Hoja al '+esc(actualizada)+'\n' : '';
  let tg='🚨 <b>Sobreventa</b>'+(fechaLabel?' · '+fechaLabel:'')+(termino?' · '+esc(termino):'')+'\n'+filas.length+' registros\n'+nota+'━━━━━━━━━━━━━━━━━\n\n';
  let wa='SOBREVENTA'+(fechaLabel?' '+fechaLabel:'')+(termino?' - '+termino:'')+'\n'+filas.length+' registros\n\n';
  top.forEach(function(r,i){
    const diff=r.real-r.dem;
    const doc=String(r.doc||'').trim();
    const sku=String(r.sku||'').trim();
    tg+=(i+1)+'. <b>'+esc(String(r.nombre||'-').replace(/^\[[^\]]+\]\s*/, ''))+'</b>\n'+
        (sku?'   🏷️ <code>'+esc(sku)+'</code>\n':'')+
        '   📋 '+esc(r.ref||'-')+' · '+r.tag+' | 👤 '+esc(r.contacto||'-')+'\n'+
        (doc?'   🗂️ Doc. origen: <code>'+esc(doc)+'</code>\n':'')+
        '   📦 Dem: '+r.dem+' | Real: '+r.real+(diff!==0?' | <b>Diff: '+diff+'</b>':'')+'\n'+
        '   '+esc(r.estado||'-')+'\n\n';
    wa+=(i+1)+'. '+String(r.nombre||'-').replace(/^\[[^\]]+\]\s*/, '')+' | '+(r.contacto||'-')+' | Dem:'+r.dem+' Real:'+r.real+'\n';
  });
  if (filas.length> limCanal(chatId)) tg+='...y '+(filas.length- limCanal(chatId))+' más.';
  await enviar(chatId,tg);await wa_send(chatId,wa);
}



// ============================================================
// CHECK CHOFERES — checadas del día por empleado
// ============================================================


// ============================================================
// KILLERS WALMART
// ============================================================

async function cmdKillers(chatId, termino) {
  // Fuente: Venta Diaria → "KILLERS ACTIVOS" (la regenera su script en cada
  // corrida). Trae killers VIGENTES, POR INICIAR y la promo de categoría.
  // H "Carga" es el precio que va al archivo de cambio de precios.
  await enviar(chatId, '🔪 Killers Walmart...');
  const datos = await csv(ID.VENTA_DIARIA, 'KILLERS ACTIVOS');
  const h = filaEncabezados(datos, ['SKU']);
  if (!h) { await enviar(chatId, '❌ Sin acceso a KILLERS ACTIVOS (Venta Diaria).'); return; }
  const c = {
    sku: colPor(h.fila,['SKU']), det: colPor(h.fila,['Detalles del articulo','DETALLES']),
    precio: colPor(h.fila,['PRECIO']), neg: colPor(h.fila,['Precio negociado']),
    cupon: colPor(h.fila,['Cupon de oferta','CUPON']), carga: colPor(h.fila,['Carga']),
    ini: colPor(h.fila,['Inicio de la oferta']), fin: colPor(h.fila,['Finalizacion de la oferta']),
    kam: colPor(h.fila,['KAM']), estado: colPor(h.fila,['ESTADO']), origen: colPor(h.fila,['ORIGEN'])
  };
  const val = function(r, i) { return i === -1 ? '' : String(r[i]==null?'':r[i]).trim(); };
  let filas = datos.slice(h.idx+1).filter(function(r){ return val(r, c.sku); });

  // Filtros: "killers por iniciar" / "killers vigentes" / término libre (SKU, nombre, KAM)
  // Los killers son solo de Walmart: "killers walmart" = todos
  let t = sinAcentos(String(termino||'').toLowerCase()).replace(/\b(walmart|wm)\b/g,' ').replace(/\s+/g,' ').trim();
  let estadoFiltro = null;
  if (/por\s+iniciar/.test(t)) { estadoFiltro = 'POR INICIAR'; t = t.replace(/por\s+iniciar/,'').trim(); }
  else if (/\bvigentes?\b/.test(t)) { estadoFiltro = 'VIGENTE'; t = t.replace(/\bvigentes?\b/,'').trim(); }
  if (estadoFiltro) filas = filas.filter(function(r){ return sinAcentos(val(r,c.estado)).toUpperCase().indexOf(estadoFiltro) !== -1; });
  if (t) filas = filas.filter(function(r){
    return contiene(val(r,c.sku), t) || contiene(val(r,c.det), t) || contiene(val(r,c.kam), t);
  });

  if (!filas.length) { await enviar(chatId, '😔 Sin killers'+(termino?' para "'+esc(termino)+'"':'')+'.'); return; }

  const cuenta = {};
  filas.forEach(function(r){ const e = val(r,c.estado) || 'SIN ESTADO'; cuenta[e] = (cuenta[e]||0)+1; });
  const top = filas.slice(0, limCanal(chatId));
  let tg = '🔪 <b>Killers Walmart</b>'+(termino?' · '+esc(termino):'')+'\n'+
           filas.length+' SKU(s) · '+Object.keys(cuenta).map(function(e){ return esc(e.toLowerCase())+' '+cuenta[e]; }).join(' · ')+
           '\n━━━━━━━━━━━━━━━━━\n\n';
  top.forEach(function(r, i) {
    const det = val(r,c.det); const nombre = det.split(' SKU :')[0].trim() || det.substring(0,60);
    const estado = val(r,c.estado);
    const icono = /POR INICIAR/i.test(estado) ? '⏳' : /VIGENTE/i.test(estado) ? '🟢' : '🏷️';
    tg += (i+1)+'. '+icono+' <b>'+esc(nombre.substring(0,70) || val(r,c.sku))+'</b>\n'+
          '   🔑 <code>'+esc(val(r,c.sku))+'</code>'+(val(r,c.kam)?' · '+esc(val(r,c.kam)):'')+'\n'+
          '   💰 Precio '+esc(val(r,c.precio)||'-')+' · Negociado <b>'+esc(val(r,c.neg)||'-')+'</b> · Cupón '+esc(val(r,c.cupon)||'-')+'\n'+
          '   📤 Carga: <b>'+esc(val(r,c.carga)||'-')+'</b>'+(val(r,c.fin)?' · vence '+esc(val(r,c.fin)):'')+'\n\n';
  });
  if (filas.length > top.length) tg += '...y '+(filas.length-top.length)+' más.\n';
  await enviar(chatId, tg);
}

// ============================================================
// RETARDOS POR QUINCENA — empleados que perdieron bono por retraso
// ============================================================


// ============================================================
// BONO DE PUNTUALIDAD
// ============================================================



// ============================================================
// BONOS — Consolidado: puntualidad + cumpleañeros
// Lee TURNOS_DEFAULT (cumpleaños) y las métricas diarias (puntualidad).
// ============================================================



// ============================================================
// REPORTE QUINCENAL DETALLADO POR EMPLEADO
// Replica getReporteQuincenalDetalle de Code.gs: muestra puntuales,
// tolerancia, retardos, sin bono, faltas, vacaciones, enfermedad,
// inhábiles, horas trabajadas, horas extra, excesos de comida y
// desayuno, y un detalle día por día de la quincena.
// ============================================================



// ============================================================
// CHECADOR — REPORTE GENERAL DE ASISTENCIA
// ============================================================


// ============================================================
// CHECADOR — ESTATUS DEL DÍA (faltas, retardos, puntual...)
// ============================================================


// ============================================================
// CHECADOR — ALERTAS
// ============================================================


// ============================================================
// CHECADOR — ASISTENCIA (MÉTRICAS_DIARIAS)
// ============================================================


// ============================================================
// CHECADOR — RESUMEN MENSUAL
// ============================================================


// ============================================================
// CHECADOR — VACACIONES
// ============================================================


// ============================================================
// CHECADOR — ENFERMEDADES
// ============================================================


// ============================================================
// CHECADOR — TURNOS Y HORARIOS
// ============================================================


// ============================================================
// BUSCAR POR NÚMERO SO EN TODOS LOS CANALES
// ============================================================

async function cmdVentaBuscarSO(chatId, termino) {
  const terminos = splitTerminos(termino);
  if (terminos.length > 1) {
    for (const t of terminos) await cmdVentaBuscarSO(chatId, t);
    return;
  }

  await enviar(chatId, '🔍 Buscando orden <b>'+esc(termino)+'</b> en todos los canales...');

  const tl = sinAcentos(termino);
  const resultados = [];

  // Buscar en paralelo en todas las hojas de canal
  await Promise.all(HOJAS_CANAL.map(async function(hojaCanal) {
    try {
      const datos = await csv(ID.VENTA_DIARIA, hojaCanal);
      if (!datos || datos.length < 2) return;

      const filas = datos.slice(1).filter(function(r) {
        // Buscar en columna SO [1] y también en SKU [6] y producto [7]
        return [CANAL.SO, CANAL.SKU, CANAL.PRODUCTO].some(function(i) {
          return sinAcentos(String(r[i]||'')).indexOf(tl) !== -1;
        });
      });

      filas.forEach(function(r) {
        resultados.push({ canal: hojaCanal, row: r });
      });
    } catch(e) {
      console.error('Error buscando en '+hojaCanal+': '+e.message);
    }
  }));

  console.log('Búsqueda SO "'+termino+'": '+resultados.length+' resultados');

  if (!resultados.length) {
    await enviar(chatId, '😔 No se encontró la orden <b>'+esc(termino)+'</b> en ningún canal.');
    return;
  }

  const top = resultados.slice(0, limCanal(chatId));
  let tg = '🧾 <b>Orden: '+esc(termino)+'</b>\n'+resultados.length+' resultado(s)\n━━━━━━━━━━━━━━━━━\n\n';

  top.forEach(function(item, i) {
    const r     = item.row;
    const fecha = normalizarFecha(r[CANAL.FECHA]);
    const prod  = String(r[CANAL.PRODUCTO]||'-').replace(/^\[.+?\]\s*/,'');
    const imp   = '$'+String(r[CANAL.IMPORTE]||'0').replace(/[$,\s]/g,'');
    const total = '$'+String(r[CANAL.TOTAL]||'0').replace(/[$,\s]/g,'');

    tg += (i+1)+'. 🏪 <b>'+esc(item.canal)+'</b>\n'+
          '   📋 SO: <code>'+esc(String(r[CANAL.SO]||'-'))+'</code>\n'+
          '   📅 '+esc(fecha)+' | '+esc(String(r[CANAL.ESTADO]||'-'))+'\n'+
          '   🏷️ <code>'+esc(r[CANAL.SKU]||'-')+'</code>\n'+
          '   '+esc(prod.substring(0,55))+(prod.length>55?'...':'')+'\n'+
          '   Qty: '+String(r[CANAL.CANTIDAD]||'-')+' | Importe: '+imp+' | Total: '+total+'\n\n';
  });

  if (resultados.length > limCanal(chatId)) tg += '...y '+(resultados.length- limCanal(chatId))+' más.';
  await enviar(chatId, tg);
}
// ============================================================
// TRASLADOS — busca en TODAS las hojas del Sheet
// "traslados pick28870"  → WH/PICK/28870
// "traslados pack30281"  → WH/PACK/30281
// "traslados out88304"   → WH/OUT/88304
// "traslados S24527"     → por SO
// "traslados rastreo 46726640000" → por guía
// ============================================================





// ============================================================
// PRECIOS — busca SKU en CONCENTRADO + MINIMO + MAXIMO
// "precio HP" / "precio 2061" / "precio HP walmart" / "precio maximo Canon"
// ============================================================

async function cmdPrecios(chatId, consulta) {
  // Fuente: Sheet Site. Seis hojas "Precios {EM|CVA} {Minimo|Normal|Maximo}"
  // con Walmart Clásica / Premium (CVA Mínimo trae además Tienda Nube) y la
  // hoja "Concentrado" con lo publicado hoy en Walmart y el killer vigente.
  // Los precios del site ya vienen finales (comisión, IVA, ISR): no se recalcula nada.
  let q = sinAcentos(String(consulta||'').toLowerCase());
  let banda = null;
  const mB = q.match(/\b(minimo|normal|maximo)\b/);
  if (mB) { banda = mB[1]; q = q.replace(mB[0], ' '); }
  let master = null;
  if (/\bcva\b/.test(q)) { master = 'CVA'; q = q.replace(/\bcva\b/, ' '); }
  if (/\b(em|electronics)\b/.test(q)) { master = 'EM'; q = q.replace(/\b(em|electronics)\b/, ' '); }
  q = q.replace(/\b(walmart|wm|en|de|del)\b/g, ' ').replace(/,/g,' ').replace(/\s+/g,' ').trim();

  if (!q) {
    await enviar(chatId,
      '🏷️ Indica SKU, nombre o últimos 4 dígitos:\n'+
      '<code>precio 3093</code> · <code>precio HP victus</code>\n'+
      '<code>precio 3093 minimo</code> — solo una banda\n'+
      '<code>precio 4997 cva</code> — solo el master CVA');
    return;
  }

  await enviar(chatId, '🏷️ Precio <b>'+esc(q)+'</b>'+(banda?' · '+banda:'')+(master?' · '+master:'')+'...');

  const masters = master ? [master] : ['EM','CVA'];
  const bandas  = banda ? [banda] : ['minimo','normal','maximo'];
  const etiqueta = { minimo:'Minimo', normal:'Normal', maximo:'Maximo' };
  const pedidos = [];
  masters.forEach(function(m){ bandas.forEach(function(b){ pedidos.push({ m:m, b:b }); }); });
  const [hojas, conc] = await Promise.all([
    Promise.all(pedidos.map(function(p){ return csv(ID.SITE, 'Precios '+p.m+' '+etiqueta[p.b]); })),
    csv(ID.SITE, 'Concentrado')
  ]);
  if (hojas.every(function(h){ return !h; })) { await enviar(chatId, '❌ Sin acceso a las hojas de precios del Sheet Site.'); return; }

  function money(v) {
    const n = parseFloat(String(v==null?'':v).replace(/[$,\s]/g,''));
    return isNaN(n) || n === 0 ? null : '$'+n.toLocaleString('es-MX',{maximumFractionDigits:2});
  }
  const coincide = function(sku, nombre) { return contiene(sku, q) || contiene(nombre, q); };

  // Juntar por SKU: { sku, nombre, master, stock, bandas: {minimo:{cl,pr,tn}, ...} }
  const porSku = {};
  hojas.forEach(function(d, i) {
    const h = filaEncabezados(d, ['SKU']); if (!h) return;
    const c = { sku: colPor(h.fila,['SKU']), nom: colPor(h.fila,['Producto','NOMBRE']),
                st: colPor(h.fila,['Stock Odoo']), cl: colPor(h.fila,['Walmart Clasica']),
                pr: colPor(h.fila,['Walmart Premium']), tn: colPor(h.fila,['Tienda Nube']) };
    d.slice(h.idx+1).forEach(function(r) {
      const sku = String(r[c.sku]||'').trim(); const nom = String(r[c.nom]||'').trim();
      if (!sku || !coincide(sku, nom)) return;
      const k = sku.toUpperCase();
      if (!porSku[k]) porSku[k] = { sku: sku, nombre: nom, master: pedidos[i].m, stock: r[c.st], bandas: {} };
      porSku[k].bandas[pedidos[i].b] = { cl: r[c.cl], pr: r[c.pr], tn: c.tn !== -1 ? r[c.tn] : null };
    });
  });

  // Concentrado: publicaciones de Walmart por SKU BASE
  const pub = {};
  const hc = filaEncabezados(conc, ['SKU BASE']);
  if (hc) {
    const c = { sku: colPor(hc.fila,['SKU']), base: colPor(hc.fila,['SKU BASE']), est: colPor(hc.fila,['ESTATUS']),
                pwm: colPor(hc.fila,['PRECIO WM']), kil: colPor(hc.fila,['KILLER']), cup: colPor(hc.fila,['CUPON']),
                vend: colPor(hc.fila,['VENDEMOS']) };
    conc.slice(hc.idx+1).forEach(function(r) {
      const base = String(r[c.base]||'').trim().toUpperCase(); if (!base) return;
      (pub[base] = pub[base] || []).push({ sku: String(r[c.sku]||''), est: String(r[c.est]||''), pwm: r[c.pwm],
                                           kil: String(r[c.kil]||''), cup: r[c.cup], vend: r[c.vend] });
    });
  }

  const lista = Object.keys(porSku).map(function(k){ return porSku[k]; });
  if (!lista.length) { await enviar(chatId, '😔 Sin precios para <b>'+esc(q)+'</b> en el Sheet Site.'); return; }

  const top = lista.slice(0, limCanal(chatId));
  let tg = '🏷️ <b>Precios · '+esc(q)+'</b>\n'+lista.length+' SKU(s) · <i>precios finales del site</i>\n━━━━━━━━━━━━━━━━━\n\n';
  top.forEach(function(p, i) {
    tg += (i+1)+'. <b>'+esc(p.nombre.substring(0,70))+'</b>\n';
    tg += '   🔑 <code>'+esc(p.sku)+'</code> · '+p.master+' · 📦 Stock Odoo: <b>'+num(p.stock).toLocaleString()+'</b>\n';
    ['minimo','normal','maximo'].forEach(function(b) {
      const x = p.bandas[b]; if (!x) return;
      const partes = [];
      if (money(x.cl)) partes.push('Clásica '+money(x.cl));
      if (money(x.pr)) partes.push('Premium '+money(x.pr));
      if (x.tn != null && money(x.tn)) partes.push('Tienda Nube '+money(x.tn));
      if (partes.length) tg += '   '+(b==='minimo'?'🔻':b==='normal'?'⏺️':'🔺')+' '+etiqueta[b]+': '+partes.join(' · ')+'\n';
    });
    (pub[p.sku.toUpperCase()] || []).forEach(function(w) {
      let l = '   🛒 WM <code>'+esc(w.sku)+'</code> '+esc(w.est||'-');
      if (money(w.pwm)) l += ' · publicado '+money(w.pwm);
      if (/^si/i.test(w.kil)) l += ' · 🔪 killer'+(money(w.cup)?' (cupón '+money(w.cup)+')':'');
      tg += l+'\n';
    });
    tg += '\n';
  });
  if (lista.length > top.length) tg += '...y '+(lista.length-top.length)+' más.';
  await enviar(chatId, tg);
}

// ============================================================
// ENTRADAS — FECHA[0], SKU[1], REFERENCIA ODOO[2], LLEGARON[3]
// "entradas" / "entradas hoy" / "entradas CAN-EOS" / "entradas 1859"
// ============================================================

// ============================================================
// MENÚ DE INTENTS CON BOTONES INLINE
// ============================================================







async function enviarConBotones(chatId, texto, keyboard) {
  // App web: acumular en buffer (los botones se renderizan como links en HTML)
  if (String(chatId).indexOf('web:') === 0) {
    if (!_webBuffer.has(chatId)) _webBuffer.set(chatId, []);
    // Convertir keyboard inline en lista de "comandos sugeridos" al pie del texto
    let extra = '';
    if (keyboard && keyboard.length) {
      extra = '\n\n<i>Opciones:</i>\n';
      keyboard.forEach(function(row){
        row.forEach(function(btn){
          const cmd = btn.callback_data || btn.text;
          extra += '• <code>'+esc(btn.text)+'</code>\n';
        });
      });
    }
    _webBuffer.get(chatId).push(texto + extra);
    return;
  }
  try {
    await fetch(TELEGRAM_API+'/sendMessage', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      })
    });
  } catch(e) { console.error('enviarConBotones:', e.message); }
}

// ============================================================
// AYUDA
// ============================================================

async function ayuda(chatId, nombre) {
  // El bot lee SOLO dos libros: Sheet Site y Venta Diaria Odoo 2026.
  await enviar(chatId,
    '👋 Hola <b>'+esc(nombre||'')+'</b>! Soy el bot de Electronics México 📊\n'+
    '<i>Comandos disponibles (datos de Sheet Site y Venta Diaria):</i>\n'+
    '━━━━━━━━━━━━━━━━━\n\n'+

    '<b>📦 INVENTARIO Y STOCK</b> <i>(Sheet Site)</i>\n'+
    '<code>Samsung</code> · <code>Canon laptop</code> — búsqueda libre por nombre\n'+
    '<code>stock</code> — inventario general\n'+
    '<code>stock mayor a 100</code> · <code>Samsung stock menor a 5</code>\n'+
    '<code>sku HP-15FD0113DX-PLA-3027</code> — SKU exacto\n\n'+

    '<b>💰 VENTAS</b> <i>(Venta Diaria: Walmart y pedidos CVA)</i>\n'+
    '<code>venta walmart</code> · <code>venta walmart hoy</code> · <code>venta walmart 25/09/2026</code>\n'+
    '<code>venta cva</code> · <code>venta cva semana pasada</code>\n'+
    '<code>venta walmart 01/09 - 25/09/2026</code> — rango de fechas\n'+
    '<code>venta 609107236567526</code> — busca la SO\n\n'+

    '<b>🏷️ PRECIOS</b> <i>(Sheet Site, precios finales)</i>\n'+
    '<code>precio HP</code> · <code>precio 2061</code> — por nombre o últimos 4 dígitos\n'+
    '<code>precio 2061 minimo</code> · <code>precio 4997 cva</code> — una banda o un master\n\n'+

    '<b>🔪 KILLERS WALMART</b> <i>(Venta Diaria · KILLERS ACTIVOS)</i>\n'+
    '<code>killers</code> — vigentes, por iniciar y promo de categoría\n'+
    '<code>killers por iniciar</code> · <code>killers vigentes</code> · <code>killer Samsung</code>\n\n'+

    '<b>⚠️ PRECIOS ERRÓNEOS</b> <i>(Venta Diaria · Histórico de alertas)</i>\n'+
    '<code>precios erroneos</code> · <code>precios erroneos hoy</code>\n'+
    '<code>precios erroneos Samsung 25/03/2026</code> — SKU + fecha\n\n'+

    '<b>🚨 SOBREVENTA</b> <i>(Venta Diaria · Sobreventa WFS y Pick)</i>\n'+
    '<code>sobreventa</code> · <code>sobreventa hoy</code> · <code>sobreventa SONY</code>\n\n'+

    '<b>📚 CUALQUIER PESTAÑA</b> <i>(los dos libros)</i>\n'+
    '<code>hojas</code> — lista de pestañas consultables\n'+
    '<code>hoja killers activos vigente</code> — filas de una pestaña con filtro\n'+
    '<code>buscar 3027</code> — busca en las pestañas principales\n'+
    '<code>cuántos killers vigentes hay?</code> — pregunta en español, responde con datos reales\n\n'+

    '━━━━━━━━━━━━━━━━━\n'+
    '💡 <b>Reglas generales:</b>\n'+
    '• <b>hoy</b>, <b>ayer</b>, <b>dd/mm/yyyy</b> funcionan en ventas, errores y sobreventa\n'+
    '• <b>esta semana</b>, <b>mes pasado</b> también\n'+
    '• <b>dd/mm/yyyy - dd/mm/yyyy</b> para rangos de fechas\n'+
    '• Sin acentos ni mayúsculas obligatorios · comas para varios términos'
  );
}


// ============================================================
// PREGUNTAS SOBRE LAS DOS HOJAS (Sheet Site + Venta Diaria)
// ============================================================
// El bot puede consultar CUALQUIER pestaña útil de los dos libros:
//   hojas                      → lista de pestañas
//   hoja <pestaña> [filtro]    → filas de esa pestaña (todas las palabras del filtro deben aparecer)
//   buscar <texto>             → busca el texto en las pestañas principales
//   preguntas en español       → "cuántos killers vigentes hay?" (elige pestaña, trae los
//                                datos reales y la IA responde SOLO con ellos)
// No se exponen: Log, Índice, Guía, KAMS (correos), Correo, Envios killers, _Marcas, _Colores.

const LIBROS_BOT = {
  SITE: { nombre: 'Sheet Site',    alias: ['site', 'sheet site'] },
  VD:   { nombre: 'Venta Diaria',  alias: ['vd', 'venta diaria', 'ventadiaria'] }
};
function idLibro_(k) { return k === 'SITE' ? ID.SITE : ID.VENTA_DIARIA; }

// [libro, pestaña, palabras clave (nombre + contenido) para elegirla al preguntar]
const HOJAS_BOT = [
  ['SITE', 'Killers bajo minimo', 'killers bajo minimo perdida falta cupon kam departamento'],
  ['SITE', 'Killers', 'killers negociado comision msi por vencer solo wfs vencen'],
  ['SITE', 'Promociones', 'promociones promo comision clasica premium minimo estado grupo puntos descuento'],
  ['SITE', 'Comisiones', 'comisiones comision normal categoria walmart promo aplica'],
  ['SITE', 'CVA Catalogo', 'cva catalogo clave marca grupo stock cedis sucursal transito garantia moneda'],
  ['SITE', 'Walmart', 'walmart publicaciones upc gtin estatus wfs inventario normal'],
  ['SITE', 'Bloqueados', 'bloqueados bloqueado walmart'],
  ['SITE', 'Walmart EDI', 'edi walmart item asignado stock odoo precio motivo sin precio fuente'],
  ['SITE', 'Cruce EDI', 'cruce edi diagnostico accion sugerida decision asignado'],
  ['SITE', 'Concentrado', 'concentrado publicado estatus minimo normal maximo killer cupon vendemos mkp disponible odoo'],
  ['SITE', 'Variantes', 'variantes familia hermanos canal rol alerta precio hoy principal asignacion'],
  ['SITE', 'Oportunidades', 'oportunidades valor parado publicaciones vivas caidas unpublished system problem accion situacion'],
  ['SITE', 'Cambio Walmart', 'cambio walmart precio final tachado factor manual calculado inicio fin carga'],
  ['SITE', 'Precios EM Minimo', 'precios em electronics minimo precio walmart clasica premium envio peso'],
  ['SITE', 'Precios EM Normal', 'precios em electronics normal precio walmart clasica premium envio peso'],
  ['SITE', 'Precios EM Maximo', 'precios em electronics maximo precio walmart clasica premium envio peso'],
  ['SITE', 'Precios CVA Minimo', 'precios cva minimo precio walmart clasica premium tienda nube'],
  ['SITE', 'Precios CVA Normal', 'precios cva normal precio walmart clasica premium'],
  ['SITE', 'Precios CVA Maximo', 'precios cva maximo precio walmart clasica premium'],
  ['SITE', 'Inventario Actual', 'inventario actual libre existencia reservado transito'],
  ['SITE', 'Inventario Negativo', 'inventario negativo serie ubicacion almacen cantidad'],
  ['SITE', 'Inventarios', 'inventarios stock disponible referencia marca modelo color existencias'],
  ['SITE', 'Catalogo', 'catalogo sku referencia nombre categoria'],
  ['VD', 'KILLERS ACTIVOS', 'killers activos vigentes por iniciar estado kam carga cupon negociado origen'],
  ['VD', 'KILLERS BAJO MINIMO', 'killers bajo minimo perdida falta cupon kam departamento'],
  ['VD', 'KILLERS FUERA', 'killers fuera motivo bloqueado walmart minimo aplicable perdida'],
  ['VD', 'PRECIO LIBRE', 'precio libre sku motivo hasta vende mas barato'],
  ['VD', 'KILLERS EXCLUIDOS', 'killers excluidos sku motivo hasta'],
  ['VD', 'COMPARAR WALMART', 'comparar walmart decision dejar cambiar minimo aplicable carga diferencia estado stock'],
  ['VD', 'CARGA KILLERS', 'carga killers reduccion puntos categoria'],
  ['VD', 'COMISIONES', 'comisiones categoria comision otros nombres promo marcas'],
  ['VD', 'KILLERS HISTORICO', 'killers historico carga septiembre octubre registrado recibimos negociado'],
  ['VD', 'WALMART', 'ventas venta walmart pedidos ordenes so vendedor importe'],
  ['VD', 'PEDIDOS CVA', 'ventas venta pedidos cva ordenes so vendedor importe'],
  ['VD', 'Histórico de alertas', 'historico alertas precios erroneos diferencia erik venta'],
  ['VD', 'SKU ASIGNADOS', 'sku asignados principal grupo equivalentes'],
  ['VD', 'Sobreventa WFS', 'sobreventa wfs referencia documento origen qty demandada realizada'],
  ['VD', 'Sobreventa Pick', 'sobreventa pick referencia documento origen qty demandada realizada'],
  ['VD', 'PRECIOS ERIK', 'precios erik walmart clasica premium killers sin -2'],
  ['VD', 'EXPORTAR', 'exportar precio final carga archivo walmart'],
  ['VD', 'MINIMO', 'minimo precio minimo sku walmart'],
  ['VD', 'MAXIMO', 'maximo precio maximo sku walmart'],
  ['VD', 'PRECIOS VARIACIONES', 'precios variaciones sku']
];
// Pestañas que 'buscar' recorre (acotado para no pasar el límite de subrequests).
const BUSCAR_EN = [['SITE','Concentrado'],['SITE','Variantes'],['SITE','Inventarios'],['SITE','Walmart EDI'],['SITE','Killers'],
                   ['VD','KILLERS ACTIVOS'],['VD','KILLERS HISTORICO'],['VD','PRECIOS ERIK']];

const STOP_ = new Set(['cuantos','cuantas','cuanto','cual','cuales','que','quien','quienes','como','donde','cuando','hay','tiene','tienen',
  'los','las','del','por','para','con','una','uno','unos','unas','dame','muestrame','lista','listame','dime','todos','todas','esta','este',
  'estan','son','sus','mas','menos','sin','entre','desde','hasta','sobre','hoy','tengo','tenemos','favor','pon','ver','dar','nos','les','ese',
  'esa','esos','esas','alguno','algunos','hacer','hizo','sido','fue','ser','muy','pero','tambien','solo','todo','nada','cada','otro','otra']);

function palabrasClave_(texto) {
  return normEnc(texto).split(' ').filter(function (w) { return w.length >= 3 && !STOP_.has(w); });
}
function raiz_(w) { return w.length > 5 ? w.replace(/(es|s)$/, '') : w; }

function tabsPorNombre_(norm) {
  return HOJAS_BOT.filter(function (h) { return norm.indexOf(normEnc(h[1])) !== -1; });
}
// Puntúa cada pestaña contra las palabras de la pregunta.
function mejoresTabs_(pregunta, max) {
  const pal = palabrasClave_(pregunta);
  if (!pal.length) return [];
  const norm = normEnc(pregunta);
  const puntos = HOJAS_BOT.map(function (h) {
    const claves = normEnc(h[1] + ' ' + h[2]).split(' ');
    let p = 0;
    pal.forEach(function (w) {
      const r = raiz_(w);
      if (claves.some(function (c) { return c === w || (r.length >= 4 && c.indexOf(r) === 0); })) p += 1;
    });
    if (norm.indexOf(normEnc(h[1])) !== -1) p += (h[1].indexOf(' ') !== -1 ? 4 : 1);          // dijo el nombre de la pestaña
    if (/\bvd\b|venta diaria/.test(norm) && h[0] === 'VD') p += 1;
    if (/\bsite\b/.test(norm) && h[0] === 'SITE') p += 1;
    return { h: h, p: p };
  }).filter(function (x) { return x.p > 0; });
  puntos.sort(function (a, b) { return b.p - a.p; });
  if (!puntos.length) return [];
  const mejor = puntos[0].p;
  return puntos.filter(function (x) { return x.p >= Math.max(2, mejor - 1); }).slice(0, max || 2).map(function (x) { return x.h; });
}

function filaEnc_(datos) {
  for (let i = 0; i < Math.min(5, datos.length); i++) {
    if (datos[i].filter(function (c) { return String(c || '').trim(); }).length >= 3) return i;
  }
  return 0;
}
function filaTexto_(h, r, max) {
  const partes = [];
  for (let i = 0; i < h.length && partes.length < (max || 12); i++) {
    const v = String(r[i] == null ? '' : r[i]).trim();
    if (!v || !String(h[i] || '').trim()) continue;
    partes.push(String(h[i]).trim() + ': ' + (v.length > 45 ? v.slice(0, 45) + '…' : v));
  }
  return partes.join(' · ');
}
// Para columnas con pocos valores distintos (ESTADO, KAM…): "ESTADO: VIGENTE 120, POR INICIAR 19"
function conteosColumnas_(h, filas) {
  if (filas.length < 4) return '';
  const out = [];
  for (let c = 0; c < h.length && out.length < 4; c++) {
    const nombre = String(h[c] || '').trim(); if (!nombre) continue;
    const cuenta = {}; let n = 0, distintos = 0;
    for (let i = 0; i < filas.length; i++) {
      const v = String(filas[i][c] == null ? '' : filas[i][c]).trim(); if (!v) continue;
      n++; if (!(v in cuenta)) { cuenta[v] = 0; distintos++; if (distintos > 8) break; }
      cuenta[v]++;
    }
    if (distintos < 1 || distintos > 8 || n < filas.length * 0.5) continue;
    if (distintos === 1 && n === filas.length && !/estado|situacion|tipo|decision|kam|estatus/i.test(nombre)) continue;
    out.push(nombre + ': ' + Object.keys(cuenta).map(function (k) { return k + ' ' + cuenta[k]; }).join(', '));
  }
  return out.join(' | ');
}
function coincideFila_(r, pal) {
  const t = normEnc(r.join(' '));
  return pal.every(function (w) { return t.indexOf(raiz_(w)) !== -1; });
}
async function cargarTab_(libro, pestana) {
  const datos = await csv(idLibro_(libro), pestana);
  if (!datos) return null;
  const i = filaEnc_(datos);
  return { enc: datos[i], filas: datos.slice(i + 1).filter(function (r) { return r.some(function (c) { return String(c || '').trim(); }); }) };
}

async function cmdHojas(chatId) {
  let tg = '📚 <b>Pestañas que puedo consultar</b>\n<i>hoja &lt;nombre&gt; [filtro]</i> · <i>buscar &lt;texto&gt;</i> · o pregúntame en español\n━━━━━━━━━━━━━━━━━\n';
  ['SITE', 'VD'].forEach(function (k) {
    tg += '\n<b>' + LIBROS_BOT[k].nombre + '</b>\n';
    tg += HOJAS_BOT.filter(function (h) { return h[0] === k; }).map(function (h) { return '<code>' + esc(h[1]) + '</code>'; }).join(' · ') + '\n';
  });
  tg += '\n<i>Ej:</i> <code>hoja killers activos vigente</code> · <code>hoja site oportunidades</code> · <code>buscar 3027</code>';
  await enviar(chatId, tg);
}

async function cmdHoja(chatId, consulta) {
  let norm = normEnc(consulta);
  let libro = null;
  if (/\b(vd|venta diaria|ventadiaria)\b/.test(norm)) { libro = 'VD'; norm = norm.replace(/\b(vd|venta diaria|ventadiaria)\b/, ' '); }
  else if (/\b(site|sheet site)\b/.test(norm)) { libro = 'SITE'; norm = norm.replace(/\b(sheet site|site)\b/, ' '); }
  norm = norm.replace(/\s+/g, ' ').trim();
  if (!norm) { await cmdHojas(chatId); return; }

  let cand = tabsPorNombre_(norm);
  if (libro) cand = cand.filter(function (h) { return h[0] === libro; });
  if (!cand.length) {
    cand = mejoresTabs_(norm, 1);                                   // por palabras clave
    if (libro) cand = cand.filter(function (h) { return h[0] === libro; });
  }
  if (!cand.length) { await enviar(chatId, '😔 No encontré esa pestaña. Escribe <code>hojas</code> para ver la lista.'); return; }
  const largo = Math.max.apply(null, cand.map(function (h) { return h[1].length; }));
  cand = cand.filter(function (h) { return h[1].length === largo; });
  if (cand.length > 1) {
    await enviar(chatId, '🤔 Hay más de una con ese nombre: ' +
      cand.map(function (h) { return '<code>hoja ' + (h[0] === 'SITE' ? 'site' : 'vd') + ' ' + esc(h[1].toLowerCase()) + '</code>'; }).join(' · '));
    return;
  }
  const h = cand[0];
  const filtro = palabrasClave_(norm.replace(normEnc(h[1]), ' '));
  await enviar(chatId, '📄 <b>' + esc(h[1]) + '</b> · ' + LIBROS_BOT[h[0]].nombre + (filtro.length ? ' · filtro: ' + esc(filtro.join(' ')) : '') + '...');
  const t = await cargarTab_(h[0], h[1]);
  if (!t) { await enviar(chatId, '❌ Sin acceso a esa pestaña.'); return; }
  const res = filtro.length ? t.filas.filter(function (r) { return coincideFila_(r, filtro); }) : t.filas;
  if (!res.length) { await enviar(chatId, '😔 Sin filas con "' + esc(filtro.join(' ')) + '" en ' + esc(h[1]) + ' (' + t.filas.length + ' filas en total).'); return; }
  const lim = esWeb(chatId) ? 50 : Math.min(MAX_RES, 12);
  let tg = '📄 <b>' + esc(h[1]) + '</b> · ' + res.length + ' fila(s)' + (filtro.length ? ' de ' + t.filas.length : '') + '\n';
  const cnt = conteosColumnas_(t.enc, res);
  if (cnt) tg += '📊 <i>' + esc(cnt) + '</i>\n';
  tg += '━━━━━━━━━━━━━━━━━\n\n';
  res.slice(0, lim).forEach(function (r, i) { tg += (i + 1) + '. ' + esc(filaTexto_(t.enc, r, 10)) + '\n\n'; });
  if (res.length > lim) tg += '...y ' + (res.length - lim) + ' más. Agrega palabras al filtro para acotar.';
  await enviar(chatId, tg);
}

async function cmdBuscar(chatId, texto) {
  const pal = palabrasClave_(texto);
  const crudo = String(texto || '').trim();
  const buscado = pal.length ? pal : (crudo.length >= 2 ? [normEnc(crudo)] : []);
  if (!buscado.length) { await enviar(chatId, '🔎 Escribe qué buscar: <code>buscar 3027</code> · <code>buscar samsung</code>'); return; }
  await enviar(chatId, '🔎 Buscando <b>' + esc(buscado.join(' ')) + '</b> en las pestañas principales...');
  const lecturas = await Promise.all(BUSCAR_EN.map(function (b) { return cargarTab_(b[0], b[1]).catch(function () { return null; }); }));
  let tg = '', total = 0;
  lecturas.forEach(function (t, i) {
    if (!t) return;
    const res = t.filas.filter(function (r) { return coincideFila_(r, buscado); });
    if (!res.length) return;
    total += res.length;
    tg += '\n📄 <b>' + esc(BUSCAR_EN[i][1]) + '</b> (' + LIBROS_BOT[BUSCAR_EN[i][0]].nombre + ') · ' + res.length + '\n';
    res.slice(0, esWeb(chatId) ? 5 : 3).forEach(function (r) { tg += '• ' + esc(filaTexto_(t.enc, r, 8)) + '\n'; });
  });
  if (!total) { await enviar(chatId, '😔 No encontré "' + esc(buscado.join(' ')) + '". Prueba <code>hoja &lt;pestaña&gt; ' + esc(buscado[0]) + '</code> para otras pestañas.'); return; }
  await enviar(chatId, '🔎 <b>' + esc(buscado.join(' ')) + '</b> · ' + total + ' coincidencia(s)\n━━━━━━━━━━━━━━━━━' + tg);
}

function esPregunta_(texto) {
  const t = normEnc(texto);
  if (t.length < 12) return false;
  return /[?¿]/.test(texto) ||
    /^(cuantos|cuantas|cuanto|cual|cuales|que|quien|quienes|como|donde|cuando|por que|dime|dame|muestrame|listame|lista|hay|tengo|tenemos|en que|a que)\b/.test(t);
}

// Devuelve true si respondió. Elige pestaña(s) por las palabras de la pregunta,
// trae los datos REALES y le pide a la IA que conteste solo con ellos.
async function preguntarHojas(chatId, pregunta, env) {
  const tabs = mejoresTabs_(pregunta, 2);
  if (!tabs.length) return false;
  const pal = palabrasClave_(pregunta);
  const lecturas = await Promise.all(tabs.map(function (h) { return cargarTab_(h[0], h[1]).catch(function () { return null; }); }));
  const ok = lecturas.map(function (t, i) { return t ? { h: tabs[i], t: t } : null; }).filter(Boolean);
  if (!ok.length) { await enviar(chatId, '❌ Sin acceso a ' + esc(tabs.map(function (h) { return h[1]; }).join(' / ')) + '.'); return true; }

  let contexto = '', fuentes = [];
  ok.forEach(function (x) {
    const claves = normEnc(x.h[1] + ' ' + x.h[2]).split(' ');
    const filtro = pal.filter(function (w) { const r = raiz_(w); return !claves.some(function (c) { return c === w || (r.length >= 4 && c.indexOf(r) === 0); }); });
    let sel = filtro.length ? x.t.filas.filter(function (r) { return coincideFila_(r, filtro); }) : x.t.filas;
    let nota = filtro.length ? 'filas que contienen "' + filtro.join(' ') + '"' : 'todas las filas';
    if (filtro.length && !sel.length) { sel = x.t.filas; nota = 'SIN coincidencias con "' + filtro.join(' ') + '"; se muestran filas generales'; }
    const cnt = conteosColumnas_(x.t.enc, sel);
    contexto += '### ' + LIBROS_BOT[x.h[0]].nombre + ' › ' + x.h[1] + '\n' +
      'Filas en la pestaña: ' + x.t.filas.length + ' · Filas seleccionadas: ' + sel.length + ' (' + nota + ')\n' +
      (cnt ? 'Conteos de las seleccionadas -> ' + cnt + '\n' : '') +
      'Primeras filas:\n' + sel.slice(0, 25).map(function (r, i) { return (i + 1) + ') ' + filaTexto_(x.t.enc, r, 12); }).join('\n') + '\n\n';
    fuentes.push(x.h[1] + ' (' + x.t.filas.length + ' filas)');
  });
  if (contexto.length > 7000) contexto = contexto.slice(0, 7000) + '\n[…recortado]';

  const pie = '\n\n<i>Fuente: ' + esc(fuentes.join(' + ')) + '</i>';
  if (!env || !env.AI) {
    await enviar(chatId, '📄 Estas son las pestañas que corresponden (sin IA disponible): ' + esc(fuentes.join(', ')) + '. Usa <code>hoja ' + esc(tabs[0][1].toLowerCase()) + '</code> para ver filas.');
    return true;
  }
  try {
    await enviar(chatId, '🔎 Revisando ' + esc(fuentes.join(' + ')) + '...');
    const r = await env.AI.run(CF_AI_MODEL, {
      messages: [
        { role: 'system', content:
          'Eres analista de datos de Electronics México. Responde en español, corto y directo, SOLO con los datos que te doy. ' +
          'Si los datos no alcanzan para responder, dilo y sugiere el comando "hoja <pestaña> <filtro>". ' +
          'Usa los conteos exactos cuando existan; no inventes cifras ni SKUs; si solo ves las primeras filas, aclara que es una muestra.' },
        { role: 'user', content: 'Pregunta: ' + pregunta + '\n\nDatos:\n' + contexto }
      ],
      max_tokens: 500
    });
    const txt = String((r && r.response) || '').trim();
    if (!txt) return false;
    await enviar(chatId, '🤖 ' + esc(txt) + pie);
    return true;
  } catch (e) {
    console.error('preguntarHojas: ' + e.message);
    await enviar(chatId, '😔 No pude armar la respuesta. Usa <code>hoja ' + esc(tabs[0][1].toLowerCase()) + ' &lt;filtro&gt;</code>.');
    return true;
  }
}

// ============================================================
// CLOUDFLARE AI — respuesta IA para preguntas no cubiertas
// Incluido gratis en Cloudflare Workers — sin API key externa
// ============================================================

// ============================================================
// CLOUDFLARE AI — con memoria de conversación
// ============================================================

function obtenerHistorial(chatId) {
  const conv = conversaciones[chatId];
  if (!conv) return [];
  // Limpiar si expiró
  if (Date.now() - conv.ts > CONV_TTL) {
    delete conversaciones[chatId];
    return [];
  }
  return conv.mensajes;
}

function guardarMensaje(chatId, role, content) {
  if (!conversaciones[chatId]) {
    conversaciones[chatId] = { ts: Date.now(), mensajes: [] };
  }
  conversaciones[chatId].ts = Date.now(); // resetear TTL
  conversaciones[chatId].mensajes.push({ role, content });
  // Mantener solo los últimos N mensajes
  if (conversaciones[chatId].mensajes.length > CONV_MAX_MSG) {
    conversaciones[chatId].mensajes = conversaciones[chatId].mensajes.slice(-CONV_MAX_MSG);
  }
}

function limpiarHistorial(chatId) {
  delete conversaciones[chatId];
}

async function preguntarGemini(chatId, pregunta, env) {
  if (!env || !env.AI) return;

  try {
    await enviar(chatId, '🤖 Un momento...');

    // Recuperar historial de la conversación
    const historial = obtenerHistorial(chatId);

    const messages = [
      {
        role: 'system',
        content:
          'Eres el asistente interno de Electronics México, una empresa de electrónica en México. '+
          'Responde siempre en español mexicano · de forma concisa y amigable · máximo 3 párrafos. '+
          'Mantén el hilo de la conversación — recuerda lo que se habló antes en este chat. '+
          'Para matemáticas · ciencias · cultura general · emociones y preguntas generales responde directamente.'
      },
      ...historial,
      { role: 'user', content: pregunta }
    ];

    const respuesta = await env.AI.run(CF_AI_MODEL, {
      messages,
      max_tokens: 400
    });

    const texto = respuesta?.response || '';
    if (texto.trim()) {
      // Guardar pregunta y respuesta en el historial
      guardarMensaje(chatId, 'user', pregunta);
      guardarMensaje(chatId, 'assistant', texto.trim());
      await enviar(chatId, '🤖 '+texto.trim());
    }

  } catch(e) {
    console.error('CF AI:', e.message);
  }
}

// ============================================================
// HELPERS
// ============================================================

// Lee una hoja como CSV (endpoint gviz de Google Sheets).
//
// Con GOOGLE_SA_JSON configurado, la petición va firmada con la cuenta de
// servicio: así se leen libros PRIVADOS (solo hay que compartirlos con el
// correo de la cuenta de servicio como Lector). Sin ese secreto, solo se
// pueden leer libros con "cualquiera con el enlace".
//
// Cache por request: varios comandos piden la misma hoja en paralelo
// (TURNOS_DEFAULT, METRICAS…). _csvCache evita bajarla N veces.
const _csvCache = new Map();
async function csv(sheetId, sheetName) {
  const clave = sheetId + '|' + sheetName;
  const enCache = _csvCache.get(clave);
  if (enCache && Date.now() - enCache.t < 20000) return enCache.p;
  const p = csvBajar_(sheetId, sheetName);
  _csvCache.set(clave, { t: Date.now(), p: p });
  const res = await p;
  if (!res) _csvCache.delete(clave);
  return res;
}

async function csvBajar_(sheetId, sheetName) {
  try {
    const url = 'https://docs.google.com/spreadsheets/d/'+sheetId+'/gviz/tq?tqx=out:csv&sheet='+
                encodeURIComponent(sheetName)+'&_='+Date.now();
    const headers = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' };
    const token = await googleToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000),
                                 cf: { cacheTtl: 0, cacheEverything: false }, headers: headers });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const txt = await r.text();
    // Sin permiso, Google contesta 200 con la página de login en HTML.
    if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error('sin permiso (HTML de login)');
    return parseCSV(txt);
  } catch(e) { console.error('csv ['+sheetName+']: '+e.message); return null; }
}

// ── Token OAuth de la cuenta de servicio (JWT RS256 con WebCrypto) ──
let _gTok = { v: '', exp: 0 };
async function googleToken() {
  if (!GOOGLE_SA || !GOOGLE_SA.private_key || !GOOGLE_SA.client_email) return '';
  if (_gTok.v && Date.now() < _gTok.exp - 60000) return _gTok.v;
  try {
    const ahora = Math.floor(Date.now() / 1000);
    const b64u = function(o) {
      const s = typeof o === 'string' ? o : JSON.stringify(o);
      return btoa(unescape(encodeURIComponent(s))).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    };
    const enc = b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u({
      iss: GOOGLE_SA.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600
    });
    const pem = GOOGLE_SA.private_key.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'');
    const der = Uint8Array.from(atob(pem), function(c){ return c.charCodeAt(0); });
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const firma = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(enc)));
    let bin = ''; firma.forEach(function(b){ bin += String.fromCharCode(b); });
    const jwt = enc + '.' + btoa(bin).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(JSON.stringify(j).substring(0, 200));
    _gTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return _gTok.v;
  } catch (e) { console.error('googleToken fallo - ' + e.message); return ''; }
}

// Índice de columna por ENCABEZADO (sin acentos, mayúsculas ni espacios
// de más). Recibe la fila de encabezados y una lista de alias; devuelve
// -1 si no está. Así mover columnas no rompe nada; renombrarlas sí.
function normEnc(s) { return sinAcentos(String(s||'').toLowerCase()).replace(/[^a-z0-9%]+/g,' ').trim(); }
function colPor(encabezados, alias) {
  const enc = (encabezados || []).map(normEnc);
  for (const a of [].concat(alias)) {
    const i = enc.indexOf(normEnc(a));
    if (i !== -1) return i;
  }
  // Google (gviz) a veces pega una fila de aviso con la fila de encabezados en
  // la 1a columna ("Ultima actualizacion: ... Referencia"): aceptar "termina en".
  for (const a of [].concat(alias)) {
    const n = normEnc(a);
    if (!n) continue;
    const j = enc.findIndex(function (e) { return e.length > n.length && e.slice(-(n.length + 1)) === ' ' + n && /actualizacion/.test(e); });
    if (j !== -1) return j;
  }
  return -1;
}
// Busca la fila de encabezados (la primera que contenga `ancla`) dentro de
// las primeras 5. Devuelve { fila, idx } o null.
function filaEncabezados(datos, ancla) {
  if (!datos) return null;
  for (let i = 0; i < Math.min(5, datos.length); i++) {
    if (colPor(datos[i], ancla) !== -1) return { fila: datos[i], idx: i };
  }
  return null;
}









function parseCSV(text) {
  return text.split('\n').map(function(line){
    const cols=[]; let inQ=false,cur='';
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}
      else if(c===','&&!inQ){cols.push(cur.trim());cur='';}
      else cur+=c;
    }
    cols.push(cur.trim());
    return cols;
  }).filter(function(r){return r.length>1;});
}

// Extrae fecha o rango de fechas del texto
// Soporta: "hoy", "25/03/2026", "23/03/2026 - 25/03/2026",
//          "marzo", "marzo 2026", "primera quincena marzo", "segunda quincena marzo"
// Devuelve {fechaISO, fechaISOFin, fechaLabel, resto}
function extraerFecha(texto) {

  // Helper: fecha MX en ISO dado un offset de días
  function fechaMX(offsetDias) {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const mx  = new Date(utc + (-6 * 60 * 60000) + (offsetDias * 86400000));
    const d   = String(mx.getDate()).padStart(2,'0');
    const mo  = String(mx.getMonth()+1).padStart(2,'0');
    const y   = mx.getFullYear().toString();
    return { iso: y+'-'+mo+'-'+d, display: d+'/'+mo+'/'+y };
  }

  // Detectar "ayer - hoy" / "hoy - ayer" (rango)
  if (/\bayer\s*[-–]\s*hoy\b|\bhoy\s*[-–]\s*ayer\b/i.test(texto)) {
    const ayer = fechaMX(-1);
    const hoy  = fechaMX(0);
    return { fechaISO: ayer.iso, fechaISOFin: hoy.iso,
             fechaLabel: ayer.display+' al '+hoy.display,
             resto: texto.replace(/\b(ayer\s*[-–]\s*hoy|hoy\s*[-–]\s*ayer)\b/i,'').replace(/\s+/g,' ').trim() };
  }

  // Detectar "ayer"
  if (/\bayer\b/i.test(texto)) {
    const ayer = fechaMX(-1);
    return { fechaISO: ayer.iso, fechaISOFin: null, fechaLabel: ayer.display,
             resto: texto.replace(/\bayer\b/i,'').replace(/\s+/g,' ').trim() };
  }

  // Detectar "hoy"
  if (/\bhoy\b/i.test(texto)) {
    const hoy = fechaMX(0);
    return { fechaISO: hoy.iso, fechaISOFin: null, fechaLabel: hoy.display,
             resto: texto.replace(/\bhoy\b/i,'').replace(/\s+/g,' ').trim() };
  }

  // Detectar "pasado mañana" (dos días) — revisar ANTES que "mañana"
  if (/\bpasado\s+mañana\b|\bpasado\s+manana\b/i.test(texto)) {
    const f = fechaMX(2);
    return { fechaISO: f.iso, fechaISOFin: null, fechaLabel: 'Pasado mañana ('+f.display+')',
             resto: texto.replace(/\bpasado\s+ma(ñ|n)ana\b/i,'').replace(/\s+/g,' ').trim() };
  }

  // Detectar "mañana" (con o sin acento)
  if (/\bmañana\b|\bmanana\b/i.test(texto)) {
    const f = fechaMX(1);
    return { fechaISO: f.iso, fechaISOFin: null, fechaLabel: 'Mañana ('+f.display+')',
             resto: texto.replace(/\bma(ñ|n)ana\b/i,'').replace(/\s+/g,' ').trim() };
  }

  // Detectar semanas: "siguiente semana" / "próxima semana" / "semana que viene"
  //                    "esta semana" / "semana actual"
  //                    "semana pasada" / "semana anterior"
  // Calcula rango Lunes-Domingo de la semana indicada
  const mSemana = texto.match(/\b(siguiente|proxima|próxima|esta|pasada|anterior)\s+semana\b|\bsemana\s+(que\s+viene|actual|pasada|anterior|siguiente|proxima|próxima)\b/i);
  if (mSemana) {
    const txtMatch = (mSemana[1] || mSemana[2] || '').toLowerCase();
    // Determinar offset de semanas (-1, 0, +1)
    let offsetSemanas = 0;
    if (/(siguiente|proxima|próxima|que\s+viene)/i.test(txtMatch)) offsetSemanas = 1;
    else if (/(pasada|anterior)/i.test(txtMatch)) offsetSemanas = -1;
    // "esta" / "actual" → 0

    // Calcular lunes de la semana objetivo
    // getDay(): 0=Dom, 1=Lun, ..., 6=Sáb
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const hoyMX = new Date(utc + (-6 * 60 * 60000));
    const diaSemana = hoyMX.getDay();
    // Días para llegar al lunes de ESTA semana: si es domingo (0), retroceder 6; si no, día-1
    const diasAlLunes = (diaSemana === 0) ? -6 : (1 - diaSemana);
    const lunes   = fechaMX(diasAlLunes + (offsetSemanas * 7));
    // Rango LABORAL: lunes a VIERNES (4 días después del lunes, no 6).
    // Antes incluía sábado y domingo, lo que metía días no laborales en
    // los resultados. Asistencia, vacaciones, retardos, faltas son todos
    // datos de días hábiles.
    const viernes = fechaMX(diasAlLunes + (offsetSemanas * 7) + 4);
    let labelPrefijo;
    if (offsetSemanas === 1) labelPrefijo = 'Próxima semana';
    else if (offsetSemanas === -1) labelPrefijo = 'Semana pasada';
    else labelPrefijo = 'Esta semana';
    return {
      fechaISO: lunes.iso, fechaISOFin: viernes.iso,
      fechaLabel: labelPrefijo+' ('+lunes.display+' al '+viernes.display+')',
      resto: texto.replace(mSemana[0],'').replace(/\s+/g,' ').trim()
    };
  }

  // Detectar mes relativo: "siguiente mes" / "próximo mes" / "mes que viene"
  //                        "este mes" / "mes pasado" / "mes anterior"
  const mMesRel = texto.match(/\b(siguiente|proximo|próximo|este|pasado|anterior)\s+mes\b|\bmes\s+(que\s+viene|actual|pasado|anterior|siguiente|proximo|próximo)\b/i);
  if (mMesRel) {
    const txtMatch = (mMesRel[1] || mMesRel[2] || '').toLowerCase();
    let offsetMeses = 0;
    if (/(siguiente|proximo|próximo|que\s+viene)/i.test(txtMatch)) offsetMeses = 1;
    else if (/(pasado|anterior)/i.test(txtMatch)) offsetMeses = -1;

    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const hoyMX = new Date(utc + (-6 * 60 * 60000));
    const target = new Date(hoyMX.getFullYear(), hoyMX.getMonth() + offsetMeses, 1);
    const y  = target.getFullYear();
    const mo = String(target.getMonth()+1).padStart(2,'0');
    const lastDay = new Date(y, target.getMonth()+1, 0).getDate();
    const ini = y+'-'+mo+'-01';
    const fin = y+'-'+mo+'-'+String(lastDay).padStart(2,'0');
    const mesNombres = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const label = mesNombres[target.getMonth()]+' '+y;
    return {
      fechaISO: ini, fechaISOFin: fin, fechaLabel: label,
      resto: texto.replace(mMesRel[0],'').replace(/\s+/g,' ').trim()
    };
  }

  // Detectar quincenas: "primera quincena marzo" / "segunda quincena marzo 2026"
  const mQ = texto.match(/\b(primera|segunda)\s+quincena\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(20\d{2}))?\b/i);
  if (mQ) {
    const q     = mQ[1].toLowerCase();
    const mesNom= mQ[2].toLowerCase();
    const meses = {enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',
                   julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'};
    const mo  = meses[mesNom];
    const y   = mQ[3] || new Date().getFullYear().toString();
    const ini = q === 'primera' ? y+'-'+mo+'-01' : y+'-'+mo+'-16';
    const lastDay = new Date(parseInt(y), parseInt(mo), 0).getDate();
    const fin = q === 'primera' ? y+'-'+mo+'-15' : y+'-'+mo+'-'+lastDay;
    const label = (q==='primera'?'1a':'2a')+' quincena '+mesNom+' '+y;
    const resto = texto.replace(mQ[0],'').replace(/\s+/g,' ').trim();
    return { fechaISO: ini, fechaISOFin: fin, fechaLabel: label, resto };
  }

  // Detectar mes por nombre: "marzo" / "marzo 2026"
  const mMes = texto.match(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(20\d{2}))?\b/i);
  if (mMes) {
    const mesNom = mMes[1].toLowerCase();
    const meses  = {enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',
                    julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'};
    const mo  = meses[mesNom];
    const y   = mMes[2] || new Date().getFullYear().toString();
    const lastDay = new Date(parseInt(y), parseInt(mo), 0).getDate();
    const ini = y+'-'+mo+'-01';
    const fin = y+'-'+mo+'-'+String(lastDay).padStart(2,'0');
    const label = mesNom+' '+y;
    const resto = texto.replace(mMes[0],'').replace(/\s+/g,' ').trim();
    return { fechaISO: ini, fechaISOFin: fin, fechaLabel: label, resto };
  }

  // Detectar rango: "23/03/2026 - 25/03/2026" o "23/03/2026 al 25/03/2026"
  const mRango = texto.match(
    /(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*(?:-{1,3}|al)\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i
  );
  if (mRango) {
    const f1 = parseFechaTexto(mRango[1]);
    const f2 = parseFechaTexto(mRango[2]);
    if (f1 && f2) {
      const resto = texto.replace(mRango[0],'').replace(/\s+/g,' ').trim();
      return { fechaISO: f1, fechaISOFin: f2,
               fechaLabel: isoADisplay(f1)+' al '+isoADisplay(f2), resto };
    }
  }

  // Fecha única
  const m = texto.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (!m) return { fechaISO: null, fechaISOFin: null, fechaLabel: null, resto: texto };
  const iso = parseFechaTexto(m[0]);
  if (!iso) return { fechaISO: null, fechaISOFin: null, fechaLabel: null, resto: texto };
  const resto = texto.replace(m[0],'').replace(/\s+/g,' ').trim();
  return { fechaISO: iso, fechaISOFin: null, fechaLabel: isoADisplay(iso), resto };
}

// Convierte "25/03/2026" o "25/3/2026" a "2026-03-25"
function parseFechaTexto(s) {
  const m = String(s||'').match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (!m) return null;
  const d  = m[1].padStart(2,'0');
  const mo = m[2].padStart(2,'0');
  const y  = m[3] ? (m[3].length===2?'20'+m[3]:m[3]) : new Date().getFullYear().toString();
  if (parseInt(mo)<1||parseInt(mo)>12) return null;
  return y+'-'+mo+'-'+d;
}

// Convierte "2026-03-25" a "25/03/2026"
function isoADisplay(iso) {
  if (!iso) return '';
  const p = iso.split('-');
  if (p.length !== 3) return iso;
  // Calcular día de la semana usando UTC para evitar problemas de timezone
  // (cuando el server está en UTC y la fecha es ISO sin hora).
  const d = new Date(Date.UTC(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2])));
  const diasSem = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const dia = diasSem[d.getUTCDay()];
  // Formato: "Lun 15/06/2026" — el día va antes para que se identifique
  // inmediatamente sin tener que mirar todo el número.
  return dia+' '+p[2]+'/'+p[1]+'/'+p[0];
}

// ── Normaliza cualquier formato de fecha a YYYY-MM-DD ─────────
// Soporta:
//   "23/3/2026 21:48:47"  → "2026-03-23"  (Histórico alertas, Vendedor incorrecto - DD/M/YYYY)
//   "3/3/2026 15:14:14"   → "2026-03-03"  (mismo formato)
//   "2026-03-19 21:04"    → "2026-03-19"  (Por recibir, Sobreventa - ISO con hora)
//   "2026-03-22"          → "2026-03-22"  (Métricas diarias - ISO puro)
//   "2026-03-25 10:30:00" → "2026-03-25"  (Canales de venta gviz CSV)
function normalizarFecha(v) {
  const s = String(v || '').trim();
  if (!s) return '';

  // Ya es YYYY-MM-DD (con o sin hora): "2026-03-19" / "2026-03-19 21:04"
  const mISO = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mISO) return mISO[1]+'-'+mISO[2]+'-'+mISO[3];

  // Formato D/M/YYYY o DD/MM/YYYY con hora opcional: "23/3/2026 21:48:47"
  // El primer número es el DÍA (formato mexicano)
  const mMX = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mMX) {
    const dia = mMX[1].padStart(2,'0');
    const mes = mMX[2].padStart(2,'0');
    const anio = mMX[3];
    // Validar que mes sea 1-12 (si no, probablemente está invertido)
    if (parseInt(mes) >= 1 && parseInt(mes) <= 12) {
      return anio+'-'+mes+'-'+dia;
    }
    // Si mes > 12, intentar invertir (caso borde)
    return anio+'-'+dia+'-'+mes;
  }

  return s.substring(0, 10);
}


// Compara fecha de celda contra filtro — soporta fecha única y rango
function coincideFecha(valorCelda, fechaISO, fechaISOFin) {
  if (!fechaISO) return true;
  const f = normalizarFecha(valorCelda);
  if (!f) return false;
  if (fechaISOFin) return f >= fechaISO && f <= fechaISOFin;
  return f === fechaISO;
}

// ── Divide un texto en múltiples términos por coma o " y " ───
// "Ximena, Carlos, Rodrigo" → ["Ximena","Carlos","Rodrigo"]
// "walmart, ml" → ["walmart","ml"]
// "Samsung" → ["Samsung"]  (un solo término, sin split)
function splitTerminos(texto) {
  if (!texto) return [texto];
  // Separar por coma o " y " (con espacios)
  const partes = texto.split(/\s*,\s*|\s+y\s+/i)
    .map(function(p){ return p.trim(); })
    .filter(function(p){ return p.length > 0; });
  return partes.length > 0 ? partes : [texto];
}

function parsearConsulta(texto) {
  let termino=texto,stockOp=null,stockVal=null;
  const pat=/\bstock\s+(mayor\s+o\s+igual\s+a|menor\s+o\s+igual\s+a|mayor\s+a|menor\s+a|igual\s+a|>=|<=|>|<|=)\s*(\d+)/i;
  const m=texto.match(pat);
  if(m){
    const op=m[1].trim().toLowerCase();
    stockVal=parseInt(m[2]);
    if(op==='mayor o igual a'||op==='>=')stockOp='gte';
    else if(op==='mayor a'||op==='>')stockOp='gt';
    else if(op==='menor o igual a'||op==='<=')stockOp='lte';
    else if(op==='menor a'||op==='<')stockOp='lt';
    else if(op==='igual a'||op==='=')stockOp='eq';
    else stockOp='gt';
    termino=texto.replace(pat,'').replace(/\bcon\b|\bde\b|\by\b/gi,' ').replace(/\s+/g,' ').trim();
  }
  return {termino,stockOp,stockVal};
}

function filtroStock(d,op,val){if(!op||val===null)return true;switch(op){case'gt':return d>val;case'gte':return d>=val;case'lt':return d<val;case'lte':return d<=val;case'eq':return d===val;}return true;}
function buildLabel(t,op,val){const ops={gt:'mayor a',gte:'mayor o igual a',lt:'menor a',lte:'menor o igual a',eq:'igual a'};if(t&&op)return'"'+t+'" + stock '+(ops[op]||op)+' '+val;if(t)return'"'+t+'"';if(op)return'stock '+(ops[op]||op)+' '+val;return t;}
function num(v){return parseInt(String(v||'0').replace(/,/g,'').replace(/\./g,''))||0;}
function icon(d){return d<=0?'🔴':d<=5?'🟡':d<=20?'🟠':'🟢';}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Elimina acentos para búsqueda sin importar tildes
function sinAcentos(s) {
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}

// Verifica si un valor contiene el término ignorando acentos (substring genérico)
function contiene(valor, termino) {
  return sinAcentos(valor).indexOf(sinAcentos(termino)) !== -1;
}

// Búsqueda de nombre de empleado: cada palabra del término debe ser
// palabra completa en el nombre (evita "eric" → "erick")
// ── Distancia de Levenshtein (errores de tipeo permitidos) ─────────────
// Cuenta cuántas operaciones (insertar/borrar/sustituir 1 char) hay entre
// dos palabras. Usado para tolerar errores: "vctor" vs "victor" → 1 op.
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  // Matriz mínima usando solo 2 filas
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertar
        prev[j]     + 1,        // borrar
        prev[j - 1] + cost      // sustituir
      );
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[lb];
}

// Tolerancia por longitud de palabra. Palabras cortas (≤3 letras) deben
// matchear exacto; medianas permiten 1 error; largas permiten 2.
function distanciaPermitida(palabra) {
  const n = palabra.length;
  if (n <= 3) return 0;
  if (n <= 6) return 1;
  return 2;
}


// Buffer global para respuestas de la app web (clave = chatId 'web:UUID')
// Cuando una petición llega a /api/query, genera un chatId único, llama al
// router como si fuera Telegram, y al final lee este buffer para devolver JSON.
const _webBuffer = new Map();

async function enviar(chatId,texto){
  // Si es petición de la app web, acumular en buffer y NO mandar a Telegram
  if (String(chatId).indexOf('web:') === 0) {
    if (!_webBuffer.has(chatId)) _webBuffer.set(chatId, []);
    _webBuffer.get(chatId).push(texto);
    return;
  }
  try{await fetch(TELEGRAM_API+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:texto,parse_mode:'HTML'})});}
  catch(e){console.error('enviar:',e.message);}
}
async function wa_send(chatId,msg){
  const u=USUARIOS[chatId];
  if(u){await callMeBot(u.tel,u.key,msg);}
  else{await Promise.all(WHATSAPP.map(function(d){return callMeBot(d.tel,d.key,msg);}));}
}
async function callMeBot(tel,key,msg){
  try{await fetch('https://api.callmebot.com/whatsapp.php?phone='+tel+'&text='+encodeURIComponent(msg)+'&apikey='+key);}
  catch(e){console.error('callMeBot:',e.message);}
}