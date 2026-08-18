// ============================================================
// OniYouth · FASE 9 — Correos transaccionales con Resend (SERVIDOR)
//
// REGLA DE ORO: best-effort. Nada de esto puede romper el webhook ni el
// alta del pedido. sendEmail() NUNCA lanza: devuelve {ok:false,...} y se
// loguea. Los pedidos ya quedaron pagados/reservados antes de llamar acá.
//
// Sin SDK: fetch crudo a la API REST de Resend. Remitente = dominio propio
// (MAIL_FROM). Los avisos al admin van a NOTIFY_ADMIN_EMAIL (o ADMIN_EMAIL).
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';
const RESEND_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM  = process.env.MAIL_FROM || 'OniYouth <pedidos@oniyouth.xyz>';
const ADMIN_EMAIL = String(process.env.NOTIFY_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim();
const SITE_URL = String(process.env.SITE_URL || 'https://oniyouth.xyz').replace(/\/+$/, '');
const TIMEOUT_MS = 6000;

function money(n) { return 'S/ ' + (Number(n) || 0).toFixed(2); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------- envío base: NUNCA lanza --------
async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!RESEND_KEY) { console.warn('[mailer] sin RESEND_API_KEY; no se envía'); return { ok: false, error: 'no_api_key' }; }
  const dests = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
  if (!dests.length) return { ok: false, error: 'sin_destinatario' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const body = { from: MAIL_FROM, to: dests, subject, html };
    if (text) body.text = text;
    if (replyTo) body.reply_to = replyTo;
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn('[mailer] fallo', r.status, JSON.stringify(data).slice(0, 200)); return { ok: false, error: 'resend_' + r.status }; }
    console.log('[mailer] enviado', JSON.stringify({ id: data.id, to: dests, subject }));
    return { ok: true, id: data.id };
  } catch (e) {
    console.warn('[mailer] excepción', e && e.name, e && e.message);   // AbortError (timeout), red, etc.
    return { ok: false, error: 'excepcion' };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// PLANTILLAS (HTML + texto plano de fallback)
// ============================================================
function layout({ preheader, bodyHtml }) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '</head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#111">' +
    '<span style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(preheader || '') + '</span>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden">' +
    '<tr><td style="background:#000;padding:22px;text-align:center">' +
      '<div style="color:#fff;font-weight:bold;letter-spacing:4px;font-size:16px">ONIYOUTH</div>' +
    '</td></tr>' +
    '<tr><td style="padding:26px 24px">' + bodyHtml + '</td></tr>' +
    '<tr><td style="background:#000;color:#888;padding:16px;text-align:center;font-size:12px">OniYouth · Streetwear · Envíos a todo el Perú</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function itemsHtml(items) {
  const rows = (Array.isArray(items) ? items : []).map(it =>
    '<tr><td style="padding:7px 0;border-bottom:1px solid #eee;font-size:14px">' + esc(it.nombre) + ' · <span style="color:#888">T. ' + esc(it.talla) + '</span></td>' +
    '<td align="center" style="padding:7px 0;border-bottom:1px solid #eee;font-size:14px;color:#888">x' + (it.qty || 0) + '</td>' +
    '<td align="right" style="padding:7px 0;border-bottom:1px solid #eee;font-size:14px">' + money(it.subtotal) + '</td></tr>').join('');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + rows + '</table>';
}
function totalesHtml(p) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:10px">' +
    '<tr><td style="color:#888;padding:2px 0">Subtotal</td><td align="right">' + money(p.subtotal) + '</td></tr>' +
    '<tr><td style="color:#888;padding:2px 0">Envío</td><td align="right">' + money(p.envio) + '</td></tr>' +
    (Number(p.descuento) > 0 ? '<tr><td style="color:#888;padding:2px 0">Descuento</td><td align="right">-' + money(p.descuento) + '</td></tr>' : '') +
    '<tr><td style="font-weight:bold;padding-top:8px">Total</td><td align="right" style="font-weight:bold;padding-top:8px">' + money(p.total) + '</td></tr>' +
    '</table>';
}
function btn(href, label) {
  return '<a href="' + esc(href) + '" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;font-size:14px">' + esc(label) + '</a>';
}
function trackUrl(p) { return SITE_URL + '/pedido.html?codigo=' + encodeURIComponent(p.codigo || ''); }
function itemsText(items) {
  return (Array.isArray(items) ? items : []).map(it => '- ' + it.nombre + ' T.' + it.talla + ' x' + (it.qty || 0) + '  ' + money(it.subtotal)).join('\n');
}

