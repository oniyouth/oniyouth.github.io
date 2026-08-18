# OniYouth — Estado del proyecto

> Documento canónico de estado. Una sesión nueva debe poder retomar leyendo esto + `PLAN.md`.
> Última actualización: 2026-08-18 (Fase 9: notificaciones con Resend implementadas y desplegadas; falta que verifique el dominio para envío real).

## Stack
- Web: HTML/CSS/JS puro, sin frameworks.
- Repo: `oniyouth/oniyouth.github.io`. `main` = producción (sirve **oniyouth.xyz vía GitHub Pages**). `dev` = rama de trabajo. **Nada se mergea a `main` sin OK del dueño.**
- API: funciones serverless en **Vercel** (proyecto `oniyouth-site`, team `juegomate1`). `/api/*` SOLO corre en Vercel, NO en GitHub Pages.
- BD: **Supabase** (proyecto `oblekapcdajpueiteukv`).
- Pagos: **Mercado Pago Checkout Pro** en modal (SDK v2, `mp.checkout({preference:{id},autoOpen:true})`). NADA de Payment Brick.

## Reglas de negocio
- Envío S/12 a todo el país. Gratis en compras > S/299 (estricto), calculado SOLO en el servidor.
- Lima 2 días, provincias 4 días.
- Satipo, Río Negro y Mazamari: contraentrega, envío gratis, 1 día.
- Catálogo: solo los 2 productos reales (ONIYOUTH TRIBAL TEE y oniyouth stars). Tallas XS–XL.

## Reglas técnicas INNEGOCIABLES
- Precios, stock, envío y cupones se recalculan SIEMPRE en el servidor. Nada de lo que manda el navegador se cree.
- RLS activo en todas las tablas. Lectura pública solo de productos/variantes activos.
- `service_role` solo en `/api`, nunca en el frontend. La anon key va hardcodeada en el front (pública, protegida por RLS).
- CORS de `/api` solo a `oniyouth.xyz`.
- Ninguna credencial en el código ni en el chat.
- **Nada a `main` sin OK del dueño.** Trabajar siempre en `dev`.

## Fases completas (en `dev`)
- **1** Supabase (esquema + RLS)
- **2** Vercel (despliegue)
- **3** Catálogo desde Supabase (tallas/stock, agotados)
- **4** Carrito localStorage + revalidación de stock
- **5** Envío y zonas
- **6** Cupones (validación server-side)
- **7a** `/api/crear-preferencia` (recálculo completo en servidor)
- **7b** Enganche Checkout Pro: preferencia real de MP + modal. **PROBADO end-to-end.**
- **8** Webhook (`/api/webhook-mp`): firma, consulta a MP, idempotencia por lock de fila
- **10** Seguimiento público `/pedido?codigo=`
- **13** Filtros por categoría, meta tags Open Graph, multi-imagen en quick view

## Pago end-to-end — PROBADO (2026-08-18)
Flujo confirmado con datos reales: **pago aprobado en MP → webhook recibido → firma validada (HMAC-SHA256) → `registrar_pago_pedido` → pedido `pagado` → stock descontado atómicamente**. Verificado: pedido `ONI-5CA0A3F3` quedó `pagado` y la variante *oniyouth stars / XS* bajó 10→9.

### Cómo probar pagos (procedimiento, NO cambiar código)
- **URL estable de pruebas:** `https://oniyouth-dev.vercel.app` — es un **alias de Vercel** fijo (NO la URL con hash `oniyouth-site-<hash>-juegomate1.vercel.app`, que cambia en cada `vercel deploy`). Tras cada redeploy hay que re-apuntar el alias a la nueva deployment (por API con el token del CLI; no cambia la URL).
- Abrir el sitio **desde esa URL de Vercel** (no desde oniyouth.xyz), porque `/api` solo existe en Vercel y el `fetch` es relativo (mismo origen → sin CORS).
- **Webhook registrado en el panel de MP** con URL `https://oniyouth-dev.vercel.app/api/webhook-mp` y el **evento "Pagos" marcado**. ⚠️ **Sin ese evento no llega ninguna notificación** — fue la causa de un bloqueo largo.
- **Pagar en flujo de INVITADO, SIN iniciar sesión** con cuenta de prueba. Con login MP corta con "Algo salió mal — una de las partes es de prueba" (mezcla test/prod).
- **Tarjeta de prueba (Perú):** `5031 7557 3453 0604`, venc. `11/30`, CVV `123`, titular `APRO`, DNI `12345678`.
- Se usa **`init_point`** (NO `sandbox_init_point`, que es el flujo sandbox viejo/deprecado y da `ERR_TOO_MANY_REDIRECTS`).

