// ============================================================
// OniYouth · FASE 8 — Webhook de Mercado Pago (SERVIDOR)
//
// Reglas:
//  - Valida la firma (x-signature, HMAC-SHA256 con MP_WEBHOOK_SECRET).
//  - NO confía en la notificación: consulta el pago real a la API de MP.
//  - Idempotente: si el payment_id ya se aplicó, responde 200 y no hace nada.
//  - Aprobado: descuenta stock (atómico) y marca 'pagado' en UNA transacción
//    vía registrar_pago_pedido (migración 003); dispara notificaciones (Fase 9).
//  - Revivido (migración 006): si el pedido estaba 'rechazado'/'cancelado' y
//    llega un approved de un intento paralelo, se marca 'pagado' igual PERO se
//    enciende una bandera de revisión y se avisa distinto (tipo 'pagado_revivido').
//  - Rechazado/cancelado: marca el pedido 'rechazado' (no hay stock que
//    liberar: solo se descuenta al aprobar).
//
// Runtime: función serverless de Vercel (Node). No corre en Pages.
// Requiere env MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET (Fase 7b).
// ============================================================

const crypto = require('crypto');
const { configOK, parseBody, sb } = require('./_lib/store');
const { notificarPago } = require('./_lib/mailer');

const MP_API = 'https://api.mercadopago.com';

// Firma x-signature de MP: "ts=<unix>,v1=<hmac>". Manifest:
//   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
function firmaValida(req, dataId) {
  // Blindaje: recorta espacios/newline que se cuelan al pegar el secreto en
  // el panel de env vars. Es la causa #1 de firmas que no matchean.
  const secretRaw = process.env.MP_WEBHOOK_SECRET || '';
  const secret = secretRaw.trim();
  if (!secret) { console.log('[webhook-mp] firma: falta MP_WEBHOOK_SECRET'); return false; }
  const h = req.headers || {};
  const xSig = h['x-signature'] || h['X-Signature'];
  const xReqId = h['x-request-id'] || h['X-Request-Id'] || '';
  if (!xSig) { console.log('[webhook-mp] firma: sin header x-signature'); return false; }
  let ts = '', v1 = '';
  String(xSig).split(',').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    const val = p.slice(i + 1).trim();
    if (k === 'ts') ts = val; else if (k === 'v1') v1 = val;
  });
  if (!ts || !v1) { console.log('[webhook-mp] firma: x-signature sin ts/v1'); return false; }
  const manifest = 'id:' + dataId + ';request-id:' + xReqId + ';ts:' + ts + ';';
  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(hmac);
  const b = Buffer.from(v1);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  // Log seguro: manifest, resultado, hashes (hmac/v1 son SHA256 — NO revelan el
  // secreto) y longitudes del secreto (raw vs trim). Si secret_raw_len != secret_len
  // había espacios/newline (el trim ya los mató). NUNCA se loguea el secreto.
  console.log('[webhook-mp] firma', JSON.stringify({
    manifest, ok,
    secret_len: secret.length, secret_raw_len: secretRaw.length,
    hmac, v1
  }));
  return ok;
}

async function mpGetPayment(id) {
  const r = await fetch(MP_API + '/v1/payments/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN }
  });
  if (!r.ok) throw new Error('MP payment ' + r.status);
  return r.json();
}

// Fase 9: correo al cliente + aviso al admin (Resend). Best-effort:
// notificarPago nunca lanza, pero envolvemos igual por si acaso. El pedido
// ya quedó pagado antes de llegar acá; el correo jamás rompe el webhook.
async function dispararNotificaciones(pedido, tipo) {
  try {
    await notificarPago(pedido, tipo);   // tipo: 'pagado' | 'pagado_revivido' | 'stock_error'
  } catch (e) { console.error('notificaciones:', e); }
}

