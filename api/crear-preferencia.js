// ============================================================
// OniYouth · FASE 7 — Crear pedido + preferencia de pago (SERVIDOR)
//
// REGLA DE ORO: no se cree NADA de lo que manda el navegador. Aquí se
// recalcula todo desde la BD (service_role): precios, stock, envío y
// cupón. Del navegador solo se toman variante_id, cantidades, distrito,
// código de cupón y los datos del cliente.
//
// Flujo:
//   1. Validar entrada.
//   2. Recalcular precios y validar stock (sin descontarlo: eso ocurre
//      en el webhook al aprobarse el pago, Fase 8).
//   3. Recalcular envío (tabla distritos) y cupón (tabla cupones).
//   4. Crear el pedido en estado 'pendiente'.
//   5. [Fase 7b] Crear la preferencia en Mercado Pago y devolver el
//      init_point. Mientras no haya MP_ACCESS_TOKEN, se devuelve el
//      pedido creado con mp_configurado:false.
//
// Runtime: función serverless de Vercel (Node). No corre en Pages.
// ============================================================

const crypto = require('crypto');
const { setCors, money, configOK, parseBody, sb, fetchCupon, evaluarCupon } = require('./_lib/store');

// Envío gratis por encima de este subtotal (estricto: > 299). Regla de
// negocio global; se aplica SOLO en el servidor.
const UMBRAL_ENVIO_GRATIS = 299;

function codigoPedido() {
  return 'ONI-' + crypto.randomBytes(4).toString('hex').toUpperCase(); // ONI-XXXXXXXX
}

