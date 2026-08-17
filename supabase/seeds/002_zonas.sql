-- ============================================================
-- OniYouth · Seed — Zonas de envío
--
-- Reglas del negocio:
--   - Envío S/12 a todo el país (Lima 2 días, Provincias 4 días).
--   - Envío gratis > S/299: lo calcula el SERVIDOR (crear-preferencia),
--     NO va como fila aquí.
--   - Satipo, Río Negro y Mazamari: CONTRAENTREGA, envío gratis, 1 día.
--
-- Idempotente: on conflict actualiza los valores.
-- Requiere haber aplicado la migración 004 (tabla zonas_envio).
-- ============================================================

insert into public.zonas_envio (nombre, costo_envio, dias_estimados, contraentrega) values
  ('Lima',       12, 2, false),
  ('Provincias', 12, 4, false),
  ('Satipo',      0, 1, true),
  ('Río Negro',   0, 1, true),
  ('Mazamari',    0, 1, true)
on conflict (nombre) do update
  set costo_envio    = excluded.costo_envio,
      dias_estimados = excluded.dias_estimados,
      contraentrega  = excluded.contraentrega;
