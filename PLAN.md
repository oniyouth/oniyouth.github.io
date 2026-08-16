# PLAN — OniYouth

**PROYECTO:** OniYouth — tienda de streetwear automatizada.
**Dominio:** oniyouth.xyz
**Stack:** web + API en Vercel, base de datos Supabase, pagos Mercado Pago Checkout Pro (modal). JS puro, sin frameworks.

## REGLAS PARA TODA LA SESIÓN
- Nada de frameworks nuevos.
- Al terminar cada fase PARA y avísame. No encadenes fases.
- Antes de escribir código en una fase, muéstrame el plan y espera visto bueno.
- Pregunta antes de asumir.
- Ninguna credencial en el código ni en el chat. Todo en variables de entorno. Si ves una en un commit, paras todo.

## FASE 1 — Base de datos (Supabase)
Tablas:
- **productos:** id, nombre, descripción, precio, categoría, imágenes[], activo, orden
- **variantes:** id, producto_id, talla, stock, sku
- **pedidos:** id, código, preference_id, payment_id (UNIQUE), estado, items (jsonb), subtotal, envío, descuento, total, cliente (nombre, teléfono, email), dirección, distrito, creado_en
- **cupones:** código (UNIQUE), tipo, valor, usos_máx, usos, vence_en, activo
- **distritos:** nombre, costo_envío, días_estimados

Reglas:
- Row Level Security ACTIVADO en todas.
- Lectura pública SOLO de productos/variantes activos.
- pedidos y cupones: sin acceso público. Solo service_role.
- Función SQL para descontar stock de forma atómica (que dos compras simultáneas no vendan la misma última talla).

## FASE 2 — Migrar la web a Vercel
- Conectar el repo, desplegar con cada push.
- Apuntar oniyouth.xyz a Vercel.
- Verificar que todo se vea igual antes de seguir.

## FASE 3 — Productos desde la base de datos
- La grilla y el quick view leen de Supabase con la anon key (solo lectura, protegida por RLS).
- Tallas sin stock: tachadas y no clickeables.
- Producto agotado completo: badge y al final de la grilla.

## FASE 4 — Carrito
- Persistente con localStorage.
- Validar stock al abrir la bolsa (no vale guardar algo agotado hace tres días).

## FASE 5 — Envío
- Selector de distrito de Lima con su costo, desde la tabla.
- Formulario de dirección, teléfono y referencia.
- El total se recalcula con el envío.

## FASE 6 — Cupones
- Campo de cupón en la bolsa.
- Validación SIEMPRE en el servidor. El navegador no aplica descuentos.

## FASE 7 — API de pagos
- **/api/crear-preferencia:**
  - Recalcula TODO en el servidor: precios, stock, envío, cupón. Nada de lo que manda el navegador se cree.
  - Rechaza si alguna talla ya no tiene stock.
  - Crea el pedido en estado "pendiente" y la preferencia en MP.
- CORS: solo https://oniyouth.xyz.

## FASE 8 — Webhook
- Valida la firma de MP.
- Consulta el pago a la API de MP; no confía en la notificación.
- Si el payment_id ya existe, responde 200 y no hace nada.
- Pago aprobado: descuenta stock con la función atómica, pasa el pedido a "pagado", dispara las notificaciones.
- Pago rechazado: marca el pedido y libera lo reservado.

## FASE 9 — Notificaciones automáticas
- Al cliente: correo con su código de pedido y el detalle.
- A mí: WhatsApp o correo con el pedido nuevo.
- Al cambiar de estado: aviso al cliente.

## FASE 10 — Seguimiento del pedido
- Página pública /pedido?codigo=XXXX
- Muestra estado, items y fecha estimada. Sin login.

## FASE 11 — Panel de administración
- Login con Supabase Auth. Solo mi usuario.
- Productos: crear, editar, subir imágenes, activar/desactivar.
- Stock por talla, editable.
- Pedidos: lista, detalle, cambiar estado.
- Cupones: crear y desactivar.
- Resumen simple: ventas del mes, productos más vendidos.

## FASE 12 — Pruebas de pago
- Credenciales y usuarios de prueba de MP.
- Probar aprobado, rechazado, pendiente.
- Probar stock: dos compras de la última unidad a la vez.
- Probar webhook duplicado.
- NO se pasa a producción hasta que todo esto pase.

## FASE 13 — Funcionalidad de tienda
- Filtros por categoría.
- Multi-imagen en quick view con flechas.
- Meta tags Open Graph.
- Decidir qué hacer con el password gate (hoy no protege nada).

## FASE 14 — Animaciones
- Fade-in al scroll (Intersection Observer).
- Hover: zoom suave y cambio a imagen trasera.
- Al agregar a la bolsa: miniatura que vuela + rebote del contador.
- Bolsa y modal con slide y fondo desenfocado.
- Respetar prefers-reduced-motion.

## FASE 15 — Rendimiento y accesibilidad
- Imágenes a WebP con fallback y lazy loading.
- Medir antes y después, mostrarme números.
- Teclado, foco visible, contraste.
- Probar todo en móvil.

## ANTES DE PRODUCCIÓN
- Ninguna credencial en el repo.
- RLS verificado tabla por tabla.
- service_role solo en /api.
- Un pago real de prueba con monto bajo, de punta a punta.
