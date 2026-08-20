// ============================================================
// OniYouth · Fase 11 — API del panel de administración (SERVIDOR)
//
// Un solo endpoint que enruta por ?r=<recurso> + método HTTP. TODO
// detrás de requireAdmin (token del admin + allowlist por email). Las
// escrituras usan service_role (vía sb()), nunca el navegador.
//
// Sin CORS a propósito: el panel se sirve desde el MISMO deploy de
// Vercel (same-origin), así que no hace falta abrir Access-Control. Un
// origen ajeno queda bloqueado por la política por defecto del navegador.
//
// Recursos:
//   resumen    GET
//   productos  GET (lista, incl. inactivos) · POST (crear) · PATCH (editar/activar)
//   colores    GET (por producto) · POST (crear) · PATCH (editar) · DELETE (quitar color)
//   variantes  PATCH (stock, 1 o varias) · POST (nueva talla en un color) · DELETE (quitar talla)
//   guias      GET · POST (upsert por producto o categoría) · DELETE
//   pedidos    GET (lista/detalle, incl. PII) · PATCH (cambiar estado)
//   cupones    GET · POST (crear) · PATCH (editar/desactivar)
//   zonas      GET · PATCH (costo/días/contraentrega)
//
// Runtime: función serverless de Vercel (Node). No corre en Pages.
// ============================================================

const { requireAdmin } = require('./_lib/auth');
const { sb, money, parseBody } = require('./_lib/store');
const mailer = require('./_lib/mailer');

const ESTADOS_PEDIDO = ['pendiente', 'pagado', 'rechazado', 'cancelado', 'enviado', 'entregado', 'contraentrega'];
const TALLAS_DEFAULT = ['XS', 'S', 'M', 'L', 'XL'];
const IMG_BUCKET = 'productos';
const IMG_TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const IMG_MAX_BYTES = Math.floor(4.5 * 1024 * 1024); // límite de body de una función de Vercel

// ---------- helpers de saneo (nada se cree del navegador sin validar) ----------
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const guard = await requireAdmin(req);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  const r = String((req.query && req.query.r) || '').trim();
  try {
    switch (r) {
      case 'resumen':   return await recResumen(req, res);
      case 'productos': return await recProductos(req, res);
      case 'colores':   return await recColores(req, res);
      case 'variantes': return await recVariantes(req, res);
      case 'guias':     return await recGuias(req, res);
      case 'pedidos':   return await recPedidos(req, res);
      case 'cupones':   return await recCupones(req, res);
      case 'zonas':     return await recZonas(req, res);
      case 'subir-imagen': return await recSubirImagen(req, res);
      case 'test-email':return await recTestEmail(req, res);
      default:          return res.status(404).json({ error: 'recurso' });
    }
  } catch (e) {
    console.error('admin[' + r + ']:', e);
    return res.status(502).json({ error: 'servidor', mensaje: 'Error del servidor' });
  }
};

// ============================================================
// RESUMEN
// ============================================================
async function recResumen(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo' });
  const rr = await sb('rpc/resumen_admin', { method: 'POST', body: '{}' });
  if (!rr.ok) throw new Error('rpc resumen_admin ' + rr.status + ' ' + (await rr.text()));
  return res.status(200).json(await rr.json());
}

// ============================================================
// PRODUCTOS
// ============================================================
function saneaProducto(b, esNuevo) {
  const out = {};
  if (esNuevo || b.nombre !== undefined) {
    const nombre = String(b.nombre || '').trim();
    if (esNuevo && !nombre) return { error: 'El nombre es obligatorio' };
    if (b.nombre !== undefined) out.nombre = nombre;
  }
  if (b.descripcion !== undefined) out.descripcion = b.descripcion == null ? null : String(b.descripcion);
  if (esNuevo || b.precio !== undefined) {
    const precio = toNum(b.precio);
    if (b.precio !== undefined || esNuevo) {
      if (precio == null || precio < 0) return { error: 'Precio inválido' };
      out.precio = money(precio);
    }
  }
  if (b.categoria !== undefined) out.categoria = b.categoria == null ? null : String(b.categoria).trim();
  if (b.imagenes !== undefined) {
    if (!Array.isArray(b.imagenes)) return { error: 'imagenes debe ser una lista' };
    out.imagenes = b.imagenes.map(x => String(x)).filter(Boolean);
  }
  if (b.activo !== undefined) out.activo = !!b.activo;
  if (b.orden !== undefined) {
    const orden = toInt(b.orden);
    if (orden == null) return { error: 'Orden inválido' };
    out.orden = orden;
  }
  return { value: out };
}

