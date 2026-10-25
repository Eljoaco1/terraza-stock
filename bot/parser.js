'use strict';
// Lógica pura (sin red): interpreta los mensajes del bot.
const ADD = new Set(['sumar','suma','agregar','agrega','ingreso','entro','entraron','llego','llegaron','compre','repuse']);
const SUB = new Set(['restar','resta','quitar','quita','sacar','saca','bajar','baja','vendi','vendio','venta','salio','salieron','gaste','rompi']);
const NUM = /^([+-])?(\d+(?:[.,]\d+)?|\d+\/\d+)$/;

const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const r2 = n => Math.round(n * 100) / 100;

function cantidad(s) {
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b : NaN; }
  return parseFloat(s.replace(',', '.'));
}

// "fernet 1/4" | "restar coca lata 2" | "fernet -1/2 barra" | "barra: fernet 1" | "vendí fernet 1"
function parse(texto, zonas) {
  const tk = norm(texto).split(' ');
  let signo = 1, verbo = false, zona = null;
  if (ADD.has(tk[0])) { tk.shift(); verbo = true; }
  else if (SUB.has(tk[0])) { tk.shift(); signo = -1; verbo = true; }
  const zn = zonas.map(norm);
  const zi = n => zn.indexOf(n.replace(/:$/, ''));
  if (tk.length > 1 && tk[0].endsWith(':') && zi(tk[0]) >= 0) zona = zonas[zi(tk.shift())];
  else if (tk.length > 2 && zi(tk[tk.length - 1]) >= 0) zona = zonas[zi(tk.pop())];
  const m = tk.length > 1 && NUM.exec(tk[tk.length - 1]);
  if (!m) return null;
  tk.pop();
  const c = cantidad(m[2]);
  if (!(c > 0)) return null;
  if (!verbo && m[1]) signo = m[1] === '-' ? -1 : 1;
  return { producto: tk.join(' '), delta: signo * c, zona };
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}

// Devuelve {ok: nombre} o {opciones: [...]}
function buscar(q, lista) {
  const n = norm(q), mapa = lista.map(p => [p, norm(p)]);
  const ex = mapa.find(([, x]) => x === n);
  if (ex) return { ok: ex[0] };
  const inc = mapa.filter(([, x]) => x.startsWith(n) || x.includes(n));
  if (inc.length === 1) return { ok: inc[0][0] };
  if (inc.length > 1) return { opciones: inc.slice(0, 6).map(a => a[0]) };
  const cerc = mapa.map(([p, x]) => [p, lev(n, x)]).filter(([, d]) => d <= (n.length >= 8 ? 3 : 2)).sort((a, b) => a[1] - b[1]);
  if (cerc.length && (cerc.length === 1 || cerc[0][1] < cerc[1][1])) return { ok: cerc[0][0] };
  return { opciones: cerc.slice(0, 4).map(a => a[0]) };
}

function fmt(v) {
  if (!(v > 0)) return '0';
  const e = Math.floor(v), d = Math.round((v - e) * 100) / 100;
  const f = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' }[d] || (d > 0 ? String(d) : '');
  return e === 0 && f ? f : f ? `${e} y ${f}` : `${e}`;
}

module.exports = { norm, r2, parse, buscar, fmt };
