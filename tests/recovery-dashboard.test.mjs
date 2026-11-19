import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const html = await readFile(new URL('../license-dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const license = {
  id: 21, email: 'contact@example.com', device_id: 'same-device', app_id: 'com.ocr.fastscan',
  is_active: 1, is_trial: 0, expires_at: null, warehouse_id: 'es-main', country_code: 'ES',
  token: 'full-secret-token-must-never-be-rendered', token_last4: '1234', recovery_allowed_until: null,
};

function panel(confirmed) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: id === 'filter-archive' ? '0' : '', style: {}, innerHTML: '', appendChild() {} });
    return nodes.get(id);
  };
  const requests = [], confirmations = [], alerts = [];
  const until = Math.floor(Date.now() / 1000) + 600;
  const context = createContext({
    document: { getElementById: element, createElement: () => ({}) },
    location: { protocol: 'https:', origin: 'https://local.test' },
    localStorage: { getItem: () => null }, setTimeout: () => {},
    confirm: message => { confirmations.push(message); return confirmed; },
    alert: message => alerts.push(message),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { json: async () => url.endsWith('/admin/license-recovery')
        ? { ok: true, id: 21, recovery_allowed_until: until }
        : url.endsWith('/admin/firestore/migrate-warehouse')
          ? { ok: true, dry_run: true, collections: {
            shipments: { source_count: 3, target_count: 2, copy_count: 1, skipped_existing: 2 },
          } }
          : { ok: true, licenses: [{ ...license, recovery_allowed_until: until }] } };
    },
  });
  runInContext(script, context);
  runInContext(`cfg={url:'https://local.test',key:'admin-test'};licenses=[${JSON.stringify(license)}];renderList();`, context);
  return { context, element, requests, confirmations, alerts, until };
}

test('recovery button confirms exact device, shows deadline and never renders the full token', async () => {
  const page = panel(true);
  assert.match(page.element('lic-list').innerHTML, /Разрешить восстановление токена/);
  await runInContext('allowRecovery(21)', page.context);
  assert.equal(page.confirmations.length, 1);
  assert.match(page.confirmations[0], /same-device/);
  assert.match(page.confirmations[0], /com\.ocr\.fastscan/);
  assert.match(page.confirmations[0], /10 минут/);
  assert.match(page.confirmations[0], /старый токен перестанет работать/);
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[0].url, 'https://local.test/admin/license-recovery');
  assert.equal(page.requests[0].options.headers['X-Admin-Key'], 'admin-test');
  assert.deepEqual(JSON.parse(page.requests[0].options.body), { id: 21, ttl_minutes: 10 });
  assert.equal(page.alerts.length, 1);
  assert(page.alerts[0].includes(new Date(page.until * 1000).toLocaleString()));
  assert.match(page.element('lic-list').innerHTML, /Восстановление разрешено до/);
  assert(!page.element('lic-list').innerHTML.includes(license.token));
  assert(!page.confirmations[0].includes(license.token));
  assert(!page.alerts[0].includes(license.token));
});

test('cancelling recovery confirmation sends no request', async () => {
  const page = panel(false);
  await runInContext('allowRecovery(21)', page.context);
  assert.equal(page.confirmations.length, 1);
  assert.equal(page.requests.length, 0);
  assert.equal(page.alerts.length, 0);
});

test('migration panel sends a dry-run request and renders collection counts', async () => {
  const page = panel(true);
  page.element('migration-source').value = 'license-22';
  page.element('migration-target').value = 'es-main';
  await runInContext('runMigrationDryRun()', page.context);
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, 'https://local.test/admin/firestore/migrate-warehouse');
  assert.deepEqual(JSON.parse(page.requests[0].options.body), {
    source_warehouse: 'license-22', target_warehouse: 'es-main', dry_run: true,
  });
  assert.match(page.element('migration-result').innerHTML, /shipments/);
  assert.match(page.element('migration-result').innerHTML, /<td>3<\/td><td>2<\/td>/);
});

test('confirmed migration copy sends dry_run false and keeps source and target explicit', async () => {
  const page = panel(true);
  page.element('migration-source').value = 'license-22';
  page.element('migration-target').value = 'es-main';
  await runInContext('runMigrationCopy()', page.context);
  assert.equal(page.confirmations.length, 1);
  assert.match(page.confirmations[0], /Source data will not be deleted/);
  assert.equal(page.requests.length, 1);
  assert.deepEqual(JSON.parse(page.requests[0].options.body), {
    source_warehouse: 'license-22', target_warehouse: 'es-main', dry_run: false,
  });
});

test('cancelled migration copy sends no request', async () => {
  const page = panel(false);
  page.element('migration-source').value = 'license-22';
  page.element('migration-target').value = 'es-main';
  await runInContext('runMigrationCopy()', page.context);
  assert.equal(page.requests.length, 0);
});
