-- ============================================================
-- OniYouth · Migración 003 — Registrar pago (atómico e idempotente)
--
-- El webhook (Fase 8) necesita, en UNA sola transacción:
--   1. Comprobar que el pedido no esté ya pagado (idempotencia).
--   2. Descontar el stock de todo el pedido (o todo, o nada).
--   3. Marcar el pedido como 'pagado' con su payment_id.
--
-- Hacerlo en dos pasos desde el /api abría ventanas de inconsistencia
-- (pagado sin descontar, o descontado dos veces en reintentos). Aquí
-- va todo junto, con lock de fila. Los items se leen del PROPIO pedido
-- (no se confía en el caller); se mapea qty -> cantidad para reusar
-- descontar_stock_pedido (migración 002).
--
-- Devuelve un texto de resultado:
--   'ok'              -> pagado y stock descontado
--   'duplicado'       -> ya estaba pagado / ya tenía payment_id (no-op)
--   'no_encontrado'   -> no existe pedido con ese código
--   'pagado_sin_stock'-> el pago se registró pero NO había stock (revisar
--                        manualmente / reembolsar). No se descuenta stock.
-- ============================================================

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

  -- Mapea el snapshot del pedido {variante_id, qty, ...} al formato que
  -- espera descontar_stock_pedido: {variante_id, cantidad}.
  select jsonb_agg(jsonb_build_object(
           'variante_id', e->>'variante_id',
           'cantidad',    (e->>'qty')::int))
    into v_items
    from jsonb_array_elements(v_pedido.items) e;

  -- Descontar stock (atómico) y marcar pagado. Si falta stock,
  -- descontar_stock_pedido lanza check_violation: lo capturamos y
  -- registramos el pago igual (el dinero ya entró), SIN tocar el stock.
  begin
    perform public.descontar_stock_pedido(coalesce(v_items, '[]'::jsonb));
    update public.pedidos
      set estado = 'pagado', payment_id = p_payment_id
      where id = v_pedido.id;
    return 'ok';
  exception
    when check_violation then
      update public.pedidos
        set estado = 'pagado', payment_id = p_payment_id
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
