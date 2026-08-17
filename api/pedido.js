// ============================================================
// OniYouth · FASE 10 — Consulta pública de pedido (SERVIDOR)
//
// GET /api/pedido?codigo=ONI-XXXXXXXX
//
// La tabla pedidos está cerrada a anon por RLS: esta consulta usa
// service_role pero devuelve SOLO campos públicos (estado, items,
// montos, distrito, fecha estimada). NUNCA PII (nombre/teléfono/
// email/dirección), porque el código podría adivinarse.
//
// Runtime: función serverless de Vercel (Node). No corre en Pages.
// ============================================================

const { configOK, sb } = require('./_lib/store');

const ALLOWED_ORIGIN = 'https://oniyouth.xyz';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo' });
  if (!configOK()) return res.status(500).json({ error: 'config' });

  const codigo = String((req.query && req.query.codigo) || '').trim().toUpperCase();
  if (!codigo || codigo.length > 40) return res.status(400).json({ error: 'codigo', mensaje: 'Código inválido' });

  try {
    const r = await sb('pedidos?select=codigo,estado,items,subtotal,envio,descuento,total,distrito,creado_en'
      + '&codigo=eq.' + encodeURIComponent(codigo) + '&limit=1');
    if (!r.ok) throw new Error('pedidos ' + r.status);
    const rows = await r.json();
    const p = Array.isArray(rows) && rows[0];
    if (!p) return res.status(404).json({ error: 'no_encontrado', mensaje: 'No encontramos un pedido con ese código' });

    // Días estimados: se busca por el nombre de distrito guardado (si aún existe)
    let dias_estimados = null;
    if (p.distrito) {
      const rd = await sb('distritos?select=dias_estimados&nombre=eq.' + encodeURIComponent(p.distrito) + '&limit=1');
      if (rd.ok) { const d = await rd.json(); if (Array.isArray(d) && d[0]) dias_estimados = d[0].dias_estimados; }
    }

    // Solo campos públicos del snapshot de items
    const items = Array.isArray(p.items) ? p.items.map(it => ({
      nombre: it.nombre, talla: it.talla, qty: it.qty,
      precio_unit: it.precio_unit, subtotal: it.subtotal, img: it.img || null
    })) : [];

    return res.status(200).json({
      codigo: p.codigo,
      estado: p.estado,
      creado_en: p.creado_en,
      dias_estimados: dias_estimados,
      distrito: p.distrito,
      items: items,
      subtotal: p.subtotal, envio: p.envio, descuento: p.descuento, total: p.total
    });
  } catch (e) {
    console.error('pedido:', e);
    return res.status(502).json({ error: 'servidor', mensaje: 'No se pudo consultar el pedido' });
  }
};
