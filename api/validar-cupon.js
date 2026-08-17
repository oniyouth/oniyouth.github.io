// ============================================================
// OniYouth · FASE 6 — Validación de cupón (SERVIDOR, solo preview)
//
// El navegador NUNCA decide el descuento: solo muestra lo que este
// endpoint devuelve. La tabla `cupones` está cerrada a anon por RLS;
// aquí se lee con service_role. NO incrementa usos ni reserva nada.
// El importe definitivo se recalcula en /api/crear-preferencia.
//
// Runtime: función serverless de Vercel (Node). No corre en Pages.
// ============================================================

const { setCors, money, configOK, parseBody, fetchCupon, evaluarCupon } = require('./_lib/store');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ valido: false, mensaje: 'Método no permitido' });
  if (!configOK()) return res.status(500).json({ valido: false, mensaje: 'Servicio no configurado' });

  const body = parseBody(req);
  const codigo = String(body.codigo || '').trim().toUpperCase();
  const subtotal = money(body.subtotal);

  if (!codigo) return res.status(400).json({ valido: false, mensaje: 'Ingresa un código' });
  if (subtotal <= 0) return res.status(400).json({ valido: false, mensaje: 'Tu bolsa está vacía' });

  let cup;
  try {
    cup = await fetchCupon(codigo);
  } catch (e) {
    console.error('validar-cupon:', e);
    return res.status(502).json({ valido: false, mensaje: 'No se pudo validar el cupón' });
  }

  const ev = evaluarCupon(cup, subtotal);
  if (!ev.valido) return res.status(200).json({ valido: false, mensaje: ev.mensaje });

  return res.status(200).json({
    valido: true,
    codigo: cup.codigo,
    tipo: ev.tipo,
    valor: ev.valor,
    descuento: ev.descuento,
    mensaje: 'Cupón aplicado'
  });
};