module.exports = async function handler(req, res) {
  // Server-to-server: no CORS. Responder rápido.
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  if (!configOK() || !process.env.MP_ACCESS_TOKEN || !process.env.MP_WEBHOOK_SECRET) {
    console.log('[webhook-mp] 503 no_configurado', JSON.stringify({ cfg: configOK(), tok: !!process.env.MP_ACCESS_TOKEN, sec: !!process.env.MP_WEBHOOK_SECRET }));
    return res.status(503).json({ error: 'no_configurado' });
  }

  const body = parseBody(req);
  const query = req.query || {};
  const dataId = String(query['data.id'] || query.id || (body.data && body.data.id) || '').trim();
  const tipo = query.type || query.topic || body.type || body.topic;

  console.log('[webhook-mp] hit', JSON.stringify({
    method: req.method, tipo, dataId,
    hasSig: !!(req.headers && (req.headers['x-signature'] || req.headers['X-Signature'])),
    query
  }));

  // Solo notificaciones de pago
  if (tipo && String(tipo) !== 'payment') { console.log('[webhook-mp] ignorado por tipo:', String(tipo)); return res.status(200).json({ ignored: String(tipo) }); }
  if (!dataId) { console.log('[webhook-mp] ignorado: sin data.id'); return res.status(200).json({ ignored: 'sin data.id' }); }

  // 1. Firma
  if (!firmaValida(req, dataId)) { console.log('[webhook-mp] -> 401 firma inválida (data.id=' + dataId + ')'); return res.status(401).json({ error: 'firma' }); }

  try {
    // 2. Consultar el pago REAL (no confiar en la notificación)
    const pago = await mpGetPayment(dataId);
    const paymentId = String(pago.id);
    const estadoPago = pago.status;              // approved | rejected | cancelled | pending | ...
    const ref = pago.external_reference;         // = codigo del pedido
    console.log('[webhook-mp] pago', JSON.stringify({ paymentId, estadoPago, status_detail: pago.status_detail, ref }));

    // 3. Idempotencia por payment_id ya aplicado
    const rExist = await sb('pedidos?select=id&payment_id=eq.' + encodeURIComponent(paymentId) + '&limit=1');
    if (rExist.ok) {
      const ex = await rExist.json();
      if (Array.isArray(ex) && ex.length) { console.log('[webhook-mp] duplicado (payment_id ya aplicado)', paymentId); return res.status(200).json({ ok: true, duplicado: true }); }
    }
    if (!ref) { console.log('[webhook-mp] sin external_reference'); return res.status(200).json({ ok: true, sin_referencia: true }); }

    // 4. Aprobado -> registrar pago + descontar stock (atómico, idempotente)
    if (estadoPago === 'approved') {
      const rRpc = await sb('rpc/registrar_pago_pedido', {
        method: 'POST',
        body: JSON.stringify({ p_codigo: ref, p_payment_id: paymentId })
      });
      if (!rRpc.ok) { const t = await rRpc.text(); console.error('[webhook-mp] rpc ERROR', rRpc.status, t); throw new Error('rpc ' + rRpc.status + ' ' + t); }
      const resultado = await rRpc.json();   // 'ok' | 'revivido' | 'duplicado' | 'no_encontrado' | 'pagado_sin_stock'
      console.log('[webhook-mp] registrar_pago_pedido ->', JSON.stringify(resultado), 'ref', ref);

      if (resultado === 'ok' || resultado === 'revivido' || resultado === 'pagado_sin_stock') {
        const rp = await sb('pedidos?select=codigo,estado,cliente_email,cliente_nombre,cliente_telefono,direccion,distrito,items,subtotal,envio,descuento,total,revision_motivo&codigo=eq.' + encodeURIComponent(ref) + '&limit=1');
        const pedido = rp.ok ? (await rp.json())[0] : { codigo: ref };
        // Aviso DISTINTO por caso: 'pagado' normal, 'pagado_revivido' (pagó tras
        // rechazo/cancelación previa; el pedido quedó marcado para revisión),
        // 'stock_error' (pagó pero faltó stock).
        const tipoNotif = resultado === 'revivido' ? 'pagado_revivido'
                        : resultado === 'pagado_sin_stock' ? 'stock_error'
                        : 'pagado';
        await dispararNotificaciones(pedido, tipoNotif);
        if (resultado === 'revivido') console.warn('[webhook-mp] REVIVIDO: pedido pagado tras rechazo/cancelación previa, REVISAR', ref);
        if (resultado === 'pagado_sin_stock') console.error('PAGADO SIN STOCK, revisar pedido', ref);
      }
      return res.status(200).json({ ok: true, resultado });
    }

    // 5. Rechazado/cancelado -> marcar rechazado si sigue pendiente
    if (estadoPago === 'rejected' || estadoPago === 'cancelled') {
      console.log('[webhook-mp] pago', estadoPago, '-> marcando pedido rechazado', ref);
      await sb('pedidos?estado=eq.pendiente&codigo=eq.' + encodeURIComponent(ref), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'rechazado' })
      });
      return res.status(200).json({ ok: true, rechazado: true });
    }

    // pending / in_process / otros: sin cambios
    console.log('[webhook-mp] estado sin acción:', estadoPago, 'ref', ref);
    return res.status(200).json({ ok: true, estado: estadoPago });

  } catch (e) {
    console.error('webhook-mp:', e);
    // 500 -> MP reintenta la notificación más tarde
    return res.status(500).json({ error: 'servidor' });
  }
};