// Notificación al vendedor de un pedido contraentrega (Fase 9: stub).
async function notificarContraentrega(pedido) {
  try {
    // TODO Fase 9: avisar al vendedor (WhatsApp/correo) para coordinar la entrega.
    return;
  } catch (e) { console.error('notificarContraentrega:', e); }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo', mensaje: 'Método no permitido' });
  if (!configOK()) return res.status(500).json({ error: 'config', mensaje: 'Servicio no configurado' });

  const body = parseBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  const cli = body.cliente || {};
  const codigoCupon = body.cupon ? String(body.cupon).trim().toUpperCase() : '';

  // --- 1. Validación de entrada ---
  if (items.length === 0) return res.status(400).json({ error: 'items', mensaje: 'Tu bolsa está vacía' });

  const nombre    = String(cli.nombre    || '').trim();
  const telefono  = String(cli.telefono  || '').trim();
  const email     = String(cli.email     || '').trim();
  const direccion = String(cli.direccion || '').trim();
  const distritoN = String(cli.distrito  || '').trim();
  const referencia = String(cli.referencia || '').trim();

  const faltan = [];
  if (!nombre)    faltan.push('nombre');
  if (!telefono)  faltan.push('telefono');
  if (!direccion) faltan.push('direccion');
  if (!distritoN) faltan.push('distrito');
  if (faltan.length) return res.status(400).json({ error: 'datos', campos: faltan, mensaje: 'Faltan datos de envío' });

  // Normaliza items: solo variante_id + qty entero > 0. Suma duplicados.
  const idQty = {};
  for (const it of items) {
    const vid = String((it && it.variante_id) || '').trim();
    const qty = parseInt(it && it.qty, 10);
    if (!vid || !(qty > 0)) return res.status(400).json({ error: 'items', mensaje: 'Ítem inválido' });
    idQty[vid] = (idQty[vid] || 0) + qty;
  }
  const ids = Object.keys(idQty);

  try {
    // --- 2. Recalcular precios y validar stock desde la BD ---
    const rv = await sb('variantes?id=in.(' + ids.map(encodeURIComponent).join(',') +
      ')&select=id,talla,stock,producto_id,productos(id,nombre,precio,activo,imagenes)');
    if (!rv.ok) throw new Error('variantes ' + rv.status);
    const variantes = await rv.json();
    const byId = {};
    variantes.forEach(v => { byId[v.id] = v; });

    const pedidoItems = [];
    const sinStock = [];
    let subtotal = 0;

    for (const vid of ids) {
      const v = byId[vid];
      const qty = idQty[vid];
      const prod = v && v.productos;
      if (!v || !prod || !prod.activo) {
        return res.status(409).json({ error: 'no_disponible', mensaje: 'Un producto de tu bolsa ya no está disponible' });
      }
      if ((v.stock || 0) < qty) {
        sinStock.push({ variante_id: vid, nombre: prod.nombre, talla: v.talla, disponible: v.stock || 0 });
        continue;
      }
      const precio = Number(prod.precio) || 0;
      subtotal += precio * qty;
      pedidoItems.push({
        variante_id: vid, producto_id: prod.id, nombre: prod.nombre, talla: v.talla,
        precio_unit: money(precio), qty: qty, subtotal: money(precio * qty),
        img: Array.isArray(prod.imagenes) && prod.imagenes[0] ? prod.imagenes[0] : null
      });
    }
    if (sinStock.length) return res.status(409).json({ error: 'stock', items: sinStock, mensaje: 'No hay stock suficiente para algunos artículos' });
    subtotal = money(subtotal);

    // --- 3a. Envío desde la tabla zonas_envio ---
    const rd = await sb('zonas_envio?select=nombre,costo_envio,dias_estimados,contraentrega&nombre=eq.' +
      encodeURIComponent(distritoN) + '&limit=1');
    if (!rd.ok) throw new Error('zonas_envio ' + rd.status);
    const dRows = await rd.json();
    const zona = Array.isArray(dRows) && dRows[0];
    if (!zona) return res.status(400).json({ error: 'distrito', mensaje: 'Zona de envío no válida' });

    const esContraentrega = zona.contraentrega === true;
    // Envío: contraentrega y "envío gratis > 299" se deciden AQUÍ (server).
    let envio;
    if (esContraentrega) envio = 0;
    else envio = (subtotal > UMBRAL_ENVIO_GRATIS) ? 0 : money(zona.costo_envio);

    // --- 3b. Cupón recalculado en el servidor ---
    let descuento = 0;
    let cuponAplicado = null;
    if (codigoCupon) {
      const cup = await fetchCupon(codigoCupon);
      const ev = evaluarCupon(cup, subtotal);
      if (!ev.valido) return res.status(409).json({ error: 'cupon', mensaje: ev.mensaje });
      descuento = ev.descuento;
      cuponAplicado = cup.codigo;
    }

    const total = money(Math.max(0, subtotal - descuento + envio));

    // --- 4. Crear pedido (pendiente para pago online; contraentrega si aplica) ---
    const pedido = {
      codigo: codigoPedido(),
      estado: esContraentrega ? 'contraentrega' : 'pendiente',
      items: pedidoItems,
      subtotal, envio, descuento, total,
      cliente_nombre: nombre,
      cliente_telefono: telefono,
      cliente_email: email || null,
      // No hay columna de referencia: se anexa a la dirección para no perderla.
      direccion: referencia ? (direccion + ' (Ref: ' + referencia + ')') : direccion,
      distrito: distritoN
    };

    let pedidoRow = null;
    for (let intento = 0; intento < 3 && !pedidoRow; intento++) {
      const ins = await sb('pedidos', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(pedido)
      });
      if (ins.status === 201) { const arr = await ins.json(); pedidoRow = arr[0]; break; }
      if (ins.status === 409) { pedido.codigo = codigoPedido(); continue; } // código duplicado
      const txt = await ins.text();
      throw new Error('insert pedido ' + ins.status + ' ' + txt);
    }
    if (!pedidoRow) return res.status(500).json({ error: 'pedido', mensaje: 'No se pudo crear el pedido' });

    const resumen = { codigo: pedidoRow.codigo, subtotal, descuento, envio, total, cupon: cuponAplicado, contraentrega: esContraentrega };

    // --- 5a. Contraentrega: sin pago online. Reserva stock ya y notifica. ---
    if (esContraentrega) {
      const itemsRpc = pedidoItems.map(it => ({ variante_id: it.variante_id, cantidad: it.qty }));
      const rRes = await sb('rpc/descontar_stock_pedido', { method: 'POST', body: JSON.stringify({ p_items: itemsRpc }) });
      if (!rRes.ok) {
        // Carrera de stock: se cancela el pedido recién creado y se informa.
        await sb('pedidos?codigo=eq.' + encodeURIComponent(pedidoRow.codigo), {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ estado: 'cancelado' })
        });
        return res.status(409).json({ error: 'stock', mensaje: 'No hay stock suficiente para algunos artículos' });
      }
      await notificarContraentrega(pedidoRow);
      return res.status(200).json({
        ok: true, contraentrega: true, pedido: resumen,
        mensaje: 'Pedido registrado. Pagas al recibir; te contactaremos para coordinar.'
      });
    }

    // --- 5b. Pago online: preferencia de Mercado Pago (Fase 7b) ---
    if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(200).json({
        ok: true, mp_configurado: false, pedido: resumen,
        mensaje: 'Pedido registrado. El pago aún no está habilitado.'
      });
    }

    // TODO (Fase 7b): crear la preferencia en MP con external_reference =
    // pedidoRow.codigo, items/total recalculados, back_urls y notification_url
    // (webhook). Luego: UPDATE pedidos SET preference_id=... y devolver init_point.
    return res.status(501).json({ error: 'mp_pendiente', pedido: resumen, mensaje: 'Integración de pago en construcción' });

  } catch (e) {
    console.error('crear-preferencia:', e);
    return res.status(502).json({ error: 'servidor', mensaje: 'No se pudo procesar el pedido' });
  }
};
