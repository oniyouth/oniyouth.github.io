# OniYouth — Estado del proyecto

## Stack
- Web: HTML/CSS/JS puro, sin frameworks
- Repo: oniyouth/oniyouth.github.io
- main = producción, sirve oniyouth.xyz vía GitHub Pages
- dev = rama de trabajo. Nada se mergea a main sin OK del dueño
- API: funciones serverless en Vercel (proyecto oniyouth-site, team juegomate1)
- BD: Supabase (proyecto oblekapcdajpueiteukv)
- Pagos: Mercado Pago Checkout Pro en modal. NADA de Payment Brick

## Reglas de negocio
- Envío S/12 a todo el país
- Gratis en compras > S/299 (estricto), calculado solo en el servidor
- Lima 2 días, provincias 4 días
- Satipo, Río Negro y Mazamari: contraentrega, envío gratis, 1 día
- Catálogo: solo los 2 productos reales. Los del template quedaron descartados

## Reglas técnicas innegociables
- Precios, stock, envío y cupones se recalculan SIEMPRE en el servidor
- RLS activo en todas las tablas
- service_role solo en /api, nunca en el frontend
- La anon key va hardcodeada en el frontend (es pública, la protege el RLS)
- CORS del /api solo a oniyouth.xyz
- Ninguna credencial en el código ni en el chat

## Fases completas (en dev)
1 Supabase (esquema + RLS)
2 Vercel
3 Catálogo desde Supabase
4 Carrito con localStorage y revalidación de stock
5 Envío y zonas
6 Cupones con validación server-side
7a API crear-preferencia con recálculo completo en servidor
8 Webhook (firma, consulta a MP, idempotencia por lock de fila)
10 Seguimiento público /pedido?codigo=

## Pendiente de aplicar en Supabase (en este orden)
1. migración 003_registrar_pago.sql
2. migración 004_zonas_envio.sql
3. seed 001_productos.sql
4. seed 002_zonas.sql
5. Poner stock real en las variantes

## Falta
- 7b: enganche con Checkout Pro (necesita credenciales TEST de MP)
- 9: notificaciones (necesita proveedor de correo)
- 11: panel admin
- 12: pruebas de pago
- 13/14/15: filtros y OG tags, animaciones, rendimiento
- Conectar el repo en Vercel para deploys por rama
- Decidir cómo queda el dominio: /api solo corre en Vercel, no en Pages

## Historial de decisiones
- Se descartó Payment Brick por Checkout Pro modal: menos superficie de error para el primer cobro
- Se hizo rollback de main tras publicar sin querer un catálogo vacío en producción. De ahí nació la rama dev
- Las deploy keys están bloqueadas por política de la organización. El push va por HTTPS con gh como credential helper
