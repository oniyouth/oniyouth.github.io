-- ============================================================
-- OniYouth · Migración 002 — Descuento de stock ATÓMICO por pedido
--
-- Problema de 001: descontar_stock(uuid,int) operaba variante por
-- variante. Si un pedido tenía varios items y uno fallaba por stock,
-- los anteriores ya se habían descontado -> inconsistencia.
--
-- Solución: una sola función que recibe TODO el pedido (array jsonb)
-- y lo descuenta dentro de una única transaccion implicita. Si algo
-- falla, se revierte el pedido completo. O todo, o nada.
-- ============================================================

-- Elimina la version por-variante (footgun de descuento parcial)
drop function if exists public.descontar_stock(uuid, int);

-- Nueva función a nivel de pedido
create or replace function public.descontar_stock_pedido(p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  v_rows int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items debe ser un array jsonb de {variante_id, cantidad}';
  end if;

  -- Agrega cantidades por variante (por si la misma variante viene 2 veces)
  -- y procesa en orden determinista (por id) para evitar deadlocks entre
  -- pedidos concurrentes que toquen las mismas variantes.
  for r in
    select (e->>'variante_id')::uuid as variante_id,
           sum((e->>'cantidad')::int) as cantidad
    from jsonb_array_elements(p_items) e
    group by (e->>'variante_id')::uuid
    order by (e->>'variante_id')::uuid
  loop
    if r.cantidad is null or r.cantidad <= 0 then
      raise exception 'cantidad invalida para variante %', r.variante_id;
    end if;

    -- El UPDATE toma lock de fila; bajo READ COMMITTED, un pedido
    -- concurrente espera y re-evalua "stock >= cantidad" contra el
    -- valor ya actualizado -> no se puede vender de mas.
    update public.variantes
    set stock = stock - r.cantidad
    where id = r.variante_id
      and stock >= r.cantidad;

    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      if exists (select 1 from public.variantes where id = r.variante_id) then
        raise exception 'stock insuficiente para variante %', r.variante_id
          using errcode = 'check_violation';
      else
        raise exception 'variante inexistente: %', r.variante_id;
      end if;
    end if;
  end loop;
end;
$$;

-- Solo service_role (desde /api) puede ejecutarla. Nunca el navegador.
revoke all on function public.descontar_stock_pedido(jsonb) from public;
revoke all on function public.descontar_stock_pedido(jsonb) from anon;
revoke all on function public.descontar_stock_pedido(jsonb) from authenticated;
grant execute on function public.descontar_stock_pedido(jsonb) to service_role;
