-- ============================================================
-- OniYouth · FASE 1 — Esquema de base de datos (Supabase / Postgres)
-- Ejecutar en:  Supabase Dashboard → SQL Editor → New query → Run
--
-- Decision de nomenclatura: identificadores en ASCII snake_case
-- (descripcion, categoria, imagenes, envio, direccion, codigo,
-- dias_estimados, usos_max, vence_en). Postgres admite tildes pero
-- obligarian a citar con comillas en TODO el codigo posterior.
-- Si prefieres los nombres con tilde, avisame y lo cambio.
--
-- Es idempotente: se puede volver a correr sin romper (usa IF NOT
-- EXISTS y CREATE OR REPLACE). NO borra datos existentes.
-- ============================================================

create extension if not exists "pgcrypto";  -- para gen_random_uuid()

-- ============================================================
-- TABLAS
-- ============================================================

-- ---------- PRODUCTOS ----------
create table if not exists public.productos (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  descripcion text,
  precio      numeric(10,2) not null check (precio >= 0),
  categoria   text,
  imagenes    text[] not null default '{}',
  activo      boolean not null default true,
  orden       int not null default 0,
  creado_en   timestamptz not null default now()
);
create index if not exists productos_activo_orden_idx
  on public.productos (activo, orden);

-- ---------- VARIANTES (talla + stock por producto) ----------
create table if not exists public.variantes (
  id          uuid primary key default gen_random_uuid(),
  producto_id uuid not null references public.productos(id) on delete cascade,
  talla       text not null,
  stock       int  not null default 0 check (stock >= 0),
  sku         text unique,
  unique (producto_id, talla)
);
create index if not exists variantes_producto_idx
  on public.variantes (producto_id);

-- ---------- DISTRITOS (costo de envio por distrito de Lima) ----------
create table if not exists public.distritos (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null unique,
  costo_envio    numeric(10,2) not null default 0 check (costo_envio >= 0),
  dias_estimados int not null default 1
);

-- ---------- CUPONES ----------
create table if not exists public.cupones (
  id       uuid primary key default gen_random_uuid(),
  codigo   text not null unique,
  tipo     text not null check (tipo in ('porcentaje','fijo')),
  valor    numeric(10,2) not null check (valor >= 0),
  usos_max int,                         -- null = ilimitado
  usos     int not null default 0,
  vence_en timestamptz,                 -- null = sin vencimiento
  activo   boolean not null default true
);

-- ---------- PEDIDOS ----------
create table if not exists public.pedidos (
  id               uuid primary key default gen_random_uuid(),
  codigo           text not null unique,          -- codigo publico de seguimiento
  preference_id    text,                          -- id de preferencia de Mercado Pago
  payment_id       text unique,                   -- id de pago de MP (evita duplicados en webhook)
  estado           text not null default 'pendiente'
                   check (estado in ('pendiente','pagado','rechazado','cancelado','enviado','entregado')),
  items            jsonb not null default '[]',   -- snapshot de lo comprado (variante, talla, precio, cant)
  subtotal         numeric(10,2) not null default 0,
  envio            numeric(10,2) not null default 0,
  descuento        numeric(10,2) not null default 0,
  total            numeric(10,2) not null default 0,
  cliente_nombre   text,
  cliente_telefono text,
  cliente_email    text,
  direccion        text,
  distrito         text,
  creado_en        timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Regla: el rol service_role (usado SOLO en /api) SIEMPRE ignora
-- RLS. Las politicas de abajo aplican a anon / authenticated.
-- ============================================================

alter table public.productos enable row level security;
alter table public.variantes enable row level security;
alter table public.distritos enable row level security;
alter table public.cupones   enable row level security;
alter table public.pedidos   enable row level security;

-- Lectura publica SOLO de productos activos
drop policy if exists productos_lectura_activos on public.productos;
create policy productos_lectura_activos
  on public.productos for select
  to anon, authenticated
  using (activo = true);

-- Lectura publica SOLO de variantes cuyo producto esta activo
drop policy if exists variantes_lectura_activas on public.variantes;
create policy variantes_lectura_activas
  on public.variantes for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.productos p
      where p.id = variantes.producto_id and p.activo = true
    )
  );

-- Distritos: lectura publica (el selector de envio del navegador los necesita)
-- NOTA: es una decision; si prefieres servir el envio solo via /api, lo quito.
drop policy if exists distritos_lectura_publica on public.distritos;
create policy distritos_lectura_publica
  on public.distritos for select
  to anon, authenticated
  using (true);

-- pedidos y cupones: SIN politicas para anon/authenticated.
-- Con RLS activo y sin politicas, esos roles no pueden leer ni
-- escribir NADA. Solo service_role (desde /api) accede.

-- ============================================================
-- FUNCION ATOMICA PARA DESCONTAR STOCK
-- Evita que dos compras simultaneas vendan la misma ultima talla.
-- El "select ... for update" bloquea la fila: la segunda
-- transaccion espera hasta el commit de la primera y recien ahi
-- vuelve a leer el stock ya actualizado.
-- Devuelve TRUE si descrito, FALSE si no habia stock suficiente.
-- ============================================================
create or replace function public.descontar_stock(
  p_variante_id uuid,
  p_cantidad    int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock int;
begin
  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'cantidad invalida: %', p_cantidad;
  end if;

  -- Lock de fila hasta el commit
  select stock into v_stock
  from public.variantes
  where id = p_variante_id
  for update;

  if not found then
    raise exception 'variante inexistente: %', p_variante_id;
  end if;

  if v_stock < p_cantidad then
    return false;  -- sin stock suficiente
  end if;

  update public.variantes
  set stock = stock - p_cantidad
  where id = p_variante_id;

  return true;
end;
$$;

-- Solo service_role puede ejecutar la funcion (nunca el navegador)
revoke all on function public.descontar_stock(uuid, int) from public;
revoke all on function public.descontar_stock(uuid, int) from anon;
revoke all on function public.descontar_stock(uuid, int) from authenticated;
grant execute on function public.descontar_stock(uuid, int) to service_role;

-- ============================================================
-- FIN FASE 1
-- ============================================================