async function recProductos(req, res) {
  if (req.method === 'GET') {
    // Intento con colores (esquema nuevo). Si la migración 008 aún no se aplicó,
    // PostgREST devuelve error por el embed inexistente: caemos a legacy para no
    // dejar el panel roto en la ventana entre deploy y migración.
    let rr = await sb('productos?select=id,nombre,descripcion,precio,categoria,imagenes,activo,orden,creado_en,'
      + 'colores(id,nombre,hex,imagenes,orden),variantes(id,talla,stock,sku,color_id)&order=orden.asc');
    if (!rr.ok) {
      rr = await sb('productos?select=id,nombre,descripcion,precio,categoria,imagenes,activo,orden,creado_en,'
        + 'variantes(id,talla,stock,sku)&order=orden.asc');
    }
    if (!rr.ok) throw new Error('productos ' + rr.status);
    return res.status(200).json(await rr.json());
  }

  if (req.method === 'POST') {
    const b = parseBody(req);
    const s = saneaProducto(b, true);
    if (s.error) return res.status(400).json({ error: 'datos', mensaje: s.error });
    const ins = await sb('productos', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(s.value)
    });
    if (ins.status !== 201) throw new Error('insert producto ' + ins.status + ' ' + (await ins.text()));
    const prod = (await ins.json())[0];
    // Un color por defecto (hereda las imágenes del producto) + sus tallas XS–XL
    // stock 0. Las variantes ahora exigen color_id (NOT NULL), así que el color
    // se crea PRIMERO. Best-effort: si algo falla, el producto igual se creó.
    await crearColorConTallas(prod.id, 'Unico', prod.imagenes || [], null);
    return res.status(201).json(prod);
  }

  if (req.method === 'PATCH') {
    const b = parseBody(req);
    const id = String(b.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id' });
    const s = saneaProducto(b, false);
    if (s.error) return res.status(400).json({ error: 'datos', mensaje: s.error });
    if (Object.keys(s.value).length === 0) return res.status(400).json({ error: 'vacio', mensaje: 'Nada que actualizar' });
    const up = await sb('productos?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(s.value)
    });
    if (!up.ok) throw new Error('patch producto ' + up.status + ' ' + (await up.text()));
    const arr = await up.json();
    if (!arr[0]) return res.status(404).json({ error: 'no_encontrado' });
    return res.status(200).json(arr[0]);
  }

  return res.status(405).json({ error: 'metodo' });
}

// ============================================================
// COLORES (galería + stock por talla, dentro de un producto)
// ============================================================
function saneaImagenes(v) {
  if (!Array.isArray(v)) return null;
  return v.map(x => String(x)).filter(Boolean);
}
function saneaHex(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const h = String(v).trim();
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h : null;
}

// Crea un color y le siembra las tallas por defecto XS–XL con stock 0.
// Devuelve la fila del color (o null si falló la creación). Best-effort en
// las variantes: el color se crea igual aunque el sembrado falle.
async function crearColorConTallas(producto_id, nombre, imagenes, hex) {
  const row = { producto_id, nombre: String(nombre || 'Color').trim() || 'Color',
    imagenes: saneaImagenes(imagenes) || [], hex: saneaHex(hex) || null };
  const ins = await sb('colores', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (ins.status === 409) return { conflict: true };
  if (ins.status !== 201) { console.error('insert color', ins.status, await ins.text()); return null; }
  const color = (await ins.json())[0];
  const vs = TALLAS_DEFAULT.map(t => ({ producto_id, color_id: color.id, talla: t, stock: 0 }));
  const iv = await sb('variantes', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(vs) });
  if (!iv.ok) console.error('sembrar tallas del color:', iv.status, await iv.text());
  return color;
}

