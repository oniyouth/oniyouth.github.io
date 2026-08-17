// ============================================================
// OniYouth · FASE 8 — Webhook de Mercado Pago (SERVIDOR)
//
// Reglas:
//  - Valida la firma (x-signature, HMAC-SHA256 con MP_WEBHOOK_SECRET).
//  - NO confía en la notificación: consulta el pago real a la API de MP.
//  - Idempotente: si el payment_id ya se aplicó, responde 200 y no hace nada.
//  - Aprobado: descuenta stock (atómico) y marca 'pagado' en UNA transacción
//    vía registrar_pago_pedido (migración 003); dispara notificaciones (Fase 9).
//  - Rechazado/cancelado: marca el pedido 'rechazado' (no hay stock que
//    liberar: solo se descuenta al aprobar).
//
// Runtime: función serverless de Vercel (Node). No corre en Pages.
// Requiere env MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET (Fase 7b).
// ============================================================

const crypto = require('crypto');
const { configOK, parseBody, sb } = require('./_lib/store');

const MP_API = 'https://api.mercadopago.com';

// Firma x-signature de MP: "ts=<unix>,v1=<hmac>". Manifest:
//   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
function firmaValida(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;
  const h = req.headers || {};
  const xSig = h['x-signature'] || h['X-Signature'];
  const xReqId = h['x-request-id'] || h['X-Request-Id'] || '';
  if (!xSig) return false;
  let ts = '', v1 = '';
  String(xSig).split(',').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    const val = p.slice(i + 1).trim();
    if (k === 'ts') ts = val; else if (k === 'v1') v1 = val;
  });
  if (!ts || !v1) return false;
  const manifest = 'id:' + dataId + ';request-id:' + xReqId + ';ts:' + ts + ';';
  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(hmac);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function mpGetPayment(id) {
  const r = await fetch(MP_API + '/v1/payments/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN }
  });
  if (!r.ok) throw new Error('MP payment ' + r.status);
  return r.json();
}

// Fase 9 (stub): no debe romper el webhook si falla.
async function dispararNotificaciones(pedido, tipo) {
  try {
    // TODO Fase 9: correo al cliente (código + detalle) y aviso al admin.
    return;
  } catch (e) { console.error('notificaciones:', e); }
}

module.exports = async function handler(req, res) {
  // Server-to-server: no CORS. Responder rápido.
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  if (!configOK() || !process.env.MP_ACCESS_TOKEN || !process.env.MP_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'no_configurado' });
  }

  const body = parseBody(req);
  const query = req.query || {};
  const dataId = String(query['data.id'] || query.id || (body.data && body.data.id) || '').trim();
  const tipo = query.type || query.topic || body.type || body.topic;

  // Solo notificaciones de pago
  if (tipo && String(tipo) !== 'payment') return res.status(200).json({ ignored: String(tipo) });
  if (!dataId) return res.status(200).json({ ignored: 'sin data.id' });

  // 1. Firma
  if (!firmaValida(req, dataId)) return res.status(401).json({ error: 'firma' });

  try {
    // 2. Consultar el pago REAL (no confiar en la notificación)
    const pago = await mpGetPayment(dataId);
    const paymentId = String(pago.id);
    const estadoPago = pago.status;              // approved | rejected | cancelled | pending | ...
    const ref = pago.external_reference;         // = codigo del pedido

    // 3. Idempotencia por payment_id ya aplicado
    const rExist = await sb('pedidos?select=id&payment_id=eq.' + encodeURIComponent(paymentId) + '&limit=1');
    if (rExist.ok) {
      const ex = await rExist.json();
      if (Array.isArray(ex) && ex.length) return res.status(200).json({ ok: true, duplicado: true });
    }
    if (!ref) return res.status(200).json({ ok: true, sin_referencia: true });

    // 4. Aprobado -> registrar pago + descontar stock (atómico, idempotente)
    if (estadoPago === 'approved') {
      const rRpc = await sb('rpc/registrar_pago_pedido', {
        method: 'POST',
        body: JSON.stringify({ p_codigo: ref, p_payment_id: paymentId })
      });
      if (!rRpc.ok) { const t = await rRpc.text(); throw new Error('rpc ' + rRpc.status + ' ' + t); }
      const resultado = await rRpc.json();   // 'ok' | 'duplicado' | 'no_encontrado' | 'pagado_sin_stock'

      if (resultado === 'ok' || resultado === 'pagado_sin_stock') {
        const rp = await sb('pedidos?select=codigo,cliente_email,cliente_nombre,items,total&codigo=eq.' + encodeURIComponent(ref) + '&limit=1');
        const pedido = rp.ok ? (await rp.json())[0] : { codigo: ref };
        await dispararNotificaciones(pedido, resultado === 'ok' ? 'pagado' : 'stock_error');
        if (resultado === 'pagado_sin_stock') console.error('PAGADO SIN STOCK, revisar pedido', ref);
      }
      return res.status(200).json({ ok: true, resultado });
    }

    // 5. Rechazado/cancelado -> marcar rechazado si sigue pendiente
    if (estadoPago === 'rejected' || estadoPago === 'cancelled') {
      await sb('pedidos?estado=eq.pendiente&codigo=eq.' + encodeURIComponent(ref), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'rechazado' })
      });
      return res.status(200).json({ ok: true, rechazado: true });
    }

    // pending / in_process / otros: sin cambios
    return res.status(200).json({ ok: true, estado: estadoPago });

  } catch (e) {
    console.error('webhook-mp:', e);
    // 500 -> MP reintenta la notificación más tarde
    return res.status(500).json({ error: 'servidor' });
  }
};
