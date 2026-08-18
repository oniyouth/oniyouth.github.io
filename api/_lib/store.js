// ============================================================
// OniYouth · Helpers compartidos de /api (servidor)
//
// Archivo bajo api/_lib: el prefijo "_" hace que Vercel NO lo
// exponga como ruta/función. Se importa desde los endpoints.
//
// Todo aquí corre solo en el servidor con service_role (ignora RLS).
// Nunca se importa desde el navegador.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Origen permitido para CORS. Parametrizable por env (dominio final);
// default = producción. Con todo en Vercel (mismo origen) el CORS ni se
// dispara, pero deja fuera peticiones cross-origin de otros sitios.
const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || 'https://oniyouth.xyz';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function configOK() {
  return !!(SUPABASE_URL && SERVICE_KEY);
}

// Body puede llegar como objeto (Vercel lo parsea) o como string.
function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b || {};
}

// Fetch a la REST de Supabase con service_role.
async function sb(path, opts = {}) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

async function fetchCupon(codigo) {
  const r = await sb('cupones?select=codigo,tipo,valor,usos_max,usos,vence_en,activo'
    + '&codigo=eq.' + encodeURIComponent(codigo) + '&limit=1');
  if (!r.ok) throw new Error('Supabase cupones ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : null;
}

// Evalúa un cupón ya leído contra un subtotal. Lógica ÚNICA usada tanto
// por el preview (/api/validar-cupon) como por la compra (/api/crear-preferencia).
function evaluarCupon(cup, subtotal) {
  const no = { valido: false, mensaje: 'Cupón inválido o vencido' };
  if (!cup || !cup.activo) return no;
  if (cup.vence_en && new Date(cup.vence_en).getTime() < Date.now()) return no;
  if (cup.usos_max != null && Number(cup.usos) >= Number(cup.usos_max)) return no;
  let descuento = cup.tipo === 'porcentaje'
    ? money(subtotal * (Number(cup.valor) || 0) / 100)
    : money(cup.valor);
  if (descuento > subtotal) descuento = subtotal;
  if (descuento <= 0) return no;
  return { valido: true, descuento, tipo: cup.tipo, valor: Number(cup.valor) };
}

module.exports = { ALLOWED_ORIGIN, setCors, money, configOK, parseBody, sb, fetchCupon, evaluarCupon };
