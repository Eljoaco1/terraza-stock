(() => {
  firebase.initializeApp(APP_CONFIG.firebase);
  const auth = firebase.auth(), db = firebase.database();
  const $ = id => document.getElementById(id);
  const r2 = n => Math.round(n * 100) / 100;
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  let yo = null, refYo = null, productos = {}, zonas = ['barra', 'arriba'], stock = {}, zdata = {}, zonaSel = 'general';
  let escucha = false, escuchaUsr = false;
  const esDueno = () => !!yo && yo.rol === 'dueno';
  const esEmpleado = () => !!yo && yo.rol === 'empleado';

  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e[k] = v;
    }
    kids.flat().filter(c => c != null && c !== false).forEach(c => e.append(c));
    return e;
  }

  function num(s) {
    s = String(s).trim().replace(',', '.');
    if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b : NaN; }
    return s === '' ? NaN : Number(s);
  }

  function fmt(v) {
    if (!(v > 0)) return '0';
    const e = Math.floor(v), d = r2(v - e);
    const f = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' }[d] || (d > 0 ? String(d) : '');
    return e === 0 && f ? f : f ? `${e} y ${f}` : `${e}`;
  }

  const nombreValido = n => n && !/[.$#\[\]\/]/.test(n);
  const vista = n => { ['login', 'pendiente', 'app', 'historial'].forEach(i => { $(i).hidden = i !== n; }); $('menu').hidden = n === 'login'; };

  // ---- Sesión y roles ----
  $('entrar').onclick = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => alert('No se pudo entrar: ' + e.message));
  const cerrarSesion = () => auth.signOut().then(() => location.reload());
  function alternarMenu(abrir) { const l = $('menu-lista'), a = abrir ?? l.hidden; l.hidden = !a; $('menu-btn').setAttribute('aria-expanded', String(a)); }
  $('m-salir').onclick = cerrarSesion;
  $('menu-btn').onclick = e => { e.stopPropagation(); alternarMenu(); };
  document.addEventListener('click', e => { if (!$('menu').contains(e.target)) alternarMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') alternarMenu(false); });
  $('m-hist').onclick = () => { alternarMenu(false); abrirHistorial(); };
  $('h-volver').onclick = () => vista('app');

  auth.onAuthStateChanged(async u => {
    if (!u) { yo = null; vista('login'); return; }
    refYo = db.ref('usuarios/' + u.uid);
    try {
      if (!(await refYo.once('value')).exists()) {
        const base = { email: u.email, nombre: u.displayName || u.email };
        // El primer usuario del sistema queda como dueño; las reglas rechazan esto para los demás
        try { await refYo.set({ ...base, rol: 'dueno' }); } catch { await refYo.set({ ...base, rol: 'pendiente' }); }
      }
    } catch (e) { alert('No se pudo darte acceso (puede que el dueño lo haya retirado). Consultá con el dueño.'); cerrarSesion(); return; }
    refYo.on('value', s => {
      yo = s.val();
      if (!yo) { alert('El dueño retiró tu acceso.'); cerrarSesion(); return; }
      $('m-nombre').textContent = yo.nombre;
      $('m-email').textContent = yo.email;
      $('m-rol').textContent = { pendiente: 'Pendiente de aprobación', empleado: 'Empleado', dueno: 'Dueño' }[yo.rol];
      $('m-hist').hidden = !esDueno();
      if (yo.rol === 'pendiente') { vista('pendiente'); return; }
      if ($('historial').hidden) vista('app');
      iniciar();
      render();
    });
  });

  function iniciar() {
    if (!escucha) {
      escucha = true;
      db.ref('productos').on('value', s => { productos = s.val() || {}; render(); });
      db.ref('stock').on('value', s => { stock = s.val() || {}; render(); });
      db.ref('zonas').on('value', s => { zdata = s.val() || {}; render(); });
      db.ref('config/zonas').on('value', s => { const v = s.val(); if (Array.isArray(v) && v.length) zonas = v; render(); });
    }
    if (esDueno() && !escuchaUsr) {
      escuchaUsr = true;
      db.ref('usuarios').on('value', s => renderUsuarios(s.val() || {}));
      db.ref('bloqueados').on('value', s => renderBloqueados(s.val() || {}));
    }
  }

  // ---- Movimientos de stock ----
  async function ajustarRef(ref, delta) {
    let antes = 0;
    const t = await ref.transaction(c => { antes = typeof c === 'number' ? c : 0; return Math.max(0, r2(antes + delta)); });
    return r2(t.snapshot.val() - antes);
  }

  async function mover(p, zona, delta) {
    let aplicado;
    if (zona) {
      aplicado = await ajustarRef(db.ref(`zonas/${zona}/${p}`), delta);
      if (aplicado !== 0) await ajustarRef(db.ref(`stock/${p}`), aplicado);
    } else {
      aplicado = await ajustarRef(db.ref(`stock/${p}`), delta);
    }
    if (aplicado !== 0) await db.ref('movimientos').push({ usuario: yo.email, producto: p, zona: zona || null, delta: aplicado, ts: firebase.database.ServerValue.TIMESTAMP, origen: 'panel' });
  }

  async function cambiar(p, delta) {
    if (zonaSel === 'general' || !esEmpleado()) return;
    try { await mover(p, zonaSel === 'general' ? null : zonaSel, delta); }
    catch (e) { alert('No se pudo guardar: ' + e.message); }
  }

  const cantidad = p => zonaSel === 'general' ? (stock[p] || 0) : ((zdata[zonaSel] || {})[p] || 0);

  // ---- Pantalla ----
  function render() {
    if (!yo || yo.rol === 'pendiente') return;
    if (zonaSel !== 'general' && !zonas.includes(zonaSel)) zonaSel = 'general';
    $('tabs').replaceChildren(...['general', ...zonas].map(z =>
      h('button', { className: z === zonaSel ? 'activa' : '', textContent: z === 'general' ? 'General' : z, onclick: () => { zonaSel = z; render(); } })));

    const editable = zonaSel !== 'general' && esEmpleado();
    $('aviso').hidden = editable;
    $('aviso').textContent = esDueno() ? 'Modo solo lectura: como dueño podés ver el stock, pero no modificarlo.' : 'Esta vista es el total. Para cargar o descontar, elegí una zona.';
    const filtro = norm($('buscador').value);
    const porCat = {};
    Object.keys(productos).sort().filter(p => norm(p).includes(filtro)).forEach(p => {
      (porCat[productos[p].categoria || 'Otros'] ||= []).push(p);
    });

    let ok = 0, cero = 0;
    const filas = [];
    for (const [cat, lista] of Object.entries(porCat)) {
      filas.push(h('tr', {}, h('td', { className: 'cat', colSpan: 3, textContent: cat })));
      lista.forEach(p => {
        const c = cantidad(p);
        c > 0 ? ok++ : cero++;
        const inp = h('input', { type: 'text', inputMode: 'decimal', value: '1', ariaLabel: 'Cantidad para ' + p });
        const accion = signo => { const n = num(inp.value); if (!(n > 0)) return alert('Escribí una cantidad mayor a 0 (ej: 2, 0.5 o 1/4).'); cambiar(p, signo * n); };
        filas.push(h('tr', {},
          h('td', { className: 'nombre', textContent: p }),
          h('td', { className: 'cant' + (c > 0 ? '' : ' cero'), textContent: fmt(c) }),
          h('td', {}, editable && h('div', { className: 'ctl' },
            h('button', { textContent: '−', title: 'Restar', onclick: () => accion(-1) }), inp,
            h('button', { textContent: '+', title: 'Sumar', onclick: () => accion(1) })))));
      });
    }
    if (!filas.length) filas.push(h('tr', {}, h('td', { colSpan: 3, textContent: 'No se encontraron productos.' })));
    $('tabla').replaceChildren(...filas);
    $('count-ok').textContent = ok;
    $('count-zero').textContent = cero;
    $('admin').hidden = !esDueno();
  }
  $('buscador').oninput = render;

  // ---- Herramientas del dueño ----
  const ROLES = [['pendiente', 'Pendiente'], ['empleado', 'Empleado'], ['dueno', 'Dueño']];
  function renderUsuarios(us) {
    const yoUid = auth.currentUser && auth.currentUser.uid;
    $('usuarios').replaceChildren(...Object.entries(us).map(([uid, u]) =>
      h('div', { className: 'usr' }, h('span', { textContent: `${u.nombre} - ${u.email}` }),
        h('div', { className: 'fila' },
          h('select', { ariaLabel: 'Rol de ' + u.nombre, onchange: e => db.ref(`usuarios/${uid}/rol`).set(e.target.value).catch(x => alert(x.message)) },
            ...ROLES.map(([v, t]) => h('option', { value: v, textContent: t, selected: v === u.rol }))),
          uid !== yoUid && h('button', { className: 'peligro', textContent: 'Quitar', onclick: () => quitar(uid, u) })))));
  }

  async function quitar(uid, u) {
    if (!confirm(`¿Quitar a ${u.nombre} del negocio? No va a poder volver a entrar hasta que lo permitas de nuevo.`)) return;
    try {
      await db.ref('bloqueados/' + uid).set({ email: u.email, nombre: u.nombre }); // primero bloquear, así no puede volver a registrarse
      await db.ref('usuarios/' + uid).remove();
    } catch (x) { alert('No se pudo quitar: ' + x.message); }
  }

  function renderBloqueados(bs) {
    const l = Object.entries(bs);
    $('bloqueados').replaceChildren(...(l.length ? l.map(([uid, u]) =>
      h('div', { className: 'usr' }, h('span', { textContent: `${u.nombre} - ${u.email}` }),
        h('button', { textContent: 'Permitir de nuevo', onclick: () => db.ref('bloqueados/' + uid).remove().catch(x => alert(x.message)) })))
      : [h('p', { className: 'aviso', textContent: 'No hay accesos retirados.' })]));
  }

  // ---- Historial (solo dueño) ----
  let refHist = null;
  function abrirHistorial() {
    if (!esDueno()) return;
    vista('historial');
    $('h-lista').textContent = 'Cargando...';
    if (refHist) refHist.off();
    refHist = db.ref('movimientos').orderByChild('ts').limitToLast(100);
    refHist.on('value', s => {
      const l = [];
      s.forEach(c => { l.push(c.val()); });
      l.reverse();
      $('h-lista').replaceChildren(...(l.length ? l.map(m =>
        h('div', { className: 'mov' },
          h('span', { className: 'cuando', textContent: new Date(m.ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) }),
          h('span', { textContent: `${m.usuario} - ${m.producto} ${m.zona ? '(' + m.zona + ')' : '(total)'}` }),
          h('strong', { className: m.delta > 0 ? 'mas' : 'menos', textContent: (m.delta > 0 ? '+' : '−') + fmt(Math.abs(m.delta)) })))
        : [h('p', { className: 'aviso', textContent: 'Todavía no hay movimientos.' })]));
    }, e => { $('h-lista').textContent = 'No se pudo cargar el historial: ' + e.message; });
  }

  $('f-zona').onsubmit = e => {
    e.preventDefault();
    const n = $('n-zona').value.trim().toLowerCase();
    if (!nombreValido(n) || n === 'general') return alert('Nombre de zona no válido.');
    if (zonas.map(norm).includes(norm(n))) return alert('Esa zona ya existe.');
    db.ref('config/zonas').set([...zonas, n]).then(() => { $('n-zona').value = ''; }).catch(x => alert(x.message));
  };

  $('f-prod').onsubmit = e => {
    e.preventDefault();
    const n = $('n-prod').value.trim().toLowerCase();
    if (!nombreValido(n)) return alert('El nombre no puede tener . $ # [ ] /');
    if (productos[n]) return alert('Ese producto ya existe.');
    db.ref('productos/' + n).set({ categoria: $('n-cat').value }).then(() => { $('n-prod').value = ''; }).catch(x => alert(x.message));
  };
})();