### Diagnóstico y observabilidad del webhook
- El webhook (`api/webhook-mp.js`) ahora **loguea**: entrada (`hit` con tipo/data.id/hasSig), **resultado de la firma con el `manifest` exacto**, longitudes del secret (`secret_len` vs `secret_raw_len`, para detectar espacios/newline — NUNCA el secreto en sí), `hmac` vs `v1`, estado del pago y resultado del RPC.
- Blindaje: `firmaValida` hace `secret.trim()` (mata whitespace del env var, causa #1 de firmas que no matchean).
- Para leer logs: `vercel logs https://oniyouth-dev.vercel.app --json` — el desenlace completo por invocación viene en el campo `logs[]` de cada evento, y el status HTTP en `responseStatusCode`.
- El manifest de la firma es `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (coincide con el template oficial de MP). MP manda además notificaciones `merchant_order` que se ignoran con 200.

## Fase 11 — Panel de administración (CÓDIGO LISTO · desplegado en preview · falta activar)
Panel en `admin.html` (SPA vanilla, sin dependencias) servido desde el deploy de Vercel: **`https://oniyouth-dev.vercel.app/admin.html`**. Pantallas: Resumen, Productos, Stock, Pedidos, Cupones, Envíos.

**Cómo se protege (4 candados):**
1. **Login** email+password con Supabase Auth (fetch crudo a `/auth/v1/token`). El **registro público debe estar DESACTIVADO** en Supabase → solo existe tu usuario.
2. **Allowlist por email** en el servidor: `api/_lib/auth.js → requireAdmin()` valida el token contra `/auth/v1/user` (usa la service key como `apikey`) y exige `email === ADMIN_EMAIL`. Env var `ADMIN_EMAIL` = `chocolatitoprueba4@gmail.com` (cargada en **Preview**; falta en Production para cuando se pase a prod).
3. **RLS sigue cerrado**: NO se abrieron políticas de escritura para `authenticated`. Todo se escribe con `service_role` desde `api/admin.js`, y ese endpoint está tapado por el candado 2. Un token filtrado no sirve por sí solo.
4. **Same-origin**: el panel se sirve del mismo deploy que `/api`, así que `api/admin.js` NO abre CORS (un origen ajeno queda bloqueado por defecto).

**Backend:** un solo endpoint router `api/admin.js` (`?r=<recurso>` + método), recursos: `resumen`, `productos`, `variantes`, `pedidos`, `cupones`, `zonas`. Todo recalculado/saneado en servidor. Imágenes: subida directa del navegador a Storage (bucket público `productos`), autorizada por política que exige el JWT del admin. Verificado con 24 tests node mockeados (guard + cada recurso) y smoke test en vivo (sin token→401, token falso→401).

**PENDIENTE PARA ACTIVARLO (pasos manuales, requieren acceso a Supabase):**
- **(a) Aplicar migración `supabase/migrations/005_panel_admin.sql`** (RPC `resumen_admin`, índice de pedidos, bucket Storage `productos` + políticas de subida). Sin esto: la pestaña Resumen y la subida de imágenes fallan; el resto funciona. ⚠️ El email en la política de Storage debe coincidir con `ADMIN_EMAIL`.
- **(b) Crear el usuario admin** en Supabase → Authentication → Users → Add user: `chocolatitoprueba4@gmail.com` + contraseña + Auto Confirm. Y **desactivar** "Allow new users to sign up".
- Tras (a) y (b): entrar a `oniyouth-dev.vercel.app/admin.html` y probar cada pantalla.

## Fase 12 — Pruebas de pago (AUTOMATIZADAS EN VERDE · faltan 2 E2E de navegador)
Fase 12 es **verificación, no código nuevo**: el comportamiento ya estaba implementado (webhook + RPCs). Tests en `scratchpad` de la sesión: `test_webhook.js`, `test_live_server.js`, `test_live_stock.js`. **29 asserts, todos pasan (2026-08-18).**

**Webhook (11 tests mockeados, cero efecto en BD):**
- **Rechazado/cancelled** → `PATCH estado='rechazado'` SOLO si estaba `pendiente`; NUNCA descuenta stock (`webhook-mp.js:137`).
- **Pendiente/in_process** → 200 sin cambios, queda `pendiente`.
- **Duplicado** → doble candado: (1) `payment_id` ya aplicado → 200 sin llamar al RPC (`:110`); (2) el RPC `registrar_pago_pedido` devuelve `'duplicado'` (lock + chequeo `estado`).
- **Firma** HMAC-SHA256: secreto malo o `v1` forjado → 401 sin tocar la BD.

**Servidor en vivo (10 tests contra `/api/crear-preferencia`, sin tocar stock, crean pedidos `pendiente`):**
- **Envío gratis > S/299** lo calcula el servidor (4u=S/359.96→envío 0; 1u→envío 12).
- **No manipulable**: precio en el ítem, y `subtotal`/`descuento`/`envio`/`total` de nivel superior son IGNORADOS; usa la BD.
- **Cupón** inexistente → 409 `cupon` (lo valida el servidor, no el navegador).

**Stock en vivo (8 tests, SÍ consumen stock — vía zona contraentrega):**
- **Contraentrega**: crea pedido sin pago online (`ok+contraentrega=true`, sin `init_point`) y reserva stock al instante (-1). Pedido `ONI-D7B09897`.
- **Carrera**: 2 pedidos concurrentes por TODO el stock (8u c/u) → exactamente 1 gana (`ONI-FB383A55`, 8→0), el otro 409 `stock`. Stock final 0, nunca negativo (lock de fila de `descontar_stock_pedido`).

**RESIDUO DE PRUEBAS — YA LIMPIADO (2026-08-18, vía psql con la cadena de `~/.oniyouth_db.url`, borrada al terminar):**
- Stock repuesto: `oniyouth stars / XS` y `ONIYOUTH TRIBAL TEE / S` **de vuelta a 10**.
- Los 5 pedidos de prueba (`cliente_nombre='QA Bot'`: 3 `pendiente` + 2 `contraentrega` incl. `ONI-D7B09897`/`ONI-FB383A55`) quedaron **`cancelado`**. El perdedor de la carrera no dejó pedido (falló en el pre-check de stock antes de crearlo).

**E2E reales de navegador — HECHOS y verificados por logs (2026-08-18):**
Ambos cayeron sobre el mismo pedido `ONI-80BE2001` (se reusó el checkout para las 2 tarjetas; MP adjunta varios pagos a la misma preferencia):
- **OTHE** → MP devolvió pago `1350507981` `status=rejected` / `status_detail=cc_rejected_other_reason` → webhook marcó `rechazado`. ✅ Correcto (MP lo rechazó de verdad).
- **CONT** → MP devolvió pago `1350507989` `status=in_process` / `status_detail=pending_contingency` → webhook hizo **"estado sin acción"**, NO lo tocó. ✅ Correcto.
- **Conclusión:** el pedido quedó `rechazado` por el pago OTHE (rechazo real de MP), NO por marcar mal el pending. El manejo de pending es correcto (el log lo prueba en vivo). **No es bug.**
- **Stock:** las 10 variantes en 10/10; ni el rechazado ni el pendiente descuentan (solo `approved` descuenta). ✅
- Para ver el pending "limpio" (queda `pendiente`): comprar CON `CONT` en un checkout NUEVO, sin un OTHE previo.

**"Rechazado que revive a pagado" — IMPLEMENTADO (migración 006 aplicada + desplegado, 2026-08-18):** si un pedido `rechazado`/`cancelado` recibe luego un `approved` de un intento paralelo, se marca `pagado` normalmente (cliente pagó → se atiende) PERO se enciende `pedidos.requiere_revision` con `revision_motivo`, y se avisa distinto. Detección atómica en `registrar_pago_pedido` (bajo el `for update`): si el estado previo era rechazado/cancelado devuelve `'revivido'`. El webhook loguea `[webhook-mp] REVIVIDO … REVISAR` y usa `dispararNotificaciones(pedido,'pagado_revivido')` (hook para Fase 9). En el panel: badge **⚠ Revisar** en la lista, filtro "Solo revisar", banner con motivo en el detalle y botón "Marcar como revisado" (`PATCH requiere_revision=false`). Cubierto por tests (webhook 12/12, admin 26/26).

## Fase 9 — Notificaciones con Resend (IMPLEMENTADA + desplegada; falta verificar dominio para envío real)
Correos transaccionales desde el **dominio propio** (`pedidos@oniyouth.xyz`) vía **Resend** (fetch crudo, sin SDK).
- **`api/_lib/mailer.js`** (nuevo): `sendEmail()` (POST a `api.resend.com/emails`, `Authorization: Bearer RESEND_API_KEY`, timeout 6s, **NUNCA lanza** → `{ok:false}`), plantillas HTML+texto, y `notificarPago(pedido,tipo)` / `notificarContraentrega(pedido)` (cada envío aislado con `Promise.allSettled`).
- **`webhook-mp.js`**: `dispararNotificaciones` llama a `notificarPago` (tipos `pagado`/`pagado_revivido`/`stock_error`); se amplió el `select` del pedido para el correo al admin.
- **`crear-preferencia.js`**: contraentrega llama a `notificarContraentrega`, envuelto en try/catch para no romper el alta.
- **Config (sin env vars nuevas):** `MAIL_FROM` default `OniYouth <pedidos@oniyouth.xyz>`; `NOTIFY_ADMIN_EMAIL` cae a `ADMIN_EMAIL` (= `chocolatitoprueba4@gmail.com`, que es también el Reply-To de los correos al cliente); `SITE_URL` default `https://oniyouth.xyz` (link de seguimiento); `MAIL_LOGO_URL` default = URL pública del logo en el bucket Supabase (`.../productos/logo-oniyouth.png`).
- **Diseño (rediseñado para heredar la tienda):** fondo negro de punta a punta, logo del toro (O con cuernos) centrado y solo, eyebrows en mayúsculas con tracking (como el `.sub` de `pedido.html`), un solo botón blanco sin bordes, hairlines tenues, sin emojis, mucho aire. Admin más seco (datos + enlace, sin botón). Email-safe: tablas + estilos en línea + `bgcolor` + `color-scheme:dark` (aguanta Gmail móvil; si un cliente ignora el fondo, el `bgcolor` de celdas mantiene el negro). Fuente: Helvetica/Arial (Syne no carga en email; el carácter va en el tratamiento). **Logo blanco generado** en `assets/images/logo-email.png` (375×564, hecho con códec PNG en Python puro porque no había PIL/ImageMagick).
- **Matriz:** pagado → cliente "confirmado" + admin "nueva venta"; revivido → cliente igual + admin ⚠ "REVISAR"; sin-stock → cliente "recibimos tu pago" (suave) + admin ⚠ "PAGADO SIN STOCK"; contraentrega → cliente "pagás al recibir" + admin "coordinar". Rechazado/pendiente → nada. Si el pedido no tiene `cliente_email`, se omite el del cliente sin error.
- **ROBUSTEZ (requisito del dueño):** el correo es best-effort, va DESPUÉS de marcar pagado; si Resend falla/timeout/dominio sin verificar → log + se traga el error, webhook responde 200, pedido sigue `pagado`. Probado: webhook 14/14 (incluye "Resend 500 → 200"), mailer 11/11, admin 26/26.
- **PENDIENTE:** (1) que **Resend verifique `oniyouth.xyz`** (registros en Hostinger, puede tardar horas) → recién ahí salen correos reales; luego probar un envío end-to-end. (2) **Subir el logo** `assets/images/logo-email.png` al bucket público `productos` de Supabase como `logo-oniyouth.png` (para que `MAIL_LOGO_URL` resuelva). NO se pudo hacer por API (la subida a Storage necesita service_role/token de admin y no se materializa la key); hacerlo desde el dashboard de Supabase o aprobar la subida. Como ningún correo real sale hasta que verifique el dominio, no hay imagen rota en vivo mientras tanto. `NOTIFY_ADMIN_EMAIL`/`ADMIN_EMAIL` solo en Preview (falta en Production). `RESEND_API_KEY` ya en Preview+Prod.

## Falta (fases pendientes)
- **9** ✅ Implementada y desplegada. Solo falta el envío real cuando el dominio verifique en Resend + una prueba end-to-end.
- **12** ✅ Verificada (29 asserts + 2 E2E por logs) y "revivido" implementado (migración 006).
- **14** Animaciones (fade-in scroll, hover, vuelo a la bolsa; respetar `prefers-reduced-motion`).
- **15** Rendimiento y accesibilidad (WebP, lazy, teclado, contraste, móvil).

## Pendientes de DECISIÓN
- **Dominio:** `/api` solo corre en Vercel, pero `oniyouth.xyz` sigue en GitHub Pages. Hay que decidir cómo queda (mover todo el sitio a Vercel, o apuntar el dominio a Vercel, o un subdominio para la API). Hoy las pruebas viven en el alias de Vercel.

## Pendientes de SEGURIDAD antes de producción
- **Rotar las credenciales que se expusieron** durante las pruebas (revisar y regenerar lo que haya quedado a la vista).
- **Volver a activar Deployment Protection** (Vercel Authentication) cuando terminen las pruebas — se desactivó (`ssoProtection=null`) para que MP pudiera postear al webhook y para poder probar en incógnito.
- **Cambiar a credenciales de PRODUCCIÓN de MP** (hoy se usa la Public Key `TEST-…` y el access token de prueba). Al pasar a prod: token + public key productivos, y re-registrar el webhook productivo con su secreto.

## Historial de decisiones
- Checkout Pro modal (no Payment Brick): menos superficie de error para el primer cobro.
- Rollback de `main` tras publicar sin querer un catálogo vacío en producción → de ahí nació `dev`.
- Deploy keys bloqueadas por política de la organización. El push va por HTTPS con `gh` como credential helper.
- URL estable vía alias de Vercel para no perseguir el hash del deploy en cada redeploy (rompía el registro del webhook).
