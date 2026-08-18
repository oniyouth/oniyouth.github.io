-- ============================================================
-- OniYouth · Migración 006 — "Pago revivido" (rechazado → pagado)
--
-- Caso raro: un pedido quedó 'rechazado' (o 'cancelado') y DESPUÉS
-- llega un `approved` de un intento de pago paralelo. Decisión del
-- dueño: marcarlo 'pagado' normalmente (el cliente pagó, hay que
-- atenderlo) PERO dejar una bandera para revisarlo a mano, porque no
-- es el flujo normal.
--
-- La detección se hace DENTRO del RPC, bajo el `for update` de la fila,
-- así que el estado previo se lee de forma atómica (sin carrera).
--
-- Idempotente: se puede re-ejecutar sin romper.
-- ============================================================

-- 1. Banderas de revisión en el pedido
alter table public.pedidos add column if not exists requiere_revision boolean not null default false;
alter table public.pedidos add column if not exists revision_motivo   text;

-- Índice parcial para listar rápido "los que hay que revisar"
create index if not exists pedidos_requiere_revision_idx
  on public.pedidos (requiere_revision) where requiere_revision;

-- 2. RPC de registro de pago, ahora con detección de "revivido".
--    Devuelve, además de los códigos previos:
--      'revivido'  -> se pagó un pedido que estaba rechazado/cancelado
--                     (marcado pagado + bandera de revisión encendida)
create or replace function public.registrar_pago_pedido(
  p_codigo     text,
  p_payment_id text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pedido public.pedidos%rowtype;
  v_items  jsonb;
  v_prev   text;
  v_motivo text := null;
begin
  -- Lock de la fila del pedido hasta el commit
  select * into v_pedido from public.pedidos where codigo = p_codigo for update;
  if not found then
    return 'no_encontrado';
  end if;

  -- Idempotencia: si ya se procesó, no repetir
  if v_pedido.estado = 'pagado' or v_pedido.payment_id is not null then
    return 'duplicado';
  end if;

  -- Estado previo (bajo lock): ¿estamos reviviendo un rechazado/cancelado?
  v_prev := v_pedido.estado;
  if v_prev in ('rechazado', 'cancelado') then
    v_motivo := 'Pagado (payment ' || p_payment_id || ') tras estado previo ' || v_prev
             || '; intento de pago paralelo aprobado. Revisar.';
  end if;

  -- Mapea el snapshot {variante_id, qty} -> {variante_id, cantidad}
  select jsonb_agg(jsonb_build_object(
           'variante_id', e->>'variante_id',
           'cantidad',    (e->>'qty')::int))
    into v_items
    from jsonb_array_elements(v_pedido.items) e;

  begin
    perform public.descontar_stock_pedido(coalesce(v_items, '[]'::jsonb));
    update public.pedidos
      set estado = 'pagado',
          payment_id = p_payment_id,
          requiere_revision = requiere_revision or (v_motivo is not null),
          revision_motivo   = coalesce(v_motivo, revision_motivo)
      where id = v_pedido.id;
    if v_motivo is not null then
      return 'revivido';
    end if;
    return 'ok';
  exception
    when check_violation then
      -- El pago entró pero no había stock: se registra igual (sin tocar stock).
      -- Este caso ya es de revisión por sí mismo; si además revivía, la bandera
      -- queda encendida con su motivo.
      update public.pedidos
        set estado = 'pagado',
            payment_id = p_payment_id,
            requiere_revision = requiere_revision or (v_motivo is not null),
            revision_motivo   = coalesce(v_motivo, revision_motivo)
        where id = v_pedido.id;
      return 'pagado_sin_stock';
  end;
end;
$$;

-- Solo service_role (desde el webhook en /api). Nunca el navegador.
revoke all on function public.registrar_pago_pedido(text, text) from public;
revoke all on function public.registrar_pago_pedido(text, text) from anon;
revoke all on function public.registrar_pago_pedido(text, text) from authenticated;
grant execute on function public.registrar_pago_pedido(text, text) to service_role;

-- ============================================================
-- FIN MIGRACIÓN 006
-- ============================================================