// -------- Cliente: pago confirmado --------
function tplClientePagado(p) {
  const nombre = esc((p.cliente_nombre || '').split(' ')[0] || 'Hola');
  const body =
    '<h1 style="font-size:20px;margin:0 0 6px">¡Gracias, ' + nombre + '! 🎉</h1>' +
    '<p style="color:#555;font-size:14px;margin:0 0 18px">Recibimos tu pago y ya estamos preparando tu pedido <strong>' + esc(p.codigo) + '</strong>.</p>' +
    itemsHtml(p.items) + totalesHtml(p) +
    '<div style="text-align:center;margin:22px 0 6px">' + btn(trackUrl(p), 'Seguir mi pedido') + '</div>' +
    '<p style="color:#999;font-size:12px;text-align:center;margin:6px 0 0">Código de seguimiento: <strong>' + esc(p.codigo) + '</strong></p>';
  const text = '¡Gracias ' + nombre + '! Recibimos tu pago del pedido ' + p.codigo + '.\n\n' +
    itemsText(p.items) + '\n\nTotal: ' + money(p.total) + '\n\nSeguí tu pedido: ' + trackUrl(p);
  return { subject: 'Tu pedido ' + p.codigo + ' está confirmado ✓', html: layout({ preheader: 'Recibimos tu pago', bodyHtml: body }), text };
}

// -------- Cliente: pago recibido pero sin stock (mensaje suave) --------
function tplClientePagoRecibido(p) {
  const nombre = esc((p.cliente_nombre || '').split(' ')[0] || 'Hola');
  const body =
    '<h1 style="font-size:20px;margin:0 0 6px">Recibimos tu pago, ' + nombre + '</h1>' +
    '<p style="color:#555;font-size:14px;margin:0 0 18px">Tu pago del pedido <strong>' + esc(p.codigo) + '</strong> se registró. Estamos verificando la disponibilidad y te contactamos a la brevedad.</p>' +
    itemsHtml(p.items) + totalesHtml(p) +
    '<p style="color:#999;font-size:12px;margin:16px 0 0">Código: <strong>' + esc(p.codigo) + '</strong></p>';
  const text = 'Recibimos tu pago del pedido ' + p.codigo + '. Estamos verificando disponibilidad y te contactamos a la brevedad.';
  return { subject: 'Recibimos tu pago — pedido ' + p.codigo, html: layout({ preheader: 'Pago recibido', bodyHtml: body }), text };
}

// -------- Cliente: contraentrega registrado --------
function tplClienteContraentrega(p) {
  const nombre = esc((p.cliente_nombre || '').split(' ')[0] || 'Hola');
  const body =
    '<h1 style="font-size:20px;margin:0 0 6px">Pedido registrado, ' + nombre + ' ✅</h1>' +
    '<p style="color:#555;font-size:14px;margin:0 0 18px">Tu pedido <strong>' + esc(p.codigo) + '</strong> quedó registrado. <strong>Pagás al recibir.</strong> Te contactamos para coordinar la entrega.</p>' +
    itemsHtml(p.items) + totalesHtml(p) +
    '<div style="text-align:center;margin:22px 0 6px">' + btn(trackUrl(p), 'Ver mi pedido') + '</div>';
  const text = 'Pedido ' + p.codigo + ' registrado. Pagás al recibir; te contactamos para coordinar. Total: ' + money(p.total);
  return { subject: 'Pedido ' + p.codigo + ' registrado — pagás al recibir', html: layout({ preheader: 'Pagás al recibir', bodyHtml: body }), text };
}

// -------- Admin: contacto + dirección + detalle --------
function adminInfoHtml(p) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.7;margin:6px 0 14px">' +
    '<tr><td style="color:#888;width:90px">Cliente</td><td>' + esc(p.cliente_nombre || '—') + '</td></tr>' +
    '<tr><td style="color:#888">Teléfono</td><td>' + esc(p.cliente_telefono || '—') + '</td></tr>' +
    '<tr><td style="color:#888">Email</td><td>' + esc(p.cliente_email || '—') + '</td></tr>' +
    '<tr><td style="color:#888">Zona</td><td>' + esc(p.distrito || '—') + '</td></tr>' +
    '<tr><td style="color:#888">Dirección</td><td>' + esc(p.direccion || '—') + '</td></tr>' +
    '</table>';
}
function adminInfoText(p) {
  return 'Cliente: ' + (p.cliente_nombre || '—') + '\nTel: ' + (p.cliente_telefono || '—') +
    '\nEmail: ' + (p.cliente_email || '—') + '\nZona: ' + (p.distrito || '—') + '\nDir: ' + (p.direccion || '—');
}

