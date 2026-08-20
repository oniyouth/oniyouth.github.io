-- ============================================================
-- OniYouth . Migracion 008 - Colores por producto + Guia de tallas
--
-- (A) COLORES: una variante pasa de (producto, talla) a (producto, color,
--     talla), con stock independiente por combinacion y galeria propia por
--     color. El swatch en la ficha es la 1a foto del color.
-- (B) GUIA DE TALLAS: imagen asociable a un producto o a una categoria
--     (el producto manda sobre la categoria).
--
-- SEGURIDAD / NO DESTRUCTIVO: no se borra ni recrea NINGUNA fila de
-- variantes; solo se les agrega color_id y se rellena en su lugar (UPDATE),
-- asi los UUID de variante y el stock quedan intactos y el pedido real
-- ONI-68BAF3DF sigue apuntando a variantes validas.
--
-- Idempotente: se puede correr mas de una vez sin romper.
-- NOTA DE PEGADO: todos los comentarios son ASCII y cada sentencia va en una
-- sola linea a proposito, para que el editor SQL no parta mal el script.
-- Ejecutar en: Supabase -> SQL Editor -> Run.
-- ============================================================

-- (A) COLORES
create table if not exists public.colores (id uuid primary key default gen_random_uuid(), producto_id uuid not null references public.productos(id) on delete cascade, nombre text not null, hex text, imagenes text[] not null default '{}', orden int not null default 0, creado_en timestamptz not null default now(), unique (producto_id, nombre));
create index if not exists colores_producto_idx on public.colores (producto_id);

-- color_id en variantes (nullable primero, para el backfill)
alter table public.variantes add column if not exists color_id uuid references public.colores(id) on delete cascade;

-- Backfill: un color por defecto por producto que aun no tenga colores,
-- heredando las imagenes del producto; luego se rellenan las variantes.
insert into public.colores (producto_id, nombre, imagenes, orden) select p.id, 'Unico', coalesce(p.imagenes, '{}'), 0 from public.productos p where not exists (select 1 from public.colores c where c.producto_id = p.id);
update public.variantes v set color_id = c.id from public.colores c where c.producto_id = v.producto_id and v.color_id is null;

-- Cambiar la unicidad: (producto_id, talla) -> (color_id, talla)
alter table public.variantes drop constraint if exists variantes_producto_id_talla_key;
alter table public.variantes drop constraint if exists variantes_color_talla_key;
alter table public.variantes add constraint variantes_color_talla_key unique (color_id, talla);

-- color_id obligatorio (recien ahora, ya rellenado)
alter table public.variantes alter column color_id set not null;

-- RLS: lectura publica de colores solo de productos activos
alter table public.colores enable row level security;
drop policy if exists colores_lectura_activas on public.colores;
create policy colores_lectura_activas on public.colores for select to anon, authenticated using (exists (select 1 from public.productos p where p.id = colores.producto_id and p.activo = true));

-- (B) GUIA DE TALLAS
create table if not exists public.guias_talla (id uuid primary key default gen_random_uuid(), producto_id uuid references public.productos(id) on delete cascade, categoria text, imagen_url text not null, creado_en timestamptz not null default now(), check (producto_id is not null or categoria is not null));
create index if not exists guias_talla_producto_idx on public.guias_talla (producto_id);
create index if not exists guias_talla_categoria_idx on public.guias_talla (categoria);
create unique index if not exists guias_talla_producto_uidx on public.guias_talla (producto_id) where producto_id is not null;
create unique index if not exists guias_talla_categoria_uidx on public.guias_talla (categoria) where producto_id is null and categoria is not null;
alter table public.guias_talla enable row level security;
drop policy if exists guias_talla_lectura_publica on public.guias_talla;
create policy guias_talla_lectura_publica on public.guias_talla for select to anon, authenticated using (true);

-- FIN MIGRACION 008
