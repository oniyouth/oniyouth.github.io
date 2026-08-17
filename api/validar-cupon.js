// ============================================================
// OniYouth · FASE 6 — Validación de cupón (SERVIDOR)
//
// El navegador NUNCA decide el descuento: solo muestra lo que este
// endpoint devuelve. La tabla `cupones` está cerrada por RLS a anon;
// aquí se lee con service_role (solo en el servidor, desde env).
//
// Es solo validación/preview: NO incrementa usos ni reserva nada.
// El descuento definitivo se recalcula en /api/crear-preferencia
// (Fase 7) con el subtotal calculado en el servidor.
//
// Runtime: función serverless de Vercel (Node). No corre en GitHub Pages.
// ============================================================

const ALLOWED_ORIGIN = 'https://oniyouth.xyz';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ valido: false, mensaje: 'Método no permitido' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ valido: false, mensaje: 'Servicio no configurado' });
  }

  // Body puede venir como objeto (Vercel lo parsea) o como string
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const codigo = String(body.codigo || '').trim().toUpperCase();
  const subtotal = money(body.subtotal);

  if (!codigo) return res.status(400).json({ valido: false, mensaje: 'Ingresa un código' });
  if (subtotal <= 0) return res.status(400).json({ valido: false, mensaje: 'Tu bolsa está vacía' });

  // Lectura del cupón con service_role (ignora RLS)
  let rows;
  try {
    const url = SUPABASE_URL + '/rest/v1/cupones?select=codigo,tipo,valor,usos_max,usos,vence_en,activo'
      + '&codigo=eq.' + encodeURIComponent(codigo) + '&limit=1';
    const r = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    if (!r.ok) throw new Error('Supabase ' + r.status);
    rows = await r.json();
  } catch (e) {
    console.error('validar-cupon:', e);
    return res.status(502).json({ valido: false, mensaje: 'No se pudo validar el cupón' });
  }

  const cup = Array.isArray(rows) && rows[0];
  const rechazo = { valido: false, mensaje: 'Cupón inválido o vencido' };

  if (!cup) return res.status(200).json(rechazo);
  if (!cup.activo) return res.status(200).json(rechazo);
  if (cup.vence_en && new Date(cup.vence_en).getTime() < Date.now()) return res.status(200).json(rechazo);
  if (cup.usos_max != null && Number(cup.usos) >= Number(cup.usos_max)) return res.status(200).json(rechazo);

  // Cálculo del descuento (topado al subtotal)
  let descuento;
  if (cup.tipo === 'porcentaje') {
    descuento = money(subtotal * (Number(cup.valor) || 0) / 100);
  } else { // 'fijo'
    descuento = money(cup.valor);
  }
  if (descuento > subtotal) descuento = subtotal;
  if (descuento <= 0) return res.status(200).json(rechazo);

  return res.status(200).json({
    valido: true,
    codigo: cup.codigo,
    tipo: cup.tipo,
    valor: Number(cup.valor),
    descuento: descuento,
    mensaje: 'Cupón aplicado'
  });
}
