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

## Fase 14 — Animaciones (IMPLEMENTADA + desplegada, 2026-08-18)
En `index.html`, aditivo y con guard de `prefers-reduced-motion`:
- **Reveal al scroll** vía `IntersectionObserver` (`oniObserveReveals`): la cabecera de colección sube (`.reveal`), las product-card aparecen por opacidad (`.reveal-fade`, para NO pelear con el hover `translateY(-8px)` que ya existía). `.shop-page` usa `visibility:hidden` (no display:none) → el observer evalúa geometría bien.
- **Hover**: ya existía (lift de card + zoom de imagen + overlay); se conservó.
- **Vuelo a la bolsa** (`oniFlyToCart`): al Agregar, clona `#pdMainImg` y lo vuela hasta `#cartBtnDetail` (FLIP con getBoundingClientRect), + `oniBumpCart` (keyframe `oni-cart-bump`) que rebota el ícono. Cleanup por `transitionend` + timeout.
- **`prefers-reduced-motion: reduce`**: media query que apaga reveal/bump/fly, y los `oni*` chequean `ONI_REDUCED` para saltar el vuelo (revela todo al instante).
- Verificado: `node --check` del script inline OK. Falta review visual en el deploy.

## Correo de prueba (panel, Fase 9)
Botón en Resumen del panel → `POST /api/admin?r=test-email` → `mailer.enviarPrueba(to)` manda un ejemplo (cliente + admin) al destino o al `ADMIN_EMAIL`. Falla suave hasta que el dominio verifique en Resend. Tests: admin 28/28.

## Fase 15 — Rendimiento y accesibilidad (IMPLEMENTADA + desplegada, 2026-08-18)
**WebP con fallback + lazy:** todas las imágenes convertidas a WebP con `sharp` (fotos q80; logos/íconos lossless) — los originales quedan como fallback. Hero y grid usan `<picture><source type="image/webp"><img …fallback></picture>`; el detalle y thumbnails usan WebP con `onerror`→original (`setPdImg`, `oniPicture`, `oniWebp` en index.html). Lazy: grid ya lazy; hero slide 1 (LCP) `fetchpriority="high"` + eager, slides 2–4 `loading="lazy"`; thumbnails lazy.
- **Números (medido con `sharp` + `du`):** TODAS las imágenes **4824 KB → 1012 KB (-79%)**. Imágenes core del home (4 hero + logo + ícono + 2 fronts de producto) **~2966 KB → ~337 KB (-89%)**. Hero-slide-4 1263KB→43KB (-97%), hero-slide-3 1111KB→41KB (-96%). Con lazy, el crítico inicial baja aún más (solo hero-bg.webp ~40KB con prioridad alta).
- **Accesibilidad:** `:focus-visible` con anillo blanco (negro en tema claro) global + en product-card; **product-card ahora operables por teclado** (`role="button"` + `tabindex="0"` + `aria-label` + `onkeydown` Enter/Espacio → `oniCardKey`). **Contraste:** `--text3` subido para pasar AA (dark `#555`→`#7a7a7a` ≈4.8:1; light `#aaa`→`#6f6f6f` ≈5.1:1).
- **sharp** se instaló vía npm en scratchpad (v0.35.3; binario precompilado); no quedó en el repo.
- **PENDIENTE:** review visual en móvil (no hay navegador headless en el entorno — verificar en el teléfono: LCP, foco por teclado, que no haya scroll horizontal).
- **`pedido.html` — pase de accesibilidad HECHO:** `:focus-visible`, logo a WebP, y contraste AA (`.sub` 0.35→0.5, `.date`/`.item .m`/`.back` 0.4→0.55, `.step .lbl` 0.32→0.5, placeholder 0.3→0.5). Los elementos interactivos (buscador, link volver) ya eran nativos/accesibles.

## Falta (fases pendientes)
- **9** ✅ Implementada y desplegada. Solo falta el envío real cuando el dominio verifique en Resend + prueba end-to-end (ya hay botón de prueba en el panel).
- **12** ✅ Verificada (29 asserts + 2 E2E por logs) y "revivido" implementado (migración 006).
- **14** ✅ Implementada y desplegada (falta review visual).
- **15** ✅ Implementada y desplegada (WebP -79%, lazy, foco por teclado, contraste AA). Falta review visual en móvil + pase de foco/contraste a pedido.html.

