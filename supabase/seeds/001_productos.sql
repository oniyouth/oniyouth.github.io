-- ============================================================
-- OniYouth · Seed FASE 3 — Productos y variantes
-- Generado a partir del catálogo del index.html (2 productos).
--
-- Ejecutar en:  Supabase Dashboard → SQL Editor  (o psql con la
-- cadena de conexión). Requiere service_role / owner: escribe en
-- productos y variantes (RLS no aplica al owner de la conexión).
--
-- Stock inicial = 0 en TODAS las variantes. Ajustar el stock real
-- después desde el panel de Supabase.
--
-- Idempotente: los productos se insertan por nombre solo si no
-- existen; las variantes usan ON CONFLICT (producto_id, talla).
-- Se puede volver a correr sin duplicar.
-- ============================================================

-- ---------- PRODUCTO 1: ONIYOUTH TRIBAL TEE ----------
insert into public.productos (nombre, descripcion, precio, categoria, imagenes, activo, orden)
select
  'ONIYOUTH TRIBAL TEE',
  E'T-shirt 100% cotton 20/1\nEstampado DTG ESTRIBAL "ONIYOUTH"',
  89.99,
  'T-shirt',
  array[
    'assets/images/product-oneoniyouth-front.png',
    'assets/images/product-oneoniyouth-back.png'
  ],
  true,
  1
where not exists (
  select 1 from public.productos where nombre = 'ONIYOUTH TRIBAL TEE'
);

-- ---------- PRODUCTO 2: oniyouth stars ----------
insert into public.productos (nombre, descripcion, precio, categoria, imagenes, activo, orden)
select
  'oniyouth stars',
  E'T-shirt 100% cotton 20/1\nEstampado DTG ESTRIBAL en la espalda y en el pecho "ONIYOUTH STARS"',
  89.99,
  'T-shirt',
  array[
    'assets/images/product-oniyouthstars-front.png',
    'assets/images/product-oniyouthstars-back.png'
  ],
  true,
  2
where not exists (
  select 1 from public.productos where nombre = 'oniyouth stars'
);

-- ---------- VARIANTES (tallas XS–XL, stock 0) ----------
-- Se generan para cada producto reciente por su nombre. El sku se
-- arma con un prefijo por producto + la talla, y es único.
insert into public.variantes (producto_id, talla, stock, sku)
select p.id, v.talla, 0, prod.prefijo || '-' || v.talla
from public.productos p
join (
  values
    ('ONIYOUTH TRIBAL TEE', 'ONI-TRIBAL'),
    ('oniyouth stars',      'ONI-STARS')
) as prod(nombre, prefijo) on prod.nombre = p.nombre
cross join (
  values ('XS'), ('S'), ('M'), ('L'), ('XL')
) as v(talla)
on conflict (producto_id, talla) do nothing;

-- ============================================================
-- FIN SEED FASE 3
-- ============================================================
