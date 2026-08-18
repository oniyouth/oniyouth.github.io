# OniYouth — Estado del proyecto

> Documento canónico de estado. Una sesión nueva debe poder retomar leyendo esto + `PLAN.md`.
> Última actualización: 2026-08-18 (pago end-to-end probado).

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

## Falta (fases pendientes)
- **9** Notificaciones automáticas (correo al cliente + aviso al admin). Necesita **proveedor de correo**.
- **11** Panel de administración (Supabase Auth; productos/stock/pedidos/cupones).
- **12** Pruebas de pago completas (aprobado/rechazado/pendiente, stock en carrera, webhook duplicado).
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
