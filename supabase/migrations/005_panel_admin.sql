-- ============================================================
-- OniYouth · Migración 005 — Soporte del panel de administración (Fase 11)
--
-- El panel NO abre RLS de escritura para `authenticated`: TODO se
-- sigue escribiendo con service_role desde /api/admin, y ese endpoint
-- exige el token del único usuario admin (allowlist por email). Esta
-- migración solo agrega:
--   1. RPC `resumen_admin()` (ventas del mes + productos más vendidos).
--   2. Índice para las consultas de pedidos por estado/fecha.
--   3. Bucket de Storage `productos` (público en lectura) + política de
--      subida SOLO para el admin, para las imágenes de producto.
--
-- Idempotente: se puede re-ejecutar sin romper.
-- ============================================================

-- ------------------------------------------------------------
-- 1. RESUMEN PARA EL DASHBOARD
--    Ventas del mes = suma de `total` de pedidos ya cobrados
--    (pagado/enviado/entregado) creados en el mes calendario actual.
--    Top productos = unidades vendidas por nombre (histórico), del
--    snapshot `items` de esos mismos pedidos.
--    Solo service_role puede ejecutarla (desde /api).
-- ------------------------------------------------------------
create or replace function public.resumen_admin()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ventas_mes', coalesce((
      select sum(total) from public.pedidos
      where estado in ('pagado','enviado','entregado')
        and creado_en >= date_trunc('month', now())
    ), 0),
    'num_pedidos_mes', coalesce((
      select count(*) from public.pedidos
      where estado in ('pagado','enviado','entregado')
        and creado_en >= date_trunc('month', now())
    ), 0),
    'top_productos', coalesce((
      select jsonb_agg(t) from (
        select item->>'nombre' as nombre,
               sum((item->>'qty')::int) as unidades
        from public.pedidos p,
             lateral jsonb_array_elements(p.items) as item
        where p.estado in ('pagado','enviado','entregado')
        group by item->>'nombre'
        order by sum((item->>'qty')::int) desc
        limit 5
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.resumen_admin() from public;
revoke all on function public.resumen_admin() from anon;
revoke all on function public.resumen_admin() from authenticated;
grant execute on function public.resumen_admin() to service_role;

-- ------------------------------------------------------------
-- 2. ÍNDICE para lista de pedidos por estado + más recientes
-- ------------------------------------------------------------
create index if not exists pedidos_estado_creado_idx
  on public.pedidos (estado, creado_en desc);

-- ------------------------------------------------------------
-- 3. STORAGE — bucket público `productos` para imágenes.
--    Lectura pública (bucket public=true). La SUBIDA la hace el
--    navegador del admin directo a Storage, autorizada por su JWT:
--    la política de abajo solo deja escribir a ese email. Como el
--    registro público de Auth está DESACTIVADO, es el único que existe.
--
--    Nota: si tu rol de conexión no puede tocar el esquema `storage`,
--    crea el bucket a mano en Supabase → Storage (público) y aplica la
--    política desde el editor SQL como owner. El resto del panel funciona
--    igual; solo la subida de imágenes depende de esto.
--
--    ⚠️ El email de abajo DEBE coincidir con la env var ADMIN_EMAIL.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('productos', 'productos', true)
on conflict (id) do update set public = true;

drop policy if exists productos_admin_insert on storage.objects;
create policy productos_admin_insert
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'productos'
    and (auth.jwt() ->> 'email') = 'chocolatitoprueba4@gmail.com'
  );

drop policy if exists productos_admin_update on storage.objects;
create policy productos_admin_update
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'productos'
    and (auth.jwt() ->> 'email') = 'chocolatitoprueba4@gmail.com'
  );

-- ============================================================
-- FIN MIGRACIÓN 005
-- ============================================================
