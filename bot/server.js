'use strict';
const http = require('http');
const admin = require('firebase-admin');
const { norm, r2, parse, buscar, fmt } = require('./parser');

const { TELEGRAM_TOKEN, FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT, WEBHOOK_SECRET, NEGOCIO } = process.env;
const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL; // Render lo define solo
const ALLOWED = (process.env.ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const OBSERVERS = (process.env.OBSERVER_IDS || '').split(',').map(s => s.trim()).filter(Boolean); // dueños: solo lectura

for (const [k, v] of Object.entries({ TELEGRAM_TOKEN, FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT, WEBHOOK_SECRET, NEGOCIO })) {
  if (!v) { console.error(`Falta la variable de entorno ${k}`); process.exit(1); }
}
if (!ALLOWED.length) console.warn('⚠️ ALLOWED_IDS vacío: cualquiera que encuentre el bot puede modificar el stock.');

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)), databaseURL: FIREBASE_DB_URL });
const db = admin.database();
const R = p => `negocios/${NEGOCIO}/${p}`; // todo cuelga del bar configurado en NEGOCIO
const API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Productos y zonas en vivo desde Firebase (única fuente de verdad)
let productos = [], zonas = ['barra', 'arriba'];
db.ref(R('productos')).on('value', s => {
  productos = Object.keys(s.val() || {});
  console.log(`Negocio "${NEGOCIO}": ${productos.length} productos cargados`);
}, e => console.error('No se pueden leer los productos:', e.message));
db.ref(R('config/zonas')).on('value', s => { const v = s.val(); if (Array.isArray(v) && v.length) zonas = v; });

