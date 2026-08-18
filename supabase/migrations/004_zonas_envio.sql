-- ============================================================
-- OniYouth · Migración 004 — Zonas de envío + estado contraentrega
--
-- Cambios:
--  1. Renombra la tabla `distritos` -> `zonas_envio` (ya no son
--     distritos sueltos, sino zonas: Lima, Provincias, y las de
--     contraentrega).
--  2. Agrega la columna `contraentrega boolean` a la zona.
--  3. Agrega el estado 'contraentrega' al check de pedidos.estado.
--
-- Idempotente: se puede re-ejecutar sin romper.
-- ============================================================

-- 1. Renombrar tabla (si aún se llama distritos)
alter table if exists public.distritos rename to zonas_envio;

-- 2. Columna contraentrega
alter table public.zonas_envio
  add column if not exists contraentrega boolean not null default false;

-- RLS: la política de lectura pública viaja con la tabla, pero con su
-- nombre viejo. La recreamos con nombre coherente (idempotente).
alter table public.zonas_envio enable row level security;
drop policy if exists distritos_lectura_publica  on public.zonas_envio;
drop policy if exists zonas_envio_lectura_publica on public.zonas_envio;
create policy zonas_envio_lectura_publica
  on public.zonas_envio for select
  to anon, authenticated
  using (true);

-- 3. Nuevo estado 'contraentrega' en pedidos
alter table public.pedidos drop constraint if exists pedidos_estado_check;
alter table public.pedidos add constraint pedidos_estado_check
  check (estado in ('pendiente','pagado','rechazado','cancelado','enviado','entregado','contraentrega'));

-- ============================================================
-- FIN MIGRACIÓN 004
-- ============================================================
