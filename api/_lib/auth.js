// ============================================================
// OniYouth · Fase 11 — Guard de administración (SERVIDOR)
//
// requireAdmin(req): valida que la petición traiga el access_token de
// Supabase Auth del ÚNICO usuario admin. Dos cerraduras:
//   1. El token debe ser válido (lo verifica Supabase en /auth/v1/user).
//   2. El email del token debe ser exactamente ADMIN_EMAIL (allowlist).
//
// No abre RLS: las escrituras las sigue haciendo service_role dentro de
// /api. Este guard es lo que decide si /api/admin ejecuta o no.
//
// Se apoya en SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (ya en el entorno)
// como `apikey` de la llamada de verificación; la identidad sale del
// Bearer token del usuario, no del apikey.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// Devuelve { ok:true, user } o { ok:false, status, error }.
async function requireAdmin(req) {
  if (!SUPABASE_URL || !SERVICE_KEY) return { ok: false, status: 500, error: 'config' };
  if (!ADMIN_EMAIL) return { ok: false, status: 500, error: 'admin_no_config' };

  const raw = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'sin_token' };
  const token = m[1].trim();
  if (!token) return { ok: false, status: 401, error: 'sin_token' };

  let r;
  try {
    r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token }
    });
  } catch (e) {
    console.error('requireAdmin fetch:', e);
    return { ok: false, status: 502, error: 'auth_fetch' };
  }
  if (!r.ok) return { ok: false, status: 401, error: 'token_invalido' };

  let user;
  try { user = await r.json(); } catch (e) { return { ok: false, status: 401, error: 'token_invalido' }; }
  const email = String((user && user.email) || '').trim().toLowerCase();
  if (!email || email !== ADMIN_EMAIL) return { ok: false, status: 403, error: 'no_autorizado' };

  return { ok: true, user };
}

module.exports = { requireAdmin };