async function recColores(req, res) {
  if (req.method === 'GET') {
    const pid = String((req.query && req.query.producto_id) || '').trim();
    let path = 'colores?select=id,producto_id,nombre,hex,imagenes,orden,variantes(id,talla,stock,color_id)&order=orden.asc';
    if (pid) path += '&producto_id=eq.' + encodeURIComponent(pid);
    const rr = await sb(path);
    if (!rr.ok) throw new Error('colores ' + rr.status);
    return res.status(200).json(await rr.json());
  }

  if (req.method === 'POST') {
    const b = parseBody(req);
    const producto_id = String(b.producto_id || '').trim();
    const nombre = String(b.nombre || '').trim();
    if (!producto_id || !nombre) return res.status(400).json({ error: 'datos', mensaje: 'Falta producto o nombre del color' });
    const color = await crearColorConTallas(producto_id, nombre, b.imagenes, b.hex);
    if (color && color.conflict) return res.status(409).json({ error: 'duplicado', mensaje: 'Ese color ya existe en el producto' });
    if (!color) throw new Error('no se pudo crear el color');
    return res.status(201).json(color);
  }

  if (req.method === 'PATCH') {
    const b = parseBody(req);
    const id = String(b.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id' });
    const out = {};
    if (b.nombre !== undefined) { const n = String(b.nombre).trim(); if (!n) return res.status(400).json({ error: 'datos', mensaje: 'Nombre vacío' }); out.nombre = n; }
    if (b.imagenes !== undefined) { const im = saneaImagenes(b.imagenes); if (!im) return res.status(400).json({ error: 'datos', mensaje: 'imagenes debe ser una lista' }); out.imagenes = im; }
    if (b.hex !== undefined) out.hex = saneaHex(b.hex);
    if (b.orden !== undefined) { const o = toInt(b.orden); if (o == null) return res.status(400).json({ error: 'datos', mensaje: 'Orden inválido' }); out.orden = o; }
    if (Object.keys(out).length === 0) return res.status(400).json({ error: 'vacio', mensaje: 'Nada que actualizar' });
    const up = await sb('colores?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(out)
    });
    if (up.status === 409) return res.status(409).json({ error: 'duplicado', mensaje: 'Ese color ya existe en el producto' });
    if (!up.ok) throw new Error('patch color ' + up.status + ' ' + (await up.text()));
    const arr = await up.json();
    if (!arr[0]) return res.status(404).json({ error: 'no_encontrado' });
    return res.status(200).json(arr[0]);
  }

  if (req.method === 'DELETE') {
    // Borra el color y (por cascada) sus variantes/stock. Pensado para colores
    // sin ventas; el stock de esas variantes se pierde a propósito.
    const id = String((req.query && req.query.id) || parseBody(req).id || '').trim();
    if (!id) return res.status(400).json({ error: 'id' });
    const del = await sb('colores?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!del.ok) throw new Error('delete color ' + del.status);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'metodo' });
}

// ============================================================
// VARIANTES (stock por talla)
// ============================================================
async function recVariantes(req, res) {
  if (req.method === 'PATCH') {
    const b = parseBody(req);
    // Acepta un cambio suelto {id, stock} o varios {cambios:[{id,stock}]}
    const cambios = Array.isArray(b.cambios) ? b.cambios : [{ id: b.id, stock: b.stock }];
    const limpios = [];
    for (const c of cambios) {
      const id = String((c && c.id) || '').trim();
      const stock = toInt(c && c.stock);
      if (!id || stock == null || stock < 0) return res.status(400).json({ error: 'datos', mensaje: 'Stock inválido' });
      limpios.push({ id, stock });
    }
    if (!limpios.length) return res.status(400).json({ error: 'vacio' });
    for (const c of limpios) {
      const up = await sb('variantes?id=eq.' + encodeURIComponent(c.id), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ stock: c.stock })
      });
      if (!up.ok) throw new Error('patch variante ' + up.status + ' ' + (await up.text()));
    }
    return res.status(200).json({ ok: true, actualizadas: limpios.length });
  }

  if (req.method === 'POST') {
    const b = parseBody(req);
    const producto_id = String(b.producto_id || '').trim();
    const color_id = String(b.color_id || '').trim();
    const talla = String(b.talla || '').trim();
    const stock = toInt(b.stock);
    if (!producto_id || !color_id || !talla) return res.status(400).json({ error: 'datos', mensaje: 'Falta producto, color o talla' });
    const row = { producto_id, color_id, talla, stock: (stock == null || stock < 0) ? 0 : stock };
    if (b.sku) row.sku = String(b.sku).trim();
    const ins = await sb('variantes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (ins.status === 409) return res.status(409).json({ error: 'duplicado', mensaje: 'Esa talla ya existe en ese color' });
    if (ins.status !== 201) throw new Error('insert variante ' + ins.status + ' ' + (await ins.text()));
    return res.status(201).json((await ins.json())[0]);
  }

  if (req.method === 'DELETE') {
    const id = String((req.query && req.query.id) || parseBody(req).id || '').trim();
    if (!id) return res.status(400).json({ error: 'id' });
    const del = await sb('variantes?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!del.ok) throw new Error('delete variante ' + del.status);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'metodo' });
}

// ============================================================
// GUÍAS DE TALLA (imagen asociada a un producto o a una categoría)
// La imagen se sube aparte con la ruta subir-imagen; aquí solo se guarda
// su URL + a qué aplica. Upsert: una guía por producto y una por categoría.
// ============================================================
async function recGuias(req, res) {
  if (req.method === 'GET') {
    const rr = await sb('guias_talla?select=id,producto_id,categoria,imagen_url,creado_en&order=creado_en.desc');
    if (!rr.ok) throw new Error('guias ' + rr.status);
    return res.status(200).json(await rr.json());
  }

  if (req.method === 'POST') {
    const b = parseBody(req);
    const imagen_url = String(b.imagen_url || '').trim();
    const producto_id = String(b.producto_id || '').trim();
    const categoria = String(b.categoria || '').trim();
    if (!imagen_url) return res.status(400).json({ error: 'datos', mensaje: 'Falta la imagen de la guía' });
    if (!producto_id && !categoria) return res.status(400).json({ error: 'datos', mensaje: 'Asociá la guía a un producto o a una categoría' });
    if (producto_id && categoria) return res.status(400).json({ error: 'datos', mensaje: 'Elegí producto O categoría, no ambos' });

    // Upsert manual: si ya hay guía para ese producto/categoría, se actualiza.
    const filtro = producto_id
      ? 'producto_id=eq.' + encodeURIComponent(producto_id)
      : 'producto_id=is.null&categoria=eq.' + encodeURIComponent(categoria);
    const ex = await sb('guias_talla?select=id&' + filtro + '&limit=1');
    if (!ex.ok) throw new Error('guias lookup ' + ex.status);
    const prev = await ex.json();
    if (Array.isArray(prev) && prev[0]) {
      const up = await sb('guias_talla?id=eq.' + encodeURIComponent(prev[0].id), {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ imagen_url })
      });
      if (!up.ok) throw new Error('patch guia ' + up.status + ' ' + (await up.text()));
      return res.status(200).json((await up.json())[0]);
    }
    const row = { imagen_url, producto_id: producto_id || null, categoria: producto_id ? null : categoria };
    const ins = await sb('guias_talla', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (ins.status !== 201) throw new Error('insert guia ' + ins.status + ' ' + (await ins.text()));
    return res.status(201).json((await ins.json())[0]);
  }

  if (req.method === 'DELETE') {
    const id = String((req.query && req.query.id) || parseBody(req).id || '').trim();
    if (!id) return res.status(400).json({ error: 'id' });
    const del = await sb('guias_talla?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!del.ok) throw new Error('delete guia ' + del.status);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'metodo' });
}

// ============================================================
// PEDIDOS
// ============================================================
async function recPedidos(req, res) {
  if (req.method === 'GET') {
    const codigo = String((req.query && req.query.codigo) || '').trim().toUpperCase();
    const campos = 'id,codigo,estado,payment_id,preference_id,items,subtotal,envio,descuento,total,'
      + 'cliente_nombre,cliente_telefono,cliente_email,direccion,distrito,creado_en,'
      + 'requiere_revision,revision_motivo';
    if (codigo) {
      const rr = await sb('pedidos?select=' + campos + '&codigo=eq.' + encodeURIComponent(codigo) + '&limit=1');
      if (!rr.ok) throw new Error('pedido ' + rr.status);
      const arr = await rr.json();
      if (!arr[0]) return res.status(404).json({ error: 'no_encontrado' });
      return res.status(200).json(arr[0]);
    }
    const estado = String((req.query && req.query.estado) || '').trim();
    let path = 'pedidos?select=' + campos + '&order=creado_en.desc&limit=200';
    if (estado && ESTADOS_PEDIDO.includes(estado)) path += '&estado=eq.' + encodeURIComponent(estado);
    const rr = await sb(path);
    if (!rr.ok) throw new Error('pedidos ' + rr.status);
    return res.status(200).json(await rr.json());
  }

  if (req.method === 'PATCH') {
    const b = parseBody(req);
    const codigo = String(b.codigo || '').trim().toUpperCase();
    const id = String(b.id || '').trim();
    if (!codigo && !id) return res.status(400).json({ error: 'id', mensaje: 'Falta código o id' });
    // Acepta cambiar el estado y/o bajar la bandera de revisión ("Marcar revisado").
    const patch = {};
    if (b.estado !== undefined) {
      const estado = String(b.estado).trim();
      if (!ESTADOS_PEDIDO.includes(estado)) return res.status(400).json({ error: 'estado', mensaje: 'Estado inválido' });
      patch.estado = estado;
    }
    if (b.requiere_revision !== undefined) patch.requiere_revision = !!b.requiere_revision;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'vacio', mensaje: 'Nada que actualizar' });
    const filtro = codigo ? ('codigo=eq.' + encodeURIComponent(codigo)) : ('id=eq.' + encodeURIComponent(id));
    const up = await sb('pedidos?' + filtro, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
    });
    if (!up.ok) throw new Error('patch pedido ' + up.status + ' ' + (await up.text()));
    const arr = await up.json();
    if (!arr[0]) return res.status(404).json({ error: 'no_encontrado' });
    return res.status(200).json(arr[0]);
  }

  return res.status(405).json({ error: 'metodo' });
}

// ============================================================
// CUPONES
// ============================================================
function saneaCupon(b, esNuevo) {
  const out = {};
  if (esNuevo || b.codigo !== undefined) {
    const codigo = String(b.codigo || '').trim().toUpperCase();
    if (esNuevo && !codigo) return { error: 'El código es obligatorio' };
    if (b.codigo !== undefined) out.codigo = codigo;
  }
  if (esNuevo || b.tipo !== undefined) {
    const tipo = String(b.tipo || '').trim();
    if ((esNuevo || b.tipo !== undefined) && !['porcentaje', 'fijo'].includes(tipo)) return { error: 'Tipo inválido' };
    if (b.tipo !== undefined) out.tipo = tipo;
  }
  if (esNuevo || b.valor !== undefined) {
    const valor = toNum(b.valor);
    if ((esNuevo || b.valor !== undefined)) {
      if (valor == null || valor < 0) return { error: 'Valor inválido' };
      out.valor = money(valor);
    }
  }
  if (b.usos_max !== undefined) {
    if (b.usos_max === null || b.usos_max === '') out.usos_max = null;
    else { const u = toInt(b.usos_max); if (u == null || u < 0) return { error: 'usos_max inválido' }; out.usos_max = u; }
  }
  if (b.vence_en !== undefined) {
    out.vence_en = (b.vence_en === null || b.vence_en === '') ? null : String(b.vence_en);
  }
  if (b.activo !== undefined) out.activo = !!b.activo;
  return { value: out };
}

async function recCupones(req, res) {
  if (req.method === 'GET') {
    const rr = await sb('cupones?select=id,codigo,tipo,valor,usos_max,usos,vence_en,activo&order=codigo.asc');
    if (!rr.ok) throw new Error('cupones ' + rr.status);
    return res.status(200).json(await rr.json());
  }

  if (req.method === 'POST') {
    const b = parseBody(req);
    const s = saneaCupon(b, true);
    if (s.error) return res.status(400).json({ error: 'datos', mensaje: s.error });
    const ins = await sb('cupones', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(s.value) });
    if (ins.status === 409) return res.status(409).json({ error: 'duplicado', mensaje: 'Ese código ya existe' });
    if (ins.status !== 201) throw new Error('insert cupon ' + ins.status + ' ' + (await ins.text()));
    return res.status(201).json((await ins.json())[0]);
  }

  if (req.method === 'PATCH') {
    const b = parseBody(req);
    const id = String(b.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id' });
    const s = saneaCupon(b, false);
    if (s.error) return res.status(400).json({ error: 'datos', mensaje: s.error });
    if (Object.keys(s.value).length === 0) return res.status(400).json({ error: 'vacio' });
    const up = await sb('cupones?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(s.value)
    });
    if (up.status === 409) return res.status(409).json({ error: 'duplicado', mensaje: 'Ese código ya existe' });
    if (!up.ok) throw new Error('patch cupon ' + up.status + ' ' + (await up.text()));
    const arr = await up.json();
    if (!arr[0]) return res.status(404).json({ error: 'no_encontrado' });
    return res.status(200).json(arr[0]);
  }

  return res.status(405).json({ error: 'metodo' });
}

