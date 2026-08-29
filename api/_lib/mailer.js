// ============================================================
// OniYouth · FASE 9 — Correos transaccionales con Resend (SERVIDOR)
//
// REGLA DE ORO: best-effort. Nada de esto puede romper el webhook ni el
// alta del pedido. sendEmail() NUNCA lanza: devuelve {ok:false,...} y se
// loguea. Los pedidos ya quedaron pagados/reservados antes de llamar acá.
//
// Diseño: hereda la tienda (index.html / pedido.html). Fondo negro en todo
// el correo, tipografía email-safe con el MISMO tratamiento (mayúsculas +
// tracking en etiquetas, títulos con peso), botón blanco sin bordes,
// hairlines tenues, sin emojis, mucho aire. Tablas + estilos en línea +
// bgcolor para que aguante Gmail móvil y Outlook; si un cliente ignora el
// fondo oscuro, el bgcolor de las celdas mantiene el negro.
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';
const RESEND_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM  = process.env.MAIL_FROM || 'OniYouth <pedidos@oniyouth.xyz>';
const ADMIN_EMAIL = String(process.env.NOTIFY_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim();
const SITE_URL = String(process.env.SITE_URL || 'https://oniyouth.xyz').replace(/\/+$/, '');
// Logo del toro (blanco, transparente) subido al bucket público de Supabase.
const LOGO_URL = process.env.MAIL_LOGO_URL || 'https://oblekapcdajpueiteukv.supabase.co/storage/v1/object/public/productos/logo-oniyouth.png';
const TIMEOUT_MS = 6000;
const F = 'Helvetica,Arial,sans-serif';   // Syne no carga en email; el carácter va en el tratamiento.

function money(n) { return 'S/ ' + (Number(n) || 0).toFixed(2); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function trackUrl(p) { return SITE_URL + '/pedido.html?codigo=' + encodeURIComponent(p.codigo || ''); }

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
// PLANTILLAS — hereda el lenguaje visual de la tienda
// ============================================================
// Cáscara: fondo negro de punta a punta, logo del toro centrado y solo,
// pie de una línea gris apagado. bgcolor + color-scheme para el modo oscuro.
function layout({ preheader, bodyHtml }) {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">' +
    '</head><body style="margin:0;padding:0;background:#000000;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#000000;">' + esc(preheader || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background:#000000;border-collapse:collapse;">' +
    '<tr><td align="center" style="padding:40px 14px 34px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="width:100%;max-width:600px;background:#000000;border-collapse:collapse;">' +
    '<tr><td align="center" style="padding:4px 0 40px;">' +
      '<img src="' + LOGO_URL + '" width="32" height="48" alt="ONIYOUTH" ' +
      'style="display:block;width:32px;height:48px;border:0;outline:none;text-decoration:none;color:#ffffff;font:800 15px ' + F + ';letter-spacing:4px;">' +
    '</td></tr>' +
    '<tr><td bgcolor="#000000" style="background:#000000;padding:0 30px;">' + bodyHtml + '</td></tr>' +
    '<tr><td align="center" style="padding:52px 30px 0;">' +
      '<div style="font:400 10px/1.6 ' + F + ';letter-spacing:2.5px;text-transform:uppercase;color:#4d4d4d;">OniYouth &nbsp;·&nbsp; Streetwear &nbsp;·&nbsp; Env&iacute;os a todo el Per&uacute;</div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

// Encabezado: eyebrow (mayúsculas + tracking, como .sub de la web) + título + mensaje.
function head(opts) {
  const align = opts.center ? 'center' : 'left';
  const eColor = opts.eyebrowColor || '#7a7a7a';
  return '<div style="font:700 11px/1.4 ' + F + ';letter-spacing:4px;text-transform:uppercase;color:' + eColor + ';text-align:' + align + ';">' + esc(opts.eyebrow) + '</div>' +
    '<div style="font:800 26px/1.2 ' + F + ';letter-spacing:-0.4px;color:#ffffff;text-align:' + align + ';padding-top:13px;">' + esc(opts.title) + '</div>' +
    (opts.msg ? '<div style="font:400 15px/1.65 ' + F + ';color:#9a9a9a;text-align:' + align + ';padding-top:14px;">' + opts.msg + '</div>' : '');
}

// Detalle del pedido: hairline arriba, filas nombre + talla/cant / precio.
function itemsHtml(items) {
  const rows = (Array.isArray(items) ? items : []).map(it =>
    '<tr>' +
      '<td style="padding:13px 0;border-bottom:1px solid #202020;font:600 14px/1.35 ' + F + ';color:#ffffff;">' + esc(it.nombre) +
        '<div style="font:400 11px ' + F + ';letter-spacing:1.5px;text-transform:uppercase;color:#666666;padding-top:4px;">Talla ' + esc(it.talla) + ' &nbsp;·&nbsp; Cant ' + (it.qty || 0) + '</div></td>' +
      '<td align="right" valign="top" style="padding:13px 0;border-bottom:1px solid #202020;font:600 14px ' + F + ';color:#ffffff;white-space:nowrap;">' + money(it.subtotal) + '</td>' +
    '</tr>').join('');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #2c2c2c;margin-top:32px;">' + rows + '</table>';
}
function totalesHtml(p) {
  const row = (label, val, strong) => {
    const st = strong ? '700 15px' : '400 13px'; const col = strong ? '#ffffff' : '#8a8a8a'; const pt = strong ? '15' : '7';
    return '<tr><td style="padding-top:' + pt + 'px;font:' + st + ' ' + F + ';color:' + col + ';">' + label + '</td>' +
      '<td align="right" style="padding-top:' + pt + 'px;font:' + st + ' ' + F + ';color:' + col + ';white-space:nowrap;">' + val + '</td></tr>';
  };
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:18px;">' +
    row('Subtotal', money(p.subtotal)) + row('Env&iacute;o', money(p.envio)) +
    (Number(p.descuento) > 0 ? row('Descuento', '- ' + money(p.descuento)) : '') +
    row('Total', money(p.total), true) + '</table>';
}

// Bloque de envío para el cliente: distrito + dirección/agencia (la dirección
// ya trae empaquetado departamento/provincia y, si aplica, la agencia Shalom).
function envioCliente(p) {
  const linea = [p.distrito, p.direccion].filter(Boolean).join(' · ');
  if (!linea) return '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;border-top:1px solid #2c2c2c;">' +
    '<tr><td style="padding-top:16px;font:700 11px ' + F + ';letter-spacing:2px;text-transform:uppercase;color:#666666;">Env&iacute;o</td></tr>' +
    '<tr><td style="padding-top:6px;font:400 13px/1.55 ' + F + ';color:#9a9a9a;">' + esc(linea) + '</td></tr></table>';
}

// Botón único: blanco, texto negro, mayúsculas, tracking, SIN bordes redondeados. Centrado.
function btn(href, label) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:36px;"><tr><td align="center">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;">' +
    '<a href="' + esc(href) + '" target="_blank" style="display:inline-block;padding:15px 36px;font:700 12px ' + F + ';letter-spacing:2px;text-transform:uppercase;color:#000000;text-decoration:none;">' + esc(label) + '</a>' +
    '</td></tr></table></td></tr></table>';
}

// Texto plano de fallback
function itemsText(items) { return (Array.isArray(items) ? items : []).map(it => '- ' + it.nombre + ' / Talla ' + it.talla + ' x' + (it.qty || 0) + '  ' + money(it.subtotal)).join('\n'); }

// -------- Cliente: pago confirmado --------
function tplClientePagado(p) {
  const nom = firstName(p.cliente_nombre);
  const body = head({ center: true, eyebrow: 'Pago confirmado', title: nom ? ('Gracias, ' + nom) : 'Gracias',
    msg: 'Recibimos tu pago. Ya estamos preparando tu pedido <span style="color:#ffffff;">' + esc(p.codigo) + '</span>.' })
    + itemsHtml(p.items) + totalesHtml(p) + envioCliente(p) + btn(trackUrl(p), 'Seguir mi pedido');
  const text = 'PAGO CONFIRMADO\n\nGracias' + (nom ? ', ' + nom : '') + '. Recibimos tu pago del pedido ' + p.codigo + '.\n\n' +
    itemsText(p.items) + '\nTotal: ' + money(p.total) +
    ((p.distrito || p.direccion) ? '\n\nEnvio: ' + [p.distrito, p.direccion].filter(Boolean).join(' - ') : '') +
    '\n\nSeguimiento: ' + trackUrl(p);
  return { subject: 'Tu pedido ' + p.codigo + ' está confirmado', html: layout({ preheader: 'Recibimos tu pago', bodyHtml: body }), text };
}

// -------- Cliente: pago recibido sin stock (suave) --------
function tplClientePagoRecibido(p) {
  const body = head({ center: true, eyebrow: 'Pago recibido', title: 'Estamos con tu pedido',
    msg: 'Recibimos tu pago del pedido <span style="color:#ffffff;">' + esc(p.codigo) + '</span>. Estamos verificando la disponibilidad y te contactamos a la brevedad.' })
    + itemsHtml(p.items) + totalesHtml(p) + btn(trackUrl(p), 'Ver mi pedido');
  const text = 'PAGO RECIBIDO\n\nRecibimos tu pago del pedido ' + p.codigo + '. Verificamos disponibilidad y te contactamos a la brevedad.';
  return { subject: 'Recibimos tu pago — pedido ' + p.codigo, html: layout({ preheader: 'Pago recibido', bodyHtml: body }), text };
}

// -------- Cliente: contraentrega --------
function tplClienteContraentrega(p) {
  const body = head({ center: true, eyebrow: 'Pedido registrado', title: 'Pagás al recibir',
    msg: 'Registramos tu pedido <span style="color:#ffffff;">' + esc(p.codigo) + '</span>. Te contactamos para coordinar la entrega.' })
    + itemsHtml(p.items) + totalesHtml(p) + btn(trackUrl(p), 'Seguir mi pedido');
  const text = 'PEDIDO REGISTRADO\n\nPedido ' + p.codigo + ' registrado. Pagas al recibir; te contactamos para coordinar.\nTotal: ' + money(p.total);
  return { subject: 'Pedido ' + p.codigo + ' registrado — pagás al recibir', html: layout({ preheader: 'Pagás al recibir', bodyHtml: body }), text };
}

// ============================================================
// ADMIN — funcional y seco (no es de cara al cliente)
// ============================================================
function adminData(p) {
  const r = (k, v) => '<tr><td style="padding:4px 14px 4px 0;font:400 12px ' + F + ';color:#666666;white-space:nowrap;vertical-align:top;">' + k + '</td>' +
    '<td style="padding:4px 0;font:400 13px/1.5 ' + F + ';color:#cfcfcf;">' + esc(v || '—') + '</td></tr>';
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-collapse:collapse;">' +
    r('Cliente', p.cliente_nombre) + r('Teléfono', p.cliente_telefono) + r('Email', p.cliente_email) +
    r('Zona', p.distrito) + r('Dirección', p.direccion) + '</table>';
}
function adminDataText(p) {
  return 'Cliente: ' + (p.cliente_nombre || '-') + '\nTelefono: ' + (p.cliente_telefono || '-') + '\nEmail: ' + (p.cliente_email || '-') +
    '\nZona: ' + (p.distrito || '-') + '\nDireccion: ' + (p.direccion || '-');
}
// Callout de alerta: filete a la izquierda en el acento, etiqueta en mayúsculas.
function callout(color, label, text) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr>' +
    '<td style="border-left:3px solid ' + color + ';padding:1px 0 1px 14px;">' +
      '<div style="font:700 11px ' + F + ';letter-spacing:2px;text-transform:uppercase;color:' + color + ';">' + esc(label) + '</div>' +
      (text ? '<div style="font:400 13px/1.55 ' + F + ';color:#9a9a9a;padding-top:6px;">' + esc(text) + '</div>' : '') +
    '</td></tr></table>';
}
// Enlace seco (sin botón blanco): subrayado tenue.
function linkPlain(href, label) {
  return '<div style="margin-top:30px;"><a href="' + esc(href) + '" target="_blank" style="font:700 12px ' + F + ';letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;border-bottom:1px solid #444444;padding-bottom:2px;">' + esc(label) + ' &rarr;</a></div>';
}

// Admin: venta pagada / revivida / sin stock
function tplAdminVenta(p, tipo) {
  let subject, eyebrow, eColor = '#9a9a9a', alerta = '';
  if (tipo === 'pagado_revivido') {
    subject = 'REVISAR · venta revivida ' + p.codigo;
    eyebrow = 'Revisar · pago revivido'; eColor = '#d9a441';
    alerta = callout('#d9a441', 'Pagó tras rechazo', p.revision_motivo || 'Este pedido estaba rechazado/cancelado y se pagó. Confirmar antes de enviar.');
  } else if (tipo === 'stock_error') {
    subject = 'PAGADO SIN STOCK · ' + p.codigo;
    eyebrow = 'Pagado sin stock'; eColor = '#e06666';
    alerta = callout('#e06666', 'Revisar / reembolsar', 'El pago entró pero no había stock suficiente.');
  } else {
    subject = 'Nueva venta ' + p.codigo + ' · ' + money(p.total);
    eyebrow = 'Nueva venta';
  }
  const body = head({ center: false, eyebrow: eyebrow, eyebrowColor: eColor, title: p.codigo,
    msg: '<span style="text-transform:uppercase;letter-spacing:1px;font-size:12px;">' + esc(p.estado || 'pagado') + '</span> &nbsp;·&nbsp; ' + money(p.total) })
    + alerta + adminData(p) + itemsHtml(p.items) + totalesHtml(p) + linkPlain(trackUrl(p), 'Ver seguimiento');
  const text = subject + '\n\n' + adminDataText(p) + '\n\n' + itemsText(p.items) + '\nTotal: ' + money(p.total) + '\n\n' + trackUrl(p);
  return { subject, html: layout({ preheader: eyebrow + ' ' + p.codigo, bodyHtml: body }), text };
}

// Admin: contraentrega a coordinar
function tplAdminContraentrega(p) {
  const subject = 'Nuevo contraentrega ' + p.codigo;
  const body = head({ center: false, eyebrow: 'Contraentrega · coordinar', title: p.codigo,
    msg: '<span style="text-transform:uppercase;letter-spacing:1px;font-size:12px;">Pagás al recibir</span> &nbsp;·&nbsp; ' + money(p.total) })
    + adminData(p) + itemsHtml(p.items) + totalesHtml(p) + linkPlain(trackUrl(p), 'Ver seguimiento');
  const text = subject + '\n\n' + adminDataText(p) + '\n\n' + itemsText(p.items) + '\nTotal: ' + money(p.total) + '\n\n' + trackUrl(p);
  return { subject, html: layout({ preheader: 'Contraentrega ' + p.codigo, bodyHtml: body }), text };
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

// Envío de PRUEBA (desde el panel): manda un ejemplo cliente + admin a `to`
// (o al admin). Sirve para revisar el diseño una vez verificado el dominio.
async function enviarPrueba(to) {
  const dest = String(to || '').trim() || ADMIN_EMAIL;
  if (!dest) return { ok: false, error: 'sin_destinatario' };
  const p = {
    codigo: 'ONI-PRUEBA', estado: 'pagado',
    cliente_nombre: 'Cliente de Prueba', cliente_email: dest, cliente_telefono: '999 999 999',
    direccion: 'Av. Ejemplo 123', distrito: 'Lima',
    items: [{ nombre: 'oniyouth stars', talla: 'M', qty: 2, subtotal: 179.98 }, { nombre: 'ONIYOUTH TRIBAL TEE', talla: 'L', qty: 1, subtotal: 89.99 }],
    subtotal: 269.97, envio: 12, descuento: 0, total: 281.97
  };
  const cli = tplClientePagado(p);
  const adm = tplAdminVenta(p, 'pagado');
  const r1 = await sendEmail({ to: dest, subject: '[PRUEBA] ' + cli.subject, html: cli.html, text: cli.text, replyTo: ADMIN_EMAIL || undefined });
  const r2 = await sendEmail({ to: dest, subject: '[PRUEBA] ' + adm.subject, html: adm.html, text: adm.text });
  return { ok: r1.ok || r2.ok, to: dest, cliente: r1, admin: r2 };
}

module.exports = {
  sendEmail, notificarPago, notificarContraentrega, enviarPrueba,
  // exportadas para el preview/tests:
  tplClientePagado, tplClientePagoRecibido, tplClienteContraentrega, tplAdminVenta, tplAdminContraentrega
};
