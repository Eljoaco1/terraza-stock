// 1. Configuración de Firebase Realtime Database (API REST)
const FIREBASE_URL = "https://datos-terraza-default-rtdb.firebaseio.com";

const productosValidos = [
  "ipa sin", "coca lata", "coca 500ml", "coca grande", "speed 250", "speed xl", 
  "agua 500ml", "agua 2l", "soda 500ml", "soda 2l", "fanta", "coca zero", 
  "sprite 500ml", "sprite 2,25ml", "schweppes", "paso de los toros", "jugo naranja", "papas",
  "fernet", "gancia", "campari", "smirnoff", "gin london", "gin doble", "gin mango", 
  "gin pink", "bib london", "bib doble", "bib mango", "bib pink", "corona", 
  "corona sin", "stella", "heineken", "vino la flota", "vino blanco", "vermu pasaron cosas", "vermu carpano"
];

// 2. Token de Telegram y enlace a la API
const TELEGRAM_TOKEN = '8916813555:AAEdYKNgsGxtPBOh5gmfZnAi7sArFQPTHqE';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let lastUpdateId = 0;

// Convierte texto de cantidad (ej: "1/4", "0.5", "2") a número float
function parseCantidad(str) {
  if (str.includes('/')) {
    const partes = str.split('/');
    if (partes.length === 2 && parseFloat(partes[1]) !== 0) {
      return parseFloat(partes[0]) / parseFloat(partes[1]);
    }
  }
  return parseFloat(str.replace(',', '.'));
}

// Formatea un número decimal a representación mixta (ej: 20.75 -> "20 y 3/4")
function formatearStock(valor) {
  const entero = Math.floor(valor);
  const decimal = Math.round((valor - entero) * 100) / 100;

  let fraccion = '';
  if (decimal === 0.25) fraccion = '1/4';
  else if (decimal === 0.5) fraccion = '1/2';
  else if (decimal === 0.75) fraccion = '3/4';
  else if (decimal > 0) fraccion = decimal.toString();

  if (entero === 0 && fraccion !== '') return fraccion;
  if (fraccion !== '') return `${entero} y ${fraccion}`;
  return `${entero}`;
}

async function sendMessage(chatId, text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.error("Error enviando mensaje:", err);
  }
}

async function sumarStockFirebase(producto, cantidad) {
  const url = `${FIREBASE_URL}/stock/${encodeURIComponent(producto)}.json`;
  
  const resGet = await fetch(url);
  const currentStock = await resGet.json();
  
  const stockPrevio = typeof currentStock === 'number' ? currentStock : 0;
  // Redondear a 2 decimales para evitar imprecisiones de JavaScript
  const nuevoStock = Math.round((stockPrevio + cantidad) * 100) / 100;

  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nuevoStock)
  });

  return nuevoStock;
}

async function getUpdates() {
  try {
    const response = await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    const data = await response.json();

    if (data.ok && data.result.length > 0) {
      console.log(`📩 Se recibieron ${data.result.length} actualización(es) de Telegram`);
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          console.log(`💬 Mensaje de ${update.message.from.first_name}: "${update.message.text}"`);
          await processMessage(update.message);
        }
      }
    }
  } catch (err) {
    console.error("Error leyendo mensajes:", err.message);
  } finally {
    setTimeout(getUpdates, 1000);
  }
}

async function processMessage(msg) {
  const chatId = msg.chat.id;
  const texto = msg.text ? msg.text.toLowerCase().trim() : '';
  const usuario = msg.from.first_name || 'Compañero';

  if (texto === '/start' || texto === '/ayuda') {
    return sendMessage(chatId, `👋 ¡Hola ${usuario}!\n\nPuedes enviar enteros, decimales o fracciones.\nEjemplos:\n• fernet 1/4\n• fernet 1/2\n• coca lata 5`);
  }

  // Acepta enteros, decimales (0.5) y fracciones (1/4, 3/4)
  const coincidencia = texto.match(/^(.*?)\s+(\d+(?:[\.,]\d+|\/\d+)?)$/);

  if (!coincidencia) {
    return sendMessage(chatId, `⚠️ Formato no válido, ${usuario}. Escribe "producto cantidad".\nEjemplos: "fernet 1/4", "fernet 0.5" o "coca lata 2"`);
  }

  const nombreBusqueda = coincidencia[1].trim();
  const cantidadTexto = coincidencia[2].trim();
  const cantidadASumar = parseCantidad(cantidadTexto);

  if (isNaN(cantidadASumar) || cantidadASumar <= 0) {
    return sendMessage(chatId, `⚠️ Cantidad no válida.`);
  }

  const productoEncontrado = productosValidos.find(p => p.toLowerCase() === nombreBusqueda);

  if (!productoEncontrado) {
    return sendMessage(chatId, `❌ No encontré "${nombreBusqueda}". Revisa la lista.`);
  }

  try {
    const nuevoStockVal = await sumarStockFirebase(productoEncontrado, cantidadASumar);
    const stockFormateado = formatearStock(nuevoStockVal);
    await sendMessage(chatId, `✅ ¡Listo ${usuario}! Se sumó *${cantidadTexto}* a *${productoEncontrado}*.\n📦 Stock actual: *${stockFormateado}*`);
  } catch (error) {
    console.error("Error en Firebase:", error);
    await sendMessage(chatId, `❌ Hubo un error al actualizar el stock.`);
  }
}

console.log("🤖 Bot de Telegram corriendo con soporte para fracciones y decimales...");
getUpdates();