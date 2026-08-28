-- ============================================================
-- OniYouth . Migracion 009 - Configuracion editable de la portada
--
-- Tabla clave/valor para ajustes de la tienda editables desde el panel
-- SIN tocar el codigo ni redeployar. Primer uso: las imagenes del hero
-- (slideshow de la pagina principal), que hasta ahora estaban fijas en
-- index.html. El panel guarda aqui la lista de URLs y el front la lee.
--
-- valor es jsonb libre. Para 'hero_slides' es un array de URLs (strings).
--
-- Lectura publica (anon) porque no hay nada sensible; la escritura va solo
-- por /api con service_role (no hay policy de insert/update para anon).
--
-- Idempotente. Comentarios ASCII y una sentencia por linea a proposito,
-- para que el editor SQL de Supabase no parta mal el pegado.
-- Ejecutar en: Supabase -> SQL Editor -> Run.
-- ============================================================

create table if not exists public.configuracion (clave text primary key, valor jsonb not null default '{}'::jsonb, actualizado_en timestamptz not null default now());

-- Semilla: las 4 slides actuales del hero (las mismas que estaban fijas en
-- index.html), en WebP. Solo se inserta si la fila aun no existe, para no
-- pisar lo que el dueno haya guardado desde el panel.
-- Se usa jsonb_build_array (no un literal JSON largo) para que, si el editor
-- de Supabase parte la linea al pegar, un salto de linea no rompa el JSON
-- (error 22P02 "Character 0x0a must be escaped").
insert into public.configuracion (clave, valor) values ('hero_slides', jsonb_build_array('assets/images/hero-bg.webp', 'assets/images/hero-slide-2.webp', 'assets/images/hero-slide-3.webp', 'assets/images/hero-slide-4.webp')) on conflict (clave) do nothing;

-- RLS: lectura publica; escritura solo service_role (sin policy => bloqueada para anon).
alter table public.configuracion enable row level security;
drop policy if exists configuracion_lectura_publica on public.configuracion;
create policy configuracion_lectura_publica on public.configuracion for select to anon, authenticated using (true);

-- FIN MIGRACION 009