async function send(chatId, text) {
  for (let i = 0; i < text.length; i += 3800) {
    try {
      await fetch(`${API}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(i, i + 3800) }) });
    } catch (e) { console.error('Error enviando mensaje:', e.message); }
  }
}

async function ajustar(ref, delta) {
  let antes = 0;
  const t = await ref.transaction(c => { antes = typeof c === 'number' ? c : 0; return Math.max(0, r2(antes + delta)); });
  return { antes, despues: t.snapshot.val() };
}

// Mueve stock en una zona (si hay) y siempre en el total general
async function mover(prod, zona, delta, quien) {
  let aplicado, zonaDespues = null;
  if (zona) {
    const z = await ajustar(db.ref(R(`zonas/${zona}/${prod}`)), delta);
    aplicado = r2(z.despues - z.antes); zonaDespues = z.despues;
    if (aplicado !== 0) await ajustar(db.ref(R(`stock/${prod}`)), aplicado);
  } else {
    const s = await ajustar(db.ref(R(`stock/${prod}`)), delta);
    aplicado = r2(s.despues - s.antes);
  }
  const total = (await db.ref(R(`stock/${prod}`)).once('value')).val() || 0;
  if (aplicado !== 0) await db.ref(R('movimientos')).push({ usuario: quien, producto: prod, zona: zona || null, delta: aplicado, ts: admin.database.ServerValue.TIMESTAMP, origen: 'telegram' });
  return { aplicado, zonaDespues, total };
}

const AYUDA = `Cómo usarme:
• fernet 2 → suma 2
• fernet -1/2 → resta media
• restar coca lata 3 / vendí speed 1
• sumar fernet 5 barra (o "barra: fernet 5")
• /zona barra → usa esa zona por defecto (/zona ninguna la quita)
• /stock, /stock fernet, /stock barra, /faltantes, /zonas
Cantidades: enteros, decimales (0.5) o fracciones (1/4).`;

async function procesar(msg) {
  const chat = msg.chat.id, uid = String(msg.from.id), nombre = msg.from.first_name || 'Compañero';
  const raw = (msg.text || '').trim();
  if (!raw) return;
  const t = norm(raw);
  if (t === '/id') return send(chat, `Tu ID de Telegram: ${uid}`);
  const lectura = OBSERVERS.includes(uid);
  if (ALLOWED.length && !ALLOWED.includes(uid) && !lectura) return send(chat, `⛔ No estás autorizado. Pasale tu ID al dueño: ${uid}`);
  if (['/start', '/ayuda', '/help'].includes(t)) return send(chat, `👋 ¡Hola ${nombre}!\n\n${AYUDA}`);
  if (t === '/zonas') return send(chat, `Zonas: ${zonas.join(', ')}`);

  if (t.startsWith('/zona')) {
    const arg = t.slice(5).trim();
    if (arg === 'ninguna') { await db.ref(R(`telegram/${uid}/zona`)).remove(); return send(chat, 'Zona por defecto quitada: se suma solo al total.'); }
    const z = zonas.find(x => norm(x) === arg);
    if (!z) return send(chat, `Zonas disponibles: ${zonas.join(', ')}`);
    await db.ref(R(`telegram/${uid}/zona`)).set(z);
    return send(chat, `📍 Zona por defecto: ${z}`);
  }

  if (t === '/faltantes') {
    const st = (await db.ref(R('stock')).once('value')).val() || {};
    const f = productos.filter(p => !(st[p] > 0));
    return send(chat, f.length ? `Sin stock (${f.length}):\n${f.join('\n')}` : '✅ No falta nada.');
  }

  if (t.startsWith('/stock')) {
    const arg = t.slice(6).trim();
    const st = (await db.ref(R('stock')).once('value')).val() || {};
    if (!arg) {
      const l = productos.filter(p => st[p] > 0).sort().map(p => `${p}: ${fmt(st[p])}`);
      return send(chat, l.length ? `📦 Stock general:\n${l.join('\n')}` : 'No hay stock cargado.');
    }
    const z = zonas.find(x => norm(x) === arg);
    if (z) {
      const zd = (await db.ref(R(`zonas/${z}`)).once('value')).val() || {};
      const l = Object.keys(zd).filter(p => zd[p] > 0).sort().map(p => `${p}: ${fmt(zd[p])}`);
      return send(chat, l.length ? `📍 ${z}:\n${l.join('\n')}` : `Sin stock en ${z}.`);
    }
    const r = buscar(arg, productos);
    if (!r.ok) return send(chat, r.opciones.length ? `¿Cuál? ${r.opciones.join(', ')}` : `❌ No encontré "${arg}".`);
    const zs = (await db.ref(R('zonas')).once('value')).val() || {};
    const det = zonas.filter(x => zs[x] && zs[x][r.ok] > 0).map(x => `${x}: ${fmt(zs[x][r.ok])}`);
    return send(chat, `📦 ${r.ok}: ${fmt(st[r.ok] || 0)}${det.length ? '\n' + det.join('\n') : ''}`);
  }

  if (lectura) return send(chat, '👁 Sos observador: podés usar /stock, /faltantes y /zonas, pero no modificar el stock.');
  const p = parse(raw, zonas);
  if (!p) return send(chat, `⚠️ No entendí, ${nombre}. Probá "fernet 2" o "restar fernet 1/2".\n\n${AYUDA}`);
  const r = buscar(p.producto, productos);
  if (!r.ok) return send(chat, r.opciones.length ? `¿A cuál te referís? ${r.opciones.join(', ')}` : `❌ No encontré "${p.producto}".`);
  const zdef = (await db.ref(R(`telegram/${uid}/zona`)).once('value')).val();
  const zona = p.zona || (zonas.includes(zdef) ? zdef : null);

  try {
    const m = await mover(r.ok, zona, p.delta, nombre);
    const signo = m.aplicado >= 0 ? '+' : '−';
    let out = `✅ ${r.ok} ${signo}${fmt(Math.abs(m.aplicado))}${zona ? ` (${zona})` : ' (solo total)'}`;
    if (r2(Math.abs(p.delta)) !== r2(Math.abs(m.aplicado))) out += `\n⚠️ Pediste ${fmt(Math.abs(p.delta))} pero no había tanto: quedó en 0.`;
    if (zona) out += `\n📍 ${zona}: ${fmt(m.zonaDespues)}`;
    return send(chat, `${out}\n📦 Total: ${fmt(m.total)}`);
  } catch (e) {
    console.error('Error en Firebase:', e);
    return send(chat, '❌ Hubo un error al actualizar el stock.');
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) { res.writeHead(403); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end('ok');
      try { const u = JSON.parse(body); if (u.message) procesar(u.message).catch(e => console.error(e)); } catch (e) { console.error('Update inválido'); }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot Stock Terraza activo');
}).listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

async function polling() { // solo para desarrollo local (sin URL pública)
  let offset = 0;
  await fetch(`${API}/deleteWebhook`);
  for (;;) {
    try {
      const d = await (await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`)).json();
      for (const u of d.result || []) { offset = u.update_id + 1; if (u.message) await procesar(u.message); }
    } catch (e) { console.error('Polling:', e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

(async () => {
  if (PUBLIC_URL) {
    const r = await (await fetch(`${API}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${PUBLIC_URL}/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'] }) })).json();
    console.log('Webhook:', r.ok ? 'registrado' : r.description);
  } else { console.log('Sin PUBLIC_URL: modo polling'); polling(); }
})();