## Camino a producción (dominio DECIDIDO: Opción A)
**Opción A elegida (2026-08-18):** mover TODO a Vercel y apuntar `oniyouth.xyz` a Vercel; GitHub Pages queda fuera. El código ya asume same-origin (`fetch('/api')` relativo).
- **CORS parametrizado:** `_lib/store.js` `ALLOWED_ORIGIN = process.env.SITE_ORIGIN || 'https://oniyouth.xyz'`; `pedido.js` ya lo importa de store (se dedupe). `SITE_URL` (correos) ya era env-driven con default `oniyouth.xyz`. Con same-origin el CORS ni se dispara, pero queda correcto.
- **DNS a poner en Hostinger (en el cutover, aún NO):** A `@` → `76.76.21.21`; CNAME `www` → `cname.vercel-dns.com`. Quitar los A de GitHub Pages (185.199.108–111.153) y el CNAME `www`→`oniyouth.github.io` si existe. NO tocar los registros de Resend (`send`/`resend._domainkey`/`_dmarc`) ni el MX del correo. Vercel confirma los registros exactos al agregar el dominio en Settings→Domains.
- **Deployment Protection (postura definida, se aplica en el cutover):** Producción **pública** (clientes + webhook MP); Preview **protegida**. NO se cambió aún para no romper el testing actual en el alias de preview.
### CUTOVER EN CURSO (2026-08-18) — frenado antes del DNS a pedido del dueño
- **Pasos 1-4 HECHOS y verificados:** env de Production completa (`ADMIN_EMAIL` + MP prod token/secret Sensitive + SUPABASE/RESEND); **Public Key productiva** `APP_USR-e207152a-6de8-417a-aea9-ffbd74af3329` en `index.html` (commit `6736948`); **desplegado a Producción de Vercel** (`vercel deploy --prod`, NO tocó main ni DNS). **URL estable de prod:** `https://oniyouth-site.vercel.app`. Verificado ahí: home 200, Public Key productiva servida, logo WebP, guard admin OK (ADMIN_EMAIL presente), webhook 405, y **`crear-preferencia` crea preferencia con `init_point` de `mercadopago.com.pe` → MODO PRODUCCIÓN confirmado**. Pedido de prueba `ONI-D595550A` (pendiente, "QA PROD") quedó en la BD — **cancelar desde el panel** (no tocó stock).
- **Ojo env:** `MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET` figuran en "Preview, Production"; confirmar que Preview no quedó con el token productivo (para no cobrar en previews).
- **Paso 5 (DNS + dominio) HECHO (2026-08-18):** dueño aplicó el DNS en Hostinger (borró A de Pages; puso A `@`→76.76.21.21, CNAME `www`→cname.vercel-dns.com; Resend intacto). Agregué `oniyouth.xyz`+`www` en Vercel → `verified:True` sin pedir valores distintos. **`oniyouth.xyz` YA SIRVE DESDE VERCEL** (HTTP 200 server:Vercel, SSL válido, Public Key APP_USR, `/api/webhook-mp` GET→405). El webhook productivo registrado ya resuelve.
- **FALTA (con OK del dueño, en orden):** Paso 6 = compra real chica en `oniyouth.xyz` + verificar por logs el webhook prod (pago→pagado→stock→correo real). Paso 7 = **merge dev→main (ya seguro, DNS en Vercel)** + desactivar GitHub Pages en el repo + Deployment Protection (prod pública / preview protegida). Rotar credenciales de prueba. Opcional: redirect canónico www→apex (hoy www sirve 200 directo). Cancelar pedido QA `ONI-D595550A`.

### Ajustes post-lanzamiento (2026-08-18)
- **Webhook: IPN legacy silenciada.** MP manda cada evento por 2 canales (Webhook moderno firmado `type`/`data.id` = AUTORITATIVO, e IPN legacy `topic`/`id` que no valida contra la firma → antes daba 401 y MP reintentaba). `webhook-mp.js` ahora **ignora con 200 la IPN legacy** (`esIPNLegacy = query.topic && !query.type`). Verificado en prod: 3+ pagos rechazados reales (`cc_rejected_high_risk`) recibidos, firma validada, pedido→`rechazado`, stock intacto (los 401 eran solo las IPN duplicadas). Test webhook 16/16.
- **Pantalla propia de pago rechazado — EN PRODUCCIÓN:** `crear-preferencia.js` `back_urls.failure` → `/?pago=rechazado&codigo=`. `index.html` muestra overlay con estética de la tienda: eyebrow rojo "PAGO NO COMPLETADO", título Syne "No pudimos procesar tu pago", mensaje, botón blanco **"Reintentar con otro medio"** → `openCart()`, y **"Volver a la tienda"**. Carrito preservado (localStorage). **Link de WhatsApp QUITADO** a pedido del dueño (ya no hay `WHATSAPP_NUMERO`). Verificado en móvil-friendly (box max-width 420, botón full-width). Se ve en `oniyouth.xyz/?pago=rechazado`.
- **Secreto de webhook productivo NUEVO — VERIFICADO (2026-08-18):** el dueño actualizó `MP_WEBHOOK_SECRET` en Production (MP lo regeneró al guardar la URL prod del webhook). Se hizo `vercel deploy --prod` (necesario para que la función tome la env nueva). Confirmado con un **reenvío de prueba desde el panel de MP** (payment.updated, data.id 174501909568): log **`FIRMA ok=True, secret_len=64, secret_raw_len=64`** → firma válida con el secreto nuevo, sin whitespace. El webhook prod valida bien.

## Pendientes de SEGURIDAD antes de producción
- **Rotar las credenciales que se expusieron** durante las pruebas (revisar y regenerar lo que haya quedado a la vista).
- **Volver a activar Deployment Protection** (Vercel Authentication) cuando terminen las pruebas — se desactivó (`ssoProtection=null`) para que MP pudiera postear al webhook y para poder probar en incógnito.
- **Cambiar a credenciales de PRODUCCIÓN de MP** (hoy se usa la Public Key `TEST-…` y el access token de prueba). Al pasar a prod: token + public key productivos, y re-registrar el webhook productivo con su secreto.

## Historial de decisiones
- Checkout Pro modal (no Payment Brick): menos superficie de error para el primer cobro.
- Rollback de `main` tras publicar sin querer un catálogo vacío en producción → de ahí nació `dev`.
- Deploy keys bloqueadas por política de la organización. El push va por HTTPS con `gh` como credential helper.
- URL estable vía alias de Vercel para no perseguir el hash del deploy en cada redeploy (rompía el registro del webhook).
