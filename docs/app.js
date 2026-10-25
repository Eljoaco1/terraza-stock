(() => {
  firebase.initializeApp(APP_CONFIG.firebase);
  const auth = firebase.auth(), db = firebase.database();
  const $ = id => document.getElementById(id);
  const r2 = n => Math.round(n * 100) / 100;
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ROLES = [['pendiente', 'Pendiente (sin acceso)'], ['empleado', 'Empleado'], ['dueno', 'Dueño']];
  const ROL_TXT = { pendiente: 'Pendiente', empleado: 'Empleado', dueno: 'Dueño' };

  let nid = null, bar = '', yo = null, refYo = null, refHist = null;
  let productos = {}, zonas = ['barra', 'arriba'], stock = {}, zdata = {}, zonaSel = 'general';
  let escucha = false, escuchaDueno = false;
  const P = p => `negocios/${nid}/${p}`;
  const esDueno = () => !!yo && yo.rol === 'dueno';
  const esEmpleado = () => !!yo && yo.rol === 'empleado';

  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e[k] = v; }
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
  const sinPermiso = x => /permission/i.test(x.message || '');
  const vista = n => { ['login', 'elegir', 'pendiente', 'app', 'historial'].forEach(i => { $(i).hidden = i !== n; }); $('menu').hidden = n === 'login'; };

  // ---- Menú ----
  const cerrarSesion = () => auth.signOut().then(() => location.reload());
  function alternarMenu(abrir) { const l = $('menu-lista'), a = abrir ?? l.hidden; l.hidden = !a; $('menu-btn').setAttribute('aria-expanded', String(a)); }
  $('m-salir').onclick = cerrarSesion;
  $('menu-btn').onclick = e => { e.stopPropagation(); alternarMenu(); };
  document.addEventListener('click', e => { if (!$('menu').contains(e.target)) alternarMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') alternarMenu(false); });
  $('m-hist').onclick = () => { alternarMenu(false); abrirHistorial(); };
  $('h-volver').onclick = () => vista('app');
  $('entrar').onclick = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => alert('No se pudo entrar: ' + e.message));

  // ---- Entrada: dueño crea bar / empleado pide acceso ----
  auth.onAuthStateChanged(async u => {
    if (!u) { yo = null; vista('login'); return; }
    try { await entrarConCuenta(u); } catch (e) { alert('Error al entrar: ' + e.message); }
  });

  function mostrarElegir(msg) {
    const u = auth.currentUser;
    $('m-nombre').textContent = u.displayName || u.email; $('m-email').textContent = u.email; $('m-rol').textContent = 'Todavía sin bar';
    $('m-hist').hidden = true; $('titulo').textContent = 'Stock'; $('e-msg').textContent = msg || '';
    vista('elegir');
  }

  async function entrarConCuenta(u) {
    const per = (await db.ref('perfiles/' + u.uid).once('value')).val();
    if (!per || !per.negocio) return mostrarElegir();
    nid = per.negocio;
    if (!(await db.ref(P('miembros/' + u.uid)).once('value')).exists()) {
      await db.ref('perfiles/' + u.uid).remove(); nid = null;
      return mostrarElegir('Ya no pertenecés a ese bar. Podés pedir acceso a otro o crear el tuyo.');
    }
    const info = (await db.ref(P('info')).once('value')).val();
    bar = info ? info.nombre : nid;
    $('titulo').textContent = bar; document.title = bar + ' - Stock';
    refYo = db.ref(P('miembros/' + u.uid));
    refYo.on('value', s => {
      yo = s.val();
      if (!yo) { alert('El dueño retiró tu acceso.'); db.ref('perfiles/' + u.uid).remove().finally(() => location.reload()); return; }
      $('m-nombre').textContent = yo.nombre; $('m-email').textContent = yo.email;
      $('m-rol').textContent = `${ROL_TXT[yo.rol]} en ${bar}`; $('m-hist').hidden = !esDueno();
      if (yo.rol === 'pendiente') { $('p-bar').textContent = bar; vista('pendiente'); return; }
      if ($('historial').hidden) vista('app');
      iniciar(); render();
    });
  }

  async function crearBar(nombre) {
    const id = slug(nombre), u = auth.currentUser;
    if (id.length < 3 || id.length > 40) throw new Error('El nombre tiene que tener entre 3 y 40 letras o números.');
    try {
      await db.ref().update({
        [`negocios/${id}/info`]: { nombre: nombre.trim(), dueno: u.uid },
        [`negocios/${id}/miembros/${u.uid}`]: { email: u.email, nombre: u.displayName || u.email, rol: 'dueno' },
        [`perfiles/${u.uid}`]: { negocio: id }
      });
    } catch (x) { throw new Error(sinPermiso(x) ? 'Ya existe un bar con ese nombre. Probá con otro.' : x.message); }
    const prods = {};
    for (const [cat, lista] of Object.entries(window.PRODUCTOS_INICIALES || {})) lista.forEach(n => { prods[n] = { categoria: cat }; });
    await db.ref(`negocios/${id}/productos`).set(prods);
    await db.ref(`negocios/${id}/config/zonas`).set(['barra', 'arriba']);
  }

  async function pedirAcceso(nombre) {
    const id = slug(nombre), u = auth.currentUser;
    if (id.length < 3 || !(await db.ref(`negocios/${id}/info`).once('value')).exists()) throw new Error('No existe ningún bar con ese nombre. Revisá cómo lo escribió el dueño.');
    try { await db.ref(`negocios/${id}/miembros/${u.uid}`).set({ email: u.email, nombre: u.displayName || u.email, rol: 'pendiente' }); }
    catch (x) { throw new Error(sinPermiso(x) ? 'No se pudo enviar la solicitud. Puede que el dueño haya bloqueado esta cuenta.' : x.message); }
    await db.ref('perfiles/' + u.uid).set({ negocio: id });
  }

  const enviar = (fn, input) => async e => {
    e.preventDefault(); $('e-msg').textContent = 'Un momento...';
    try { await fn(input.value.trim()); await entrarConCuenta(auth.currentUser); }
    catch (x) { $('e-msg').textContent = x.message; }
  };
  $('f-crear').onsubmit = enviar(crearBar, $('n-bar'));
  $('f-unir').onsubmit = enviar(pedirAcceso, $('u-bar'));

  $('cancelar').onclick = async () => {
    try { refYo.off(); await db.ref(P('miembros/' + auth.currentUser.uid)).remove(); await db.ref('perfiles/' + auth.currentUser.uid).remove(); }
    catch (x) { alert(x.message); }
    location.reload();
  };

  function iniciar() {
    if (!escucha) {
      escucha = true;
      db.ref(P('productos')).on('value', s => { productos = s.val() || {}; render(); });
      db.ref(P('stock')).on('value', s => { stock = s.val() || {}; render(); });
      db.ref(P('zonas')).on('value', s => { zdata = s.val() || {}; render(); });
      db.ref(P('config/zonas')).on('value', s => { const v = s.val(); if (Array.isArray(v) && v.length) zonas = v; render(); });
    }
    if (esDueno() && !escuchaDueno) {
      escuchaDueno = true;
      db.ref(P('miembros')).on('value', s => renderUsuarios(s.val() || {}));
      db.ref(P('bloqueados')).on('value', s => renderBloqueados(s.val() || {}));
    }
  }

  // ---- Movimientos de stock ----
  async function ajustarRef(ref, delta) {
    let antes = 0;
    const t = await ref.transaction(c => { antes = typeof c === 'number' ? c : 0; return Math.max(0, r2(antes + delta)); });
    return r2(t.snapshot.val() - antes);
  }
  async function mover(p, zona, delta) {
    const aplicado = await ajustarRef(db.ref(P(`zonas/${zona}/${p}`)), delta);
    if (aplicado !== 0) {
      await ajustarRef(db.ref(P(`stock/${p}`)), aplicado);
      await db.ref(P('movimientos')).push({ usuario: yo.email, producto: p, zona, delta: aplicado, ts: firebase.database.ServerValue.TIMESTAMP, origen: 'panel' });
    }
  }
  async function cambiar(p, delta) {
    if (zonaSel === 'general') return alert('En General no se puede modificar. Elegí una zona.');
    if (!esEmpleado()) return alert('Tu cuenta no es de empleado, por eso no podés modificar el stock.');
    try { await mover(p, zonaSel, delta); }
    catch (e) { console.error(e); alert('No se pudo guardar: ' + e.message); }
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
    const filtro = norm($('buscador').value), porCat = {};
    Object.keys(productos).sort().filter(p => norm(p).includes(filtro)).forEach(p => { (porCat[productos[p].categoria || 'Otros'] ||= []).push(p); });
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
    $('count-ok').textContent = ok; $('count-zero').textContent = cero;
    $('admin').hidden = !esDueno();
    if (esDueno()) renderZonasAdmin();
  }
  $('buscador').oninput = render;

  // ---- Herramientas del dueño ----
  function renderUsuarios(ms) {
    const yoUid = auth.currentUser.uid, orden = { pendiente: 0, dueno: 1, empleado: 2 };
    $('usuarios').replaceChildren(...Object.entries(ms).sort((a, b) => orden[a[1].rol] - orden[b[1].rol]).map(([uid, u]) =>
      h('div', { className: 'usr' }, h('span', { textContent: `${u.nombre} - ${u.email}` }),
        h('div', { className: 'fila' },
          h('select', { ariaLabel: 'Rol de ' + u.nombre, disabled: uid === yoUid, title: uid === yoUid ? 'No podés cambiar tu propio rol' : '',
            onchange: e => db.ref(P(`miembros/${uid}/rol`)).set(e.target.value).catch(x => alert(x.message)) },
            ...ROLES.map(([v, t]) => h('option', { value: v, textContent: t, selected: v === u.rol }))),
          uid !== yoUid && h('button', { className: 'peligro', textContent: 'Quitar', onclick: () => quitar(uid, u) })))));
  }
  async function quitar(uid, u) {
    if (!confirm(`¿Quitar a ${u.nombre} del bar? No va a poder volver a pedir acceso hasta que lo permitas de nuevo.`)) return;
    try {
      await db.ref(P('bloqueados/' + uid)).set({ email: u.email, nombre: u.nombre });
      await db.ref(P('miembros/' + uid)).remove();
    } catch (x) { alert('No se pudo quitar: ' + x.message); }
  }
  function renderBloqueados(bs) {
    const l = Object.entries(bs);
    $('bloqueados').replaceChildren(...(l.length ? l.map(([uid, u]) =>
      h('div', { className: 'usr' }, h('span', { textContent: `${u.nombre} - ${u.email}` }),
        h('button', { textContent: 'Permitir de nuevo', onclick: () => db.ref(P('bloqueados/' + uid)).remove().catch(x => alert(x.message)) })))
      : [h('p', { className: 'aviso', textContent: 'No hay accesos retirados.' })]));
  }
  function renderZonasAdmin() {
    $('lista-zonas').replaceChildren(...zonas.map(z => {
      const hayStock = Object.values(zdata[z] || {}).some(v => v > 0);
      return h('div', { className: 'usr' }, h('span', { textContent: z + (hayStock ? ' (con stock)' : '') }),
        h('button', { className: 'peligro', textContent: 'Eliminar', onclick: () => eliminarZona(z, hayStock) }));
    }));
  }
  async function eliminarZona(z, hayStock) {
    if (hayStock) return alert(`"${z}" todavía tiene stock. Un empleado tiene que dejarla en 0 antes de poder eliminarla.`);
    if (zonas.length <= 1) return alert('Tiene que quedar al menos una zona.');
    if (!confirm(`¿Eliminar la zona "${z}"?`)) return;
    try { await db.ref(P('config/zonas')).set(zonas.filter(x => x !== z)); } catch (x) { alert('No se pudo eliminar: ' + x.message); }
  }
  $('f-zona').onsubmit = e => {
    e.preventDefault();
    const n = $('n-zona').value.trim().toLowerCase();
    if (!nombreValido(n) || n === 'general') return alert('Nombre de zona no válido.');
    if (zonas.map(norm).includes(norm(n))) return alert('Esa zona ya existe.');
    db.ref(P('config/zonas')).set([...zonas, n]).then(() => { $('n-zona').value = ''; }).catch(x => alert(x.message));
  };
  $('f-prod').onsubmit = e => {
    e.preventDefault();
    const n = $('n-prod').value.trim().toLowerCase();
    if (!nombreValido(n)) return alert('El nombre no puede tener . $ # [ ] /');
    if (productos[n]) return alert('Ese producto ya existe.');
    db.ref(P('productos/' + n)).set({ categoria: $('n-cat').value }).then(() => { $('n-prod').value = ''; }).catch(x => alert(x.message));
  };

  // ---- Historial (solo dueño) ----
  function abrirHistorial() {
    if (!esDueno()) return;
    vista('historial'); $('h-lista').textContent = 'Cargando...';
    if (refHist) refHist.off();
    refHist = db.ref(P('movimientos')).orderByChild('ts').limitToLast(100);
    refHist.on('value', s => {
      const l = []; s.forEach(c => { l.push(c.val()); }); l.reverse();
      $('h-lista').replaceChildren(...(l.length ? l.map(m =>
        h('div', { className: 'mov' },
          h('span', { className: 'cuando', textContent: new Date(m.ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) }),
          h('span', { textContent: `${m.usuario} - ${m.producto} ${m.zona ? '(' + m.zona + ')' : '(total)'}` }),
          h('strong', { className: m.delta > 0 ? 'mas' : 'menos', textContent: (m.delta > 0 ? '+' : '−') + fmt(Math.abs(m.delta)) })))
        : [h('p', { className: 'aviso', textContent: 'Todavía no hay movimientos.' })]));
    }, e => { $('h-lista').textContent = 'No se pudo cargar el historial: ' + e.message; });
  }
})();