// -------- Admin: venta pagada / revivida / sin stock --------
function tplAdminVenta(p, tipo) {
  let subject, alerta = '';
  if (tipo === 'pagado_revivido') {
    subject = '⚠️ REVISAR — venta revivida ' + p.codigo;
    alerta = '<div style="border:1px solid #d99;background:#fff3f3;border-radius:8px;padding:12px 14px;margin:0 0 16px">' +
      '<strong style="color:#b00">⚠ Pago revivido — revisar</strong><div style="color:#a55;font-size:13px;margin-top:4px">' +
      esc(p.revision_motivo || 'Este pedido estaba rechazado/cancelado y se pagó. Confirmá antes de enviar.') + '</div></div>';
  } else if (tipo === 'stock_error') {
    subject = '⚠️ PAGADO SIN STOCK ' + p.codigo + ' — revisar';
    alerta = '<div style="border:1px solid #d99;background:#fff3f3;border-radius:8px;padding:12px 14px;margin:0 0 16px">' +
      '<strong style="color:#b00">⚠ Pagado sin stock</strong><div style="color:#a55;font-size:13px;margin-top:4px">El pago entró pero no había stock suficiente. Revisar / reembolsar.</div></div>';
  } else {
    subject = '🟢 Nueva venta ' + p.codigo + ' — ' + money(p.total);
  }
  const body = alerta +
    '<h1 style="font-size:19px;margin:0 0 4px">Pedido ' + esc(p.codigo) + '</h1>' +
    '<p style="color:#555;font-size:13px;margin:0 0 12px">Estado: <strong>' + esc(p.estado || 'pagado') + '</strong> · ' + money(p.total) + '</p>' +
    adminInfoHtml(p) + itemsHtml(p.items) + totalesHtml(p);
  const text = subject + '\n\n' + adminInfoText(p) + '\n\n' + itemsText(p.items) + '\n\nTotal: ' + money(p.total);
  return { subject, html: layout({ preheader: subject, bodyHtml: body }), text };
}

// -------- Admin: contraentrega a coordinar --------
function tplAdminContraentrega(p) {
  const subject = '📦 Nuevo contraentrega ' + p.codigo + ' — coordinar entrega';
  const body =
    '<div style="border:1px solid #ccd;background:#f3f6ff;border-radius:8px;padding:12px 14px;margin:0 0 16px">' +
      '<strong>📦 Contraentrega</strong><div style="color:#557;font-size:13px;margin-top:4px">Pagás al recibir — coordinar entrega con el cliente.</div></div>' +
    '<h1 style="font-size:19px;margin:0 0 12px">Pedido ' + esc(p.codigo) + '</h1>' +
    adminInfoHtml(p) + itemsHtml(p.items) + totalesHtml(p);
  const text = subject + '\n\n' + adminInfoText(p) + '\n\n' + itemsText(p.items) + '\n\nTotal: ' + money(p.total);
  return { subject, html: layout({ preheader: subject, bodyHtml: body }), text };
}

// ============================================================
// FUNCIONES DE ALTO NIVEL (las que llaman los endpoints)
// Cada envío va aislado; nunca propagan error.
// ============================================================
async function notificarPago(pedido, tipo) {
  // tipo: 'pagado' | 'pagado_revivido' | 'stock_error'
  if (!pedido) return;
  const tasks = [];
  if (pedido.cliente_email) {
    const c = tipo === 'stock_error' ? tplClientePagoRecibido(pedido) : tplClientePagado(pedido);
    tasks.push(sendEmail({ to: pedido.cliente_email, subject: c.subject, html: c.html, text: c.text, replyTo: ADMIN_EMAIL || undefined }));
  }
  if (ADMIN_EMAIL) {
    const a = tplAdminVenta(pedido, tipo);
    tasks.push(sendEmail({ to: ADMIN_EMAIL, subject: a.subject, html: a.html, text: a.text }));
  }
  await Promise.allSettled(tasks);
}

async function notificarContraentrega(pedido) {
  if (!pedido) return;
  const tasks = [];
  if (pedido.cliente_email) {
    const c = tplClienteContraentrega(pedido);
    tasks.push(sendEmail({ to: pedido.cliente_email, subject: c.subject, html: c.html, text: c.text, replyTo: ADMIN_EMAIL || undefined }));
  }
  if (ADMIN_EMAIL) {
    const a = tplAdminContraentrega(pedido);
    tasks.push(sendEmail({ to: ADMIN_EMAIL, subject: a.subject, html: a.html, text: a.text }));
  }
  await Promise.allSettled(tasks);
}

module.exports = {
  sendEmail, notificarPago, notificarContraentrega,
  // exportadas para el preview/tests:
  tplClientePagado, tplClientePagoRecibido, tplClienteContraentrega, tplAdminVenta, tplAdminContraentrega
};
