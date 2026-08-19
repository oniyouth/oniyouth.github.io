-- ============================================================
-- OniYouth · Migración 007 — Fix de subida de imágenes al bucket productos
--
-- Síntoma: el panel admin fallaba al subir imágenes con HTTP 400 cuyo cuerpo
-- decía "new row violates row-level security policy". Causa: el bucket
-- `productos` existía (creado desde el dashboard), pero las POLÍTICAS de
-- subida de la migración 005 NO estaban aplicadas → ninguna policy permitía
-- el INSERT en storage.objects → Storage rechazaba (incluso al admin).
--
-- Este script: (1) fija el bucket con límites explícitos (imágenes, 5 MB) y
-- (2) recrea las políticas de insert/update SOLO para el email del admin.
--
-- ⚠️ El email DEBE coincidir con ADMIN_EMAIL. Correr en el SQL Editor.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 5242880,
        array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict (id) do update set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','image/avif'];

drop policy if exists productos_admin_insert on storage.objects;
create policy productos_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'productos' and (auth.jwt() ->> 'email') = 'chocolatitoprueba4@gmail.com');

drop policy if exists productos_admin_update on storage.objects;
create policy productos_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'productos' and (auth.jwt() ->> 'email') = 'chocolatitoprueba4@gmail.com');

-- ============================================================
-- FIN MIGRACIÓN 007
-- ============================================================
