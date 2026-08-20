-- ============================================================
-- OniYouth · Migración 008 — Colores por producto + Guía de tallas
--
-- Dos features nuevas de la ficha de producto:
--   (A) COLORES: hoy una variante es (producto, talla). Pasa a ser
--       (producto, color, talla), con stock independiente por combinación
--       y galería de fotos propia por color. El swatch en la ficha es la
--       1ª foto del color.
--   (B) GUÍA DE TALLAS: imagen asociable a un producto o a una categoría
--       (el producto manda sobre la categoría).
--
-- SEGURIDAD / NO DESTRUCTIVO: no se borra ni recrea NINGUNA fila de
-- variantes. Solo se les AGREGA la columna color_id y se rellena en su
-- lugar (UPDATE), así los UUID de variante y el stock quedan intactos y
-- el pedido real ONI-68BAF3DF sigue apuntando a variantes válidas.
--
-- Idempotente: se puede correr más de una vez sin romper (IF NOT EXISTS /
-- IF EXISTS / chequeos previos). Ejecutar en: Supabase → SQL Editor → Run.
-- ============================================================

-- ============================================================
-- (A) COLORES
-- ============================================================

-- ---------- Tabla de colores por producto ----------
create table if not exists public.colores (
  id          uuid primary key default gen_random_uuid(),
  producto_id uuid not null references public.productos(id) on delete cascade,
  nombre      text not null,
  hex         text,                              -- swatch opcional (#RRGGBB); si null, se usa la 1ª foto
  imagenes    text[] not null default '{}',      -- galería propia del color
  orden       int not null default 0,
  creado_en   timestamptz not null default now(),
  unique (producto_id, nombre)
);
create index if not exists colores_producto_idx on public.colores (producto_id);

-- ---------- variantes.color_id (nullable primero, para el backfill) ----------
alter table public.variantes
  add column if not exists color_id uuid references public.colores(id) on delete cascade;

-- ---------- Backfill: un color por defecto por producto que YA tenga
-- variantes, heredando las imágenes actuales del producto como su galería.
-- Idempotente: si el producto ya tiene un color, reusa el primero.
do $$
declare
  p     record;
  c_id  uuid;
begin
  for p in select id, imagenes from public.productos loop
    select id into c_id
      from public.colores
      where producto_id = p.id
      order by orden, creado_en
      limit 1;

    if c_id is null then
      insert into public.colores (producto_id, nombre, imagenes, orden)
      values (p.id, 'Único', coalesce(p.imagenes, '{}'), 0)
      returning id into c_id;
    end if;

    update public.variantes
      set color_id = c_id
      where producto_id = p.id
        and color_id is null;
  end loop;
end $$;

-- ---------- Cambiar la unicidad: (producto_id, talla) -> (color_id, talla) ----------
-- El nombre autogenerado de la unique de 001 es variantes_producto_id_talla_key.
alter table public.variantes drop constraint if exists variantes_producto_id_talla_key;
-- Por si en algún entorno ya se había creado con otro nombre, no falla si no existe.
alter table public.variantes drop constraint if exists variantes_color_talla_key;
alter table public.variantes add  constraint variantes_color_talla_key unique (color_id, talla);

-- ---------- color_id obligatorio (recién ahora, ya rellenado) ----------
-- Solo si no quedó ninguna fila sin color (defensa; el backfill de arriba
-- las cubre todas). Si quedara alguna, este SET NOT NULL fallaría y avisaría.
alter table public.variantes alter column color_id set not null;

-- ---------- RLS: lectura pública de colores solo de productos activos ----------
alter table public.colores enable row level security;
drop policy if exists colores_lectura_activas on public.colores;
create policy colores_lectura_activas
  on public.colores for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.productos p
      where p.id = colores.producto_id and p.activo = true
    )
  );

-- ============================================================
-- (B) GUÍA DE TALLAS
-- ============================================================
create table if not exists public.guias_talla (
  id          uuid primary key default gen_random_uuid(),
  producto_id uuid references public.productos(id) on delete cascade,  -- null = aplica por categoría
  categoria   text,                                                    -- null = específica de un producto
  imagen_url  text not null,
  creado_en   timestamptz not null default now(),
  check (producto_id is not null or categoria is not null)
);
create index if not exists guias_talla_producto_idx  on public.guias_talla (producto_id);
create index if not exists guias_talla_categoria_idx on public.guias_talla (categoria);

-- Una guía específica por producto y una por categoría (evita duplicados).
create unique index if not exists guias_talla_producto_uidx
  on public.guias_talla (producto_id) where producto_id is not null;
create unique index if not exists guias_talla_categoria_uidx
  on public.guias_talla (categoria) where producto_id is null and categoria is not null;

-- Lectura pública (el modal de la ficha la necesita desde el navegador).
alter table public.guias_talla enable row level security;
drop policy if exists guias_talla_lectura_publica on public.guias_talla;
create policy guias_talla_lectura_publica
  on public.guias_talla for select
  to anon, authenticated
  using (true);

-- ============================================================
-- FIN MIGRACIÓN 008
-- (pedidos/cupones/guías de escritura: solo service_role desde /api,
--  igual que el resto; no hacen falta políticas de escritura aquí)
-- ============================================================
