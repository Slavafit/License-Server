import dashboardHtml from "../license-dashboard.html";

export interface Env {
  DB: D1Database;
  ADMIN_KEY: string;
  ADMIN_ORIGIN?: string;
}

type JsonObject = Record<string, unknown>;
type LicenseInput = { email: string; device_id: string; app_id: string; app_name: string };

const TRIAL_DAYS = 3;
const DAY_SECONDS = 86_400;
const MAX_BODY_BYTES = 8_192;
const MAX_ACTIVATIONS_PER_DAY = 5;
const SECURITY_HEADERS: HeadersInit = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

class ClientError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function now(): number { return Math.floor(Date.now() / 1000); }

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function withHeaders(response: Response, extra: HeadersInit): Response {
  const headers = new Headers(response.headers);
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function err(message: string, status = 400, code?: string): Response {
  return json({ ok: false, error: message, ...(code ? { code } : {}) }, status);
}

function methodNotAllowed(allowed: string): Response {
  return json({ ok: false, error: "Method not allowed", code: "method_not_allowed" }, 405, { Allow: allowed });
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await digest(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new ClientError(`${name} must be a string`);
  const result = value.trim();
  if (!result || result.length > max) throw new ClientError(`${name} must be between 1 and ${max} characters`);
  return result;
}

function parseLicense(body: unknown): LicenseInput {
  if (!isObject(body)) throw new ClientError("JSON object required");
  const email = cleanString(body.email, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ClientError("email is invalid");
  return {
    email,
    device_id: cleanString(body.device_id, "device_id", 200),
    app_id: cleanString(body.app_id, "app_id", 100),
    app_name: typeof body.app_name === "string" ? body.app_name.trim().slice(0, 100) : "",
  };
}

function positiveInteger(value: unknown, name: string, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ClientError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ClientError("Content-Type must be application/json", 415);
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ClientError("Request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new ClientError("Request body is too large", 413);
  try { return JSON.parse(text) as unknown; } catch { throw new ClientError("Invalid JSON"); }
}

function corsHeaders(request: Request, env: Env): HeadersInit | undefined {
  const origin = request.headers.get("Origin");
  if (!origin || !env.ADMIN_ORIGIN || origin !== env.ADMIN_ORIGIN) return undefined;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function clientIp(request: Request): string { return request.headers.get("CF-Connecting-IP") ?? "unknown"; }

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const provided = request.headers.get("X-Admin-Key") ?? "";
  return Boolean(provided && env.ADMIN_KEY && await secureEqual(provided, env.ADMIN_KEY));
}

async function limitActivation(request: Request, env: Env, appId: string): Promise<void> {
  const bucket = Math.floor(now() / DAY_SECONDS);
  const keyHash = await sha256(`${clientIp(request)}:${appId}`);
  await env.DB.prepare(
    `INSERT INTO activation_limits (key_hash, bucket, attempts) VALUES (?, ?, 1)
     ON CONFLICT(key_hash, bucket) DO UPDATE SET attempts = attempts + 1`,
  ).bind(keyHash, bucket).run();
  const row = await env.DB.prepare("SELECT attempts FROM activation_limits WHERE key_hash = ? AND bucket = ?")
    .bind(keyHash, bucket).first<{ attempts: number }>();
  if ((row?.attempts ?? 0) > MAX_ACTIVATIONS_PER_DAY) throw new ClientError("Too many activation attempts", 429);
}

async function audit(request: Request, env: Env, action: string, licenseId: number | null, details: JsonObject = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO admin_audit (action, license_id, actor, ip_hash, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(
    action,
    licenseId,
    request.headers.get("Cf-Access-Authenticated-User-Email") ?? "admin-key",
    await sha256(clientIp(request)),
    JSON.stringify(details),
    now(),
  ).run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request, env);
    if (method === "OPTIONS") return cors ? new Response(null, { status: 204, headers: cors }) : err("Origin not allowed", 403);
    try {
      let response: Response;
      if (url.pathname === "/activate") response = method === "POST" ? await activate(request, env) : methodNotAllowed("POST");
      else if (url.pathname === "/verify") response = method === "POST" ? await verify(request, env) : methodNotAllowed("POST");
      else if (url.pathname === "/health" && method === "GET") response = json({ ok: true });
      else if ((url.pathname === "/admin" || url.pathname === "/admin/") && method === "GET") response = dashboard();
      else if (url.pathname.startsWith("/admin/")) {
        response = await isAdmin(request, env)
          ? await routeAdmin(request, env, url.pathname, method)
          : json({ ok: false, error: "Unauthorized", code: "unauthorized" }, 401, { "WWW-Authenticate": "AdminKey" });
      } else response = err("Not found", 404, "not_found");
      return cors ? withHeaders(response, cors) : response;
    } catch (error) {
      if (error instanceof ClientError) return err(error.message, error.status);
      console.error(JSON.stringify({ message: "request_failed", method, path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return err("Internal server error", 500, "internal_error");
    }
  },
} satisfies ExportedHandler<Env>;

function dashboard(): Response {
  return new Response(dashboardHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function routeAdmin(request: Request, env: Env, path: string, method: string): Promise<Response> {
  if (path === "/admin/create") return method === "POST" ? adminCreate(request, env) : methodNotAllowed("POST");
  if (path === "/admin/revoke") return method === "POST" ? adminSetActive(request, env, false) : methodNotAllowed("POST");
  if (path === "/admin/restore") return method === "POST" ? adminSetActive(request, env, true) : methodNotAllowed("POST");
  if (path === "/admin/licenses") return method === "GET" ? adminList(request, env) : methodNotAllowed("GET");
  if (path === "/admin/apps") return method === "GET" ? adminApps(env) : methodNotAllowed("GET");
  if (path === "/admin/audit") return method === "GET" ? adminAudit(env) : methodNotAllowed("GET");
  return err("Not found", 404, "not_found");
}

async function activate(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const input = parseLicense(body);
  const suppliedToken = isObject(body) && typeof body.token === "string" ? body.token.trim() : "";
  await limitActivation(request, env, input.app_id);
  const existing = await env.DB.prepare(
    "SELECT token, is_active, expires_at, is_trial FROM licenses WHERE device_id = ? AND app_id = ? ORDER BY id DESC LIMIT 1",
  ).bind(input.device_id, input.app_id).first<{ token: string; is_active: number; expires_at: number | null; is_trial: number }>();

  if (existing) {
    if (!suppliedToken || !(await secureEqual(suppliedToken, existing.token))) {
      return json({ ok: false, reason: "already_registered", message: "This device is already registered. Verify with the stored token or contact support." }, 409);
    }
    if (!existing.is_active) return json({ ok: false, reason: "revoked" }, 403);
    if (existing.expires_at !== null && existing.expires_at <= now()) {
      return json({ ok: false, reason: existing.is_trial ? "trial_expired" : "expired" }, 403);
    }
    return json({ ok: true, token: existing.token, status: existing.is_trial ? "trial" : "active", expires_at: existing.expires_at });
  }

  const token = generateToken();
  const expiresAt = now() + TRIAL_DAYS * DAY_SECONDS;
  await env.DB.prepare(
    `INSERT INTO licenses (email, device_id, app_id, app_name, token, is_active, is_trial, expires_at, created_at)
     SELECT ?, ?, ?, ?, ?, 1, 1, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM licenses WHERE device_id = ? AND app_id = ?)`,
  ).bind(input.email, input.device_id, input.app_id, input.app_name, token, expiresAt, now(), input.device_id, input.app_id).run();
  const created = await env.DB.prepare("SELECT token FROM licenses WHERE device_id = ? AND app_id = ? ORDER BY id DESC LIMIT 1")
    .bind(input.device_id, input.app_id).first<{ token: string }>();
  if (!created || created.token !== token) return json({ ok: false, reason: "already_registered" }, 409);
  return json({ ok: true, token, status: "trial", expires_at: expiresAt }, 201);
}

async function verify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!isObject(body)) throw new ClientError("JSON object required");
  const token = cleanString(body.token, "token", 128);
  const deviceId = cleanString(body.device_id, "device_id", 200);
  const appId = cleanString(body.app_id, "app_id", 100);
  const row = await env.DB.prepare(
    "SELECT is_active, expires_at, device_id, is_trial FROM licenses WHERE token = ? AND app_id = ? LIMIT 1",
  ).bind(token, appId).first<{ is_active: number; expires_at: number | null; device_id: string; is_trial: number }>();
  if (!row) return json({ ok: false, valid: false, reason: "not_found" });
  if (!row.is_active) return json({ ok: false, valid: false, reason: "revoked" });
  if (row.expires_at !== null && row.expires_at <= now()) return json({ ok: false, valid: false, reason: row.is_trial ? "trial_expired" : "expired" });
  if (!(await secureEqual(deviceId, row.device_id))) return json({ ok: false, valid: false, reason: "device_mismatch" });
  return json({ ok: true, valid: true, status: row.is_trial ? "trial" : "active", expires_at: row.expires_at });
}

async function adminCreate(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const input = parseLicense(body);
  if (!isObject(body)) throw new ClientError("JSON object required");
  const days = positiveInteger(body.expires_days, "expires_days", 3650);
  const expiresAt = days === null ? null : now() + days * DAY_SECONDS;
  const existing = await env.DB.prepare("SELECT id FROM licenses WHERE device_id = ? AND app_id = ? ORDER BY id DESC LIMIT 1")
    .bind(input.device_id, input.app_id).first<{ id: number }>();
  if (existing) {
    await env.DB.prepare("UPDATE licenses SET is_active = 1, is_trial = 0, expires_at = ?, email = ?, app_name = ? WHERE id = ?")
      .bind(expiresAt, input.email, input.app_name, existing.id).run();
    await audit(request, env, "license.activated", existing.id, { expires_at: expiresAt });
    return json({ ok: true, id: existing.id, action: "activated" });
  }
  const token = generateToken();
  const result = await env.DB.prepare(
    "INSERT INTO licenses (email, device_id, app_id, app_name, token, is_active, is_trial, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)",
  ).bind(input.email, input.device_id, input.app_id, input.app_name, token, expiresAt, now()).run();
  const id = Number(result.meta.last_row_id);
  await audit(request, env, "license.created", id, { app_id: input.app_id, expires_at: expiresAt });
  return json({ ok: true, id, token, action: "created" }, 201);
}

async function adminSetActive(request: Request, env: Env, active: boolean): Promise<Response> {
  const body = await readJson(request);
  if (!isObject(body) || typeof body.id !== "number" || !Number.isInteger(body.id) || body.id < 1) throw new ClientError("A positive integer id is required");
  const result = await env.DB.prepare("UPDATE licenses SET is_active = ? WHERE id = ?").bind(active ? 1 : 0, body.id).run();
  if (result.meta.changes === 0) return err("License not found", 404, "not_found");
  await audit(request, env, active ? "license.restored" : "license.revoked", body.id);
  return json({ ok: true, id: body.id });
}

async function adminList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const appId = url.searchParams.get("app_id")?.trim().slice(0, 100) ?? "";
  const email = url.searchParams.get("email")?.trim().slice(0, 254) ?? "";
  const active = url.searchParams.get("active");
  const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  let query = `SELECT id, email, device_id, app_id, app_name, substr(token, -4) AS token_last4,
    is_active, is_trial, expires_at, created_at FROM licenses WHERE 1 = 1`;
  const params: Array<string | number> = [];
  if (appId) { query += " AND app_id = ?"; params.push(appId); }
  if (email) { query += " AND email LIKE ? ESCAPE '\\'"; params.push(`%${email.replace(/[\\%_]/g, "\\$&")}%`); }
  if (active === "0" || active === "1") { query += " AND is_active = ?"; params.push(Number(active)); }
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  const rows = await env.DB.prepare(query).bind(...params).all();
  return json({ ok: true, count: rows.results.length, licenses: rows.results });
}

async function adminApps(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT app_id, COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM licenses GROUP BY app_id ORDER BY app_id",
  ).all();
  return json({ ok: true, apps: rows.results });
}

async function adminAudit(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT id, action, license_id, actor, details, created_at FROM admin_audit ORDER BY id DESC LIMIT 100").all();
  return json({ ok: true, events: rows.results });
}