// ============================================================
// ZONAS DE ENVÍO
// ============================================================
async function recZonas(req, res) {
  if (req.method === 'GET') {
    const rr = await sb('zonas_envio?select=id,nombre,costo_envio,dias_estimados,contraentrega&order=nombre.asc');
    if (!rr.ok) throw new Error('zonas ' + rr.status);
    return res.status(200).json(await rr.json());
  }

  if (req.method === 'PATCH') {
    const b = parseBody(req);
    const id = String(b.id || '').trim();
    const nombre = String(b.nombre || '').trim();
    if (!id && !nombre) return res.status(400).json({ error: 'id', mensaje: 'Falta id o nombre' });
    const out = {};
    if (b.costo_envio !== undefined) {
      const c = toNum(b.costo_envio);
      if (c == null || c < 0) return res.status(400).json({ error: 'datos', mensaje: 'Costo inválido' });
      out.costo_envio = money(c);
    }
    if (b.dias_estimados !== undefined) {
      const d = toInt(b.dias_estimados);
      if (d == null || d < 0) return res.status(400).json({ error: 'datos', mensaje: 'Días inválidos' });
      out.dias_estimados = d;
    }
    if (b.contraentrega !== undefined) out.contraentrega = !!b.contraentrega;
    if (Object.keys(out).length === 0) return res.status(400).json({ error: 'vacio' });
    const filtro = id ? ('id=eq.' + encodeURIComponent(id)) : ('nombre=eq.' + encodeURIComponent(nombre));
    const up = await sb('zonas_envio?' + filtro, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(out)
    });
    if (!up.ok) throw new Error('patch zona ' + up.status + ' ' + (await up.text()));
    const arr = await up.json();
    if (!arr[0]) return res.status(404).json({ error: 'no_encontrado' });
    return res.status(200).json(arr[0]);
  }

  return res.status(405).json({ error: 'metodo' });
}

// ============================================================
// CORREO DE PRUEBA (revisar el diseño una vez verificado el dominio)
// ============================================================
async function recTestEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  const b = parseBody(req);
  const to = String(b.to || '').trim();
  const r = await mailer.enviarPrueba(to);
  if (!r || !r.ok) {
    return res.status(502).json({ error: 'envio', mensaje: 'No se pudo enviar. ¿El dominio ya está verificado en Resend?', detalle: r });
  }
  return res.status(200).json({ ok: true, enviado_a: r.to });
}

// ============================================================
// SUBIR IMAGEN (Storage con service_role)
//
// El navegador manda el archivo crudo (application/octet-stream) con el
// nombre y el mime en la query. requireAdmin ya validó que es el admin;
// acá subimos al bucket con service_role, que IGNORA RLS. Por eso el
// permiso ya NO depende del token que el navegador le pase a Storage
// (era el punto frágil de la subida directa).
//
// Límite: el body de una función de Vercel no puede pasar ~4.5 MB; el
// cliente ya corta en 4 MB. Para archivos mayores habría que usar una
// signed upload URL (subida directa del navegador con token de un solo uso).
// ============================================================
async function leerBinario(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body && req.body.type === 'Buffer' && Array.isArray(req.body.data)) return Buffer.from(req.body.data);
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function recSubirImagen(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });

  const tipo = String((req.query && req.query.tipo) || '').trim().toLowerCase();
  const nombre = String((req.query && req.query.nombre) || 'imagen').trim();
  if (!IMG_TIPOS.includes(tipo)) {
    return res.status(400).json({ error: 'tipo', mensaje: 'Formato no permitido. Usá JPG, PNG, WebP, GIF o AVIF.' });
  }

  let buf;
  try { buf = await leerBinario(req); }
  catch (e) { return res.status(400).json({ error: 'body', mensaje: 'No se pudo leer el archivo' }); }
  if (!buf || !buf.length) return res.status(400).json({ error: 'vacio', mensaje: 'Archivo vacío' });
  if (buf.length > IMG_MAX_BYTES) return res.status(413).json({ error: 'grande', mensaje: 'La imagen supera el máximo (4 MB).' });

  const safe = (nombre.replace(/[^a-zA-Z0-9._-]/g, '_') || 'imagen');
  const path = Date.now() + '-' + safe;
  const base = process.env.SUPABASE_URL;
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const up = await fetch(base + '/storage/v1/object/' + IMG_BUCKET + '/' + encodeURIComponent(path), {
    method: 'POST',
    headers: {
      apikey: SR,
      Authorization: 'Bearer ' + SR,
      'Content-Type': tipo,
      'x-upsert': 'true'
    },
    body: buf
  });
  if (!up.ok) {
    const detalle = (await up.text().catch(() => '')).slice(0, 200);
    console.error('subir-imagen storage', up.status, detalle);
    return res.status(502).json({ error: 'storage', mensaje: 'Storage rechazó la subida', detalle });
  }

  const url = base + '/storage/v1/object/public/' + IMG_BUCKET + '/' + path;
  return res.status(201).json({ url });
}
