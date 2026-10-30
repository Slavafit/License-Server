import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, verify } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/0003-firebase-auth.sql', import.meta.url), 'utf8');
const bundle = await build({ entryPoints: ['src/secure.ts'], bundle: true, write: false, format: 'esm', loader: { '.html': 'text' } });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const bindings = {
  ADMIN_KEY: 'local-test-admin', FIREBASE_PROJECT_ID: 'fastscan-pro-1816f',
  FIREBASE_CLIENT_EMAIL: 'test@fastscan-pro-1816f.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'),
};
async function setup(overrides = {}) {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-13', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], bindings: { ...bindings, ...overrides }, log: new Log(LogLevel.NONE) });
  return { mf, db: await mf.getD1Database('DB') };
}
async function sql(db, text) {
  for (const statement of text.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) await db.prepare(statement).run();
}
let ip = 0;
async function api(mf, path, body, admin = false) {
  const response = await mf.dispatchFetch(`https://local.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${++ip}`,
      ...(admin ? { 'X-Admin-Key': bindings.ADMIN_KEY } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
function input(device, extra = {}) {
  return { email: 'user@example.com', device_id: device, app_id: 'com.ocr.fastscan', ...extra };
}
function decode(token) {
  const [header, payload, signature] = token.split('.');
  assert(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  const result = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(result.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
  assert.equal(result.iss, bindings.FIREBASE_CLIENT_EMAIL);
  assert.equal(result.sub, result.iss);
  assert.equal(result.exp - result.iat, 3600);
  assert(Math.abs(result.iat - Date.now() / 1000) < 10);
  return result;
}
function ordinary(data) {
  for (const field of ['warehouse_id', 'country_code', 'firebase_token', 'tenant_id']) assert(!(field in data));
}

test('fresh local D1 schema and one-time legacy migration', async () => {
  const { mf, db } = await setup();
  try {
    const legacy = schema.replace('    warehouse_id TEXT,\n    country_code TEXT,\n', '').replace('CREATE INDEX IF NOT EXISTS idx_warehouse ON licenses(warehouse_id);', '');
    await sql(db, legacy);
    await sql(db, `INSERT INTO licenses(email, device_id, app_id, token, created_at) VALUES
      ('a@example.com','one','com.ocr.fastscan','one',1), ('b@example.com','two','other.app','two',1);`);
    await sql(db, migration);
    const rows = (await db.prepare('SELECT app_id, warehouse_id, country_code FROM licenses ORDER BY id').all()).results;
    assert.deepEqual(rows, [
      { app_id: 'com.ocr.fastscan', warehouse_id: 'es-main', country_code: 'ES' },
      { app_id: 'other.app', warehouse_id: null, country_code: null },
    ]);
    await assert.rejects(sql(db, migration), /duplicate column/);
  } finally { await mf.dispose(); }
});

test('activation, JWT, warehouse admin, device isolation, renewal and invalid licenses', async () => {
  const { mf, db } = await setup();
  try {
    await sql(db, schema);
    assert.deepEqual((await api(mf, '/health')).data, { ok: true, firebase_auth_configured: true });
    const normal = await api(mf, '/activate', input('ordinary', { app_id: 'other.app' }));
    assert.equal(normal.status, 201); ordinary(normal.data);
    assert.deepEqual(Object.keys(normal.data).sort(), ['expires_at','ok','status','token']);
    ordinary((await api(mf, '/verify', { ...input('ordinary', { app_id: 'other.app' }), token: normal.data.token })).data);
    ordinary((await api(mf, '/activate', { ...input('ordinary', { app_id: 'other.app', country_code: 'US' }), token: normal.data.token })).data);
    assert.equal((await api(mf, '/activate', input('ordinary', { app_id: 'other.app' }))).status, 409);
    const noCountry = await api(mf, '/activate', input('no-country')); ordinary(noCountry.data);
    const trial = (await api(mf, '/activate', input('us', { country_code: 'US', warehouse_id: 'us-main' }))).data;
    assert.equal(trial.ok, true); assert.equal(trial.country_code, 'US');
    const jwt = decode(trial.firebase_token);
    assert.equal(trial.warehouse_id, `license-${jwt.claims.license_id}`);
    assert.equal(jwt.uid, `license:${jwt.claims.license_id}`);
    assert.deepEqual(jwt.claims, { warehouse_id: trial.warehouse_id, country_code: 'US', license_active: true,
      license_expires_at: trial.expires_at, license_id: jwt.claims.license_id, app_id: 'com.ocr.fastscan' });
    const id = jwt.claims.license_id;
    const reactivated = await api(mf, '/activate', { ...input('us', { country_code: 'ES' }), token: trial.token });
    assert.equal(reactivated.status, 200);
    assert.equal(decode(reactivated.data.firebase_token).claims.warehouse_id, trial.warehouse_id);
    assert.equal(reactivated.data.country_code, 'US');
    const check = extra => api(mf, '/verify', { token: trial.token, device_id: 'us', app_id: 'com.ocr.fastscan', ...extra });
    assert.equal((await check({ country_code: 'ES' })).data.warehouse_id, trial.warehouse_id);
    assert.equal((await check({ device_id: 'wrong' })).data.reason, 'device_mismatch');
    assert.equal((await check({ app_id: 'wrong' })).data.reason, 'not_found');
    assert.equal((await api(mf, '/admin/warehouse', { id, warehouse_id: 'es-main' })).status, 401);
    for (const invalid of ['Bad', '-bad', '../es-main', 'x'.repeat(65), 123]) {
      assert.equal((await api(mf, '/admin/warehouse', { id, warehouse_id: invalid }, true)).status, 400);
    }
    assert.equal((await api(mf, '/admin/warehouse', { id: 999, warehouse_id: 'es-main' }, true)).status, 404);
    for (const [warehouse_id, country_code] of [['es-main','ES'],['es-2','ES'],['us-main','US']]) {
      assert.deepEqual((await api(mf, '/admin/warehouse', { id, warehouse_id }, true)).data, { ok: true, id, warehouse_id, country_code });
      assert.equal(decode((await check()).data.firebase_token).claims.warehouse_id, warehouse_id);
    }
    // Contact email grants no warehouse access, even within the same application.
    const isolated = (await api(mf, '/activate', input('second', { country_code: 'ES', warehouse_id: 'us-main' }))).data;
    const isolatedClaims = decode(isolated.firebase_token).claims;
    assert.equal(isolated.warehouse_id, `license-${isolatedClaims.license_id}`);
    assert.notEqual(isolated.warehouse_id, trial.warehouse_id);
    assert.equal(isolated.country_code, 'ES');
    const sameCountry = (await api(mf, '/activate', input('same-country', { country_code: 'US' }))).data;
    assert.equal(sameCountry.warehouse_id, `license-${decode(sameCountry.firebase_token).claims.license_id}`);
    assert.notEqual(sameCountry.warehouse_id, isolated.warehouse_id);
    const withoutCountry = (await api(mf, '/activate', input('same-email-no-country'))).data;
    ordinary(withoutCountry);
    assert.deepEqual(await db.prepare('SELECT warehouse_id, country_code FROM licenses WHERE device_id = ?')
      .bind('same-email-no-country').first(), { warehouse_id: null, country_code: null });
    const stillAssigned = (await api(mf, '/activate', { ...input('us', { country_code: 'ES' }), token: trial.token })).data;
    assert.equal(stillAssigned.warehouse_id, 'us-main');
    assert.equal(stillAssigned.country_code, 'US');
    assert.equal(decode(stillAssigned.firebase_token).claims.warehouse_id, 'us-main');
    const different = (await api(mf, '/activate', input('third', { app_id: 'different.app', country_code: 'ES' }))).data;
    assert.match(different.warehouse_id, /^license-\d+$/);
    await api(mf, '/admin/create', input('us', { expires_days: 30 }), true);
    assert.equal((await check()).data.warehouse_id, 'us-main');
    await api(mf, '/admin/create', input('us'), true);
    assert.equal(decode((await check()).data.firebase_token).claims.license_expires_at, 0);
    await api(mf, '/admin/revoke', { id }, true);
    const revoked = (await check()).data; assert.equal(revoked.reason, 'revoked'); ordinary(revoked);
    await api(mf, '/admin/restore', { id }, true);
    await db.prepare('UPDATE licenses SET expires_at = 1 WHERE id = ?').bind(id).run();
    const expired = (await check()).data; assert.equal(expired.reason, 'expired'); ordinary(expired);
    await api(mf, '/admin/create', input('us'), true);
    for (const warehouse_id of ['', null]) {
      await api(mf, '/admin/warehouse', { id, warehouse_id }, true);
      ordinary((await check()).data);
      assert.deepEqual(await db.prepare('SELECT warehouse_id, country_code FROM licenses WHERE id = ?').bind(id).first(), { warehouse_id: null, country_code: null });
    }
    const adminNormal = await api(mf, '/admin/create', input('admin-normal', { app_id: 'normal.app' }), true);
    ordinary((await api(mf, '/verify', { ...input('admin-normal', { app_id: 'normal.app' }), token: adminNormal.data.token })).data);
    const adminShared = await api(mf, '/admin/create', input('admin-shared', { app_id: 'another.app', warehouse_id: 'es-main', country_code: 'ES' }), true);
    const shared = (await api(mf, '/verify', { ...input('admin-shared', { app_id: 'another.app' }), token: adminShared.data.token })).data;
    assert.equal(decode(shared.firebase_token).claims.warehouse_id, 'es-main');
    assert.equal((await api(mf, '/admin/create', input('conflict', { warehouse_id: 'es-main', country_code: 'US' }), true)).status, 400);
    assert.equal((await api(mf, '/activate', input('bad-country', { country_code: 'DE' }))).status, 400);
    const list = (await api(mf, '/admin/licenses', undefined, true)).data.licenses;
    assert(list.every(l => 'warehouse_id' in l && 'country_code' in l && !('token' in l)));
  } finally { await mf.dispose(); }
});

test('missing or malformed Firebase secrets preserve licensing', async () => {
  for (const overrides of [{ FIREBASE_CLIENT_EMAIL: '' }, { FIREBASE_PRIVATE_KEY: '' }, { FIREBASE_PROJECT_ID: '' }, { FIREBASE_PRIVATE_KEY: 'invalid-local-test-key' }]) {
    const { mf, db } = await setup(overrides);
    try {
      await sql(db, schema);
      assert.equal((await api(mf, '/health')).data.firebase_auth_configured, !Object.values(overrides).includes(''));
      const result = await api(mf, '/activate', input('fallback', { country_code: 'US' }));
      assert.equal(result.status, 201); assert.equal(result.data.ok, true);
      assert.match(result.data.warehouse_id, /^license-\d+$/);
      assert(!('firebase_token' in result.data));
      const checked = (await api(mf, '/verify', { ...input('fallback'), token: result.data.token })).data;
      assert.equal(checked.ok, true); assert(!('firebase_token' in checked));
    } finally { await mf.dispose(); }
  }
});
