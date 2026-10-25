# Terraza Stock

- `bot/` → bot de Telegram (Node.js) para desplegar en **Render**.
- `docs/` → panel web (HTML + CSS + JS) para **GitHub Pages** (Settings > Pages > Branch main > carpeta /docs).
- `firebase.rules.json` → reglas de seguridad de Firebase (pegar en Realtime Database > Reglas).

## Puesta en marcha (todo gratis)
1. **Revocar el token viejo** en @BotFather (`/revoke`) y quedarse con el nuevo.
2. **Firebase**: Authentication > Método de acceso > activar Google. Authentication > Configuración > Dominios autorizados > agregar `TU_USUARIO.github.io`. Pegar `firebase.rules.json` en las reglas y publicar.
3. **Panel**: completar `docs/config.js` (apiKey de Configuración del proyecto > Tus apps > Web). Subir a GitHub. **El primer Gmail que entre queda como dueño**: entrá vos primero.
4. **Cuenta de servicio** (para el bot): Configuración del proyecto > Cuentas de servicio > Generar clave privada. El contenido del JSON va en una sola línea en `FIREBASE_SERVICE_ACCOUNT`. Nunca lo subas a GitHub.
5. **Render**: New Web Service desde el repo, Root Directory `bot`, Build `npm install`, Start `npm start`. Cargar las variables de `bot/.env.example` (con `ALLOWED_IDS` completo: cada persona escribe `/id` al bot para saber el suyo).
6. Con webhook el bot registra solo su URL al iniciar. En el plan gratis Render duerme el servicio tras 15 min sin uso: el primer mensaje puede tardar ~1 minuto, pero Telegram reintenta y no se pierde. Para evitarlo, un monitor gratis (UptimeRobot) que visite la URL cada 5 min.

## Roles
- **Empleado**: suma y resta stock en las zonas. En "General" solo mira.
- **Dueño**: solo observa el stock (no puede modificarlo), ve el historial, aprueba usuarios, los quita del negocio y administra zonas y productos. Menú de tres puntos (arriba a la derecha): cuenta, historial y cerrar sesión.
- En el bot, los IDs de Telegram de los dueños van en `OBSERVER_IDS` (solo lectura) y los de los empleados en `ALLOWED_IDS`.
- Al quitar a alguien queda en "Accesos retirados" y no puede volver a registrarse hasta que el dueño lo permita.
- Si cambiás las reglas de Firebase, volvé a pegar `firebase.rules.json` (ahora incluye el índice del historial).
