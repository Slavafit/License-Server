export interface Env {
  DB: D1Database;
  ADMIN_KEY: string;
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

/** Генерация случайного токена (64 hex символа) */
async function generateToken(): Promise<string> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function checkAdmin(request: Request, env: Env): boolean {
  const key = request.headers.get("X-Admin-Key");
  return key === env.ADMIN_KEY;
}

// ── Роутер ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
        },
      });
    }

    try {
      // Публичные эндпоинты
      if (method === "POST" && path === "/activate") return activate(request, env);
      if (method === "POST" && path === "/verify")   return verify(request, env);

      // Админские эндпоинты
      if (!checkAdmin(request, env)) return err("Unauthorized", 401);

      if (method === "POST" && path === "/admin/create")       return adminCreate(request, env);
      if (method === "POST" && path === "/admin/revoke")       return adminRevoke(request, env);
      if (method === "POST" && path === "/admin/restore")      return adminRestore(request, env);
      if (method === "GET"  && path === "/admin/licenses")     return adminList(request, env);
      if (method === "GET"  && path === "/admin/apps")         return adminApps(request, env);

      return err("Not found", 404);
    } catch (e: any) {
      return err("Server error: " + e.message, 500);
    }
  },
};

// ── POST /activate ────────────────────────────────────────────────────────────
// Тело: { email, device_id, app_id }
// Если лицензия уже существует для этого device+app — возвращает существующий токен
// Если нет лицензии — создаёт неактивную запись (ждёт подтверждения через /admin/create)

async function activate(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json().catch(() => null);
  if (!body?.email || !body?.device_id || !body?.app_id) {
    return err("email, device_id and app_id are required");
  }

  const { email, device_id, app_id } = body;

  // Проверяем — есть ли уже активная лицензия для этого устройства+приложения
  const existing = await env.DB.prepare(
    "SELECT token, is_active, expires_at FROM licenses WHERE device_id = ? AND app_id = ? LIMIT 1"
  ).bind(device_id, app_id).first<{ token: string; is_active: number; expires_at: number | null }>();

  if (existing) {
    if (!existing.is_active) return json({ ok: false, error: "License revoked" }, 403);
    if (existing.expires_at && existing.expires_at < now()) return json({ ok: false, error: "License expired" }, 403);
    return json({ ok: true, token: existing.token, status: "active" });
  }

  // Создаём запись со статусом is_active=0 (ожидает активации администратором)
  const token = await generateToken();
  await env.DB.prepare(
    "INSERT INTO licenses (email, device_id, app_id, token, is_active, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).bind(email, device_id, app_id, token, now()).run();

  return json({ ok: false, status: "pending", message: "License request received. Contact developer to activate." }, 202);
}

// ── POST /verify ──────────────────────────────────────────────────────────────
// Тело: { token, device_id, app_id }

async function verify(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json().catch(() => null);
  if (!body?.token || !body?.device_id || !body?.app_id) {
    return err("token, device_id and app_id are required");
  }

  const { token, device_id, app_id } = body;

  const row = await env.DB.prepare(
    "SELECT is_active, expires_at, device_id FROM licenses WHERE token = ? AND app_id = ? LIMIT 1"
  ).bind(token, app_id).first<{ is_active: number; expires_at: number | null; device_id: string }>();

  if (!row) return json({ ok: false, valid: false, reason: "not_found" });
  if (!row.is_active) return json({ ok: false, valid: false, reason: "revoked" });
  if (row.expires_at && row.expires_at < now()) return json({ ok: false, valid: false, reason: "expired" });
  if (row.device_id !== device_id) return json({ ok: false, valid: false, reason: "device_mismatch" });

  return json({ ok: true, valid: true });
}

// ── POST /admin/create ────────────────────────────────────────────────────────
// Тело: { email, device_id, app_id, expires_days? }
// Создаёт активную лицензию (или активирует pending)

async function adminCreate(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json().catch(() => null);
  if (!body?.email || !body?.device_id || !body?.app_id) {
    return err("email, device_id and app_id are required");
  }

  const { email, device_id, app_id, expires_days } = body;
  const expires_at = expires_days ? now() + expires_days * 86400 : null;

  // Проверяем pending запись
  const pending = await env.DB.prepare(
    "SELECT id, token FROM licenses WHERE device_id = ? AND app_id = ? LIMIT 1"
  ).bind(device_id, app_id).first<{ id: number; token: string }>();

  if (pending) {
    // Активируем существующую
    await env.DB.prepare(
      "UPDATE licenses SET is_active = 1, expires_at = ?, email = ? WHERE id = ?"
    ).bind(expires_at, email, pending.id).run();
    return json({ ok: true, token: pending.token, action: "activated" });
  }

  // Создаём новую активную
  const token = await generateToken();
  await env.DB.prepare(
    "INSERT INTO licenses (email, device_id, app_id, token, is_active, expires_at, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
  ).bind(email, device_id, app_id, token, expires_at, now()).run();

  return json({ ok: true, token, action: "created" });
}

// ── POST /admin/revoke ────────────────────────────────────────────────────────
// Тело: { token } или { device_id, app_id }

async function adminRevoke(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json().catch(() => null);

  let result;
  if (body?.token) {
    result = await env.DB.prepare("UPDATE licenses SET is_active = 0 WHERE token = ?").bind(body.token).run();
  } else if (body?.device_id && body?.app_id) {
    result = await env.DB.prepare("UPDATE licenses SET is_active = 0 WHERE device_id = ? AND app_id = ?").bind(body.device_id, body.app_id).run();
  } else {
    return err("token or (device_id + app_id) required");
  }

  return json({ ok: true, revoked: result.meta.changes });
}

// ── POST /admin/restore ───────────────────────────────────────────────────────
// Тело: { token }

async function adminRestore(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json().catch(() => null);
  if (!body?.token) return err("token required");

  const result = await env.DB.prepare("UPDATE licenses SET is_active = 1 WHERE token = ?").bind(body.token).run();
  return json({ ok: true, restored: result.meta.changes });
}

// ── GET /admin/licenses ───────────────────────────────────────────────────────
// Query params: app_id?, email?, active?

async function adminList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const app_id = url.searchParams.get("app_id");
  const email  = url.searchParams.get("email");
  const active = url.searchParams.get("active"); // "1" или "0"

  let query = "SELECT id, email, device_id, app_id, token, is_active, expires_at, created_at FROM licenses WHERE 1=1";
  const params: any[] = [];

  if (app_id) { query += " AND app_id = ?"; params.push(app_id); }
  if (email)  { query += " AND email LIKE ?"; params.push(`%${email}%`); }
  if (active !== null) { query += " AND is_active = ?"; params.push(parseInt(active)); }

  query += " ORDER BY created_at DESC LIMIT 200";

  const rows = await env.DB.prepare(query).bind(...params).all();
  return json({ ok: true, count: rows.results.length, licenses: rows.results });
}

// ── GET /admin/apps ───────────────────────────────────────────────────────────
// Статистика по приложениям

async function adminApps(request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT app_id, COUNT(*) as total, SUM(is_active) as active FROM licenses GROUP BY app_id"
  ).all();
  return json({ ok: true, apps: rows.results });
}