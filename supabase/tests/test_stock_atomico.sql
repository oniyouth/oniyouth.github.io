-- ============================================================
-- Prueba: el descuento de stock es ATÓMICO a nivel de pedido.
-- No deja rastro: todo corre dentro de BEGIN ... ROLLBACK.
-- Correr con:  psql "$PGURL" -v ON_ERROR_STOP=1 -f este_archivo.sql
-- ============================================================

begin;

do $$
declare
  v_prod    uuid;
  v_a       uuid;
  v_b       uuid;
  v_stock_a int;
  v_stock_b int;
begin
  -- Datos de prueba: A con stock 5, B con stock 0
  insert into productos(nombre, precio) values ('__TEST__', 10) returning id into v_prod;
  insert into variantes(producto_id, talla, stock) values (v_prod, 'A', 5) returning id into v_a;
  insert into variantes(producto_id, talla, stock) values (v_prod, 'B', 0) returning id into v_b;

  -- CASO 1: pedido de 2 items (A×2 + B×1). B no tiene stock => debe fallar TODO.
  begin
    perform descontar_stock_pedido(jsonb_build_array(
      jsonb_build_object('variante_id', v_a, 'cantidad', 2),
      jsonb_build_object('variante_id', v_b, 'cantidad', 1)
    ));
    raise exception 'FALLO CASO 1: la función NO lanzó excepción (debería)';
  exception when others then
    raise notice 'CASO 1 ok -> excepción esperada: %', sqlerrm;
  end;

  -- Verificar que el PRIMER item (A) NO se descontó
  select stock into v_stock_a from variantes where id = v_a;
  select stock into v_stock_b from variantes where id = v_b;
  if v_stock_a = 5 and v_stock_b = 0 then
    raise notice 'CASO 1 ok -> A intacto=% , B intacto=% (SIN descuento parcial)', v_stock_a, v_stock_b;
  else
    raise exception 'CASO 1 FALLO -> hubo descuento parcial: A=% B=%', v_stock_a, v_stock_b;
  end if;

  -- CASO 2 (control): si B tiene stock, el pedido completo SÍ descuenta todo.
  update variantes set stock = 3 where id = v_b;
  perform descontar_stock_pedido(jsonb_build_array(
    jsonb_build_object('variante_id', v_a, 'cantidad', 2),
    jsonb_build_object('variante_id', v_b, 'cantidad', 1)
  ));
  select stock into v_stock_a from variantes where id = v_a;
  select stock into v_stock_b from variantes where id = v_b;
  if v_stock_a = 3 and v_stock_b = 2 then
    raise notice 'CASO 2 ok -> descuento completo (A: 5->%, B: 3->%)', v_stock_a, v_stock_b;
  else
    raise exception 'CASO 2 FALLO -> A=% B=% (esperado A=3 B=2)', v_stock_a, v_stock_b;
  end if;

  raise notice '===== TODAS LAS PRUEBAS PASARON =====';
end $$;

rollback;  -- deja la base tal como estaba

-- Verificación de privilegios: solo service_role puede ejecutar la función
select
  has_function_privilege('anon',          'public.descontar_stock_pedido(jsonb)', 'EXECUTE') as anon_puede,
  has_function_privilege('authenticated', 'public.descontar_stock_pedido(jsonb)', 'EXECUTE') as authenticated_puede,
  has_function_privilege('service_role',  'public.descontar_stock_pedido(jsonb)', 'EXECUTE') as service_role_puede;
