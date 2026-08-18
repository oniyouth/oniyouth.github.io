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
//   variantes  PATCH (stock, 1 o varias) · POST (nueva talla) · DELETE (quitar talla)
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
      case 'variantes': return await recVariantes(req, res);
      case 'pedidos':   return await recPedidos(req, res);
      case 'cupones':   return await recCupones(req, res);
      case 'zonas':     return await recZonas(req, res);
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
    const rr = await sb('productos?select=id,nombre,descripcion,precio,categoria,imagenes,activo,orden,creado_en,'
      + 'variantes(id,talla,stock,sku)&order=orden.asc');
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
    // Variantes por defecto XS–XL con stock 0 (como el seed). Best-effort.
    const vs = TALLAS_DEFAULT.map(t => ({ producto_id: prod.id, talla: t, stock: 0 }));
    const iv = await sb('variantes', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(vs) });
    if (!iv.ok) console.error('crear variantes por defecto:', iv.status, await iv.text());
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
    const talla = String(b.talla || '').trim();
    const stock = toInt(b.stock);
    if (!producto_id || !talla) return res.status(400).json({ error: 'datos', mensaje: 'Falta producto o talla' });
    const row = { producto_id, talla, stock: (stock == null || stock < 0) ? 0 : stock };
    if (b.sku) row.sku = String(b.sku).trim();
    const ins = await sb('variantes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (ins.status === 409) return res.status(409).json({ error: 'duplicado', mensaje: 'Esa talla ya existe' });
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
