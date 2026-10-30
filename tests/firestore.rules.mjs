import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, setLogLevel } from 'firebase/firestore';

// Only the Firebase CLI's demo-project emulator is used; no service account is needed.
const projectId = 'demo-license-server';
let env;
setLogLevel('silent');
const warehouses = ['es-main', 'es-2', 'us-main', 'license-123', 'license-456'];
const claims = (warehouse_id, extra = {}) => ({
  warehouse_id, country_code: 'ES', license_active: true, license_expires_at: 0,
  app_id: 'com.ocr.fastscan', license_id: 123, ...extra,
});
let user = 0;
const client = token => env.authenticatedContext(`license:${++user}`, token).firestore();
const shipment = (db, warehouse) => doc(db, `warehouses/${warehouse}/shipments/order`);

before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run npm run test:rules (Firestore emulator required)');
  env = await initializeTestEnvironment({ projectId, firestore: {
    rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
  } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const warehouse of warehouses) {
      await setDoc(doc(db, `warehouses/${warehouse}`), { name: warehouse });
      await setDoc(shipment(db, warehouse), { warehouse });
    }
    for (const name of ['shipments', 'box_entries', 'users', 'licenses', 'settings']) {
      await setDoc(doc(db, `${name}/existing`), { historical: true });
    }
    await setDoc(doc(db, 'shipments/existing/items/item'), { historical: true });
    await setDoc(doc(db, 'box_entries/existing/items/item'), { historical: true });
  });
});
after(async () => { if (env) await env.cleanup(); });

test('each warehouse permits its own documents and rejects every other warehouse', async () => {
  for (const warehouse of warehouses) {
    const db = client(claims(warehouse));
    await assertSucceeds(getDoc(doc(db, `warehouses/${warehouse}`)));
    await assertSucceeds(getDoc(shipment(db, warehouse)));
    await assertSucceeds(getDocs(collection(db, `warehouses/${warehouse}/shipments`)));
    const created = doc(db, `warehouses/${warehouse}/box_entries/new`);
    await assertSucceeds(setDoc(created, { value: 1 }));
    await assertSucceeds(updateDoc(created, { value: 2 }));
    await assertSucceeds(deleteDoc(created));
    for (const other of warehouses.filter(value => value !== warehouse)) {
      await assertFails(getDoc(shipment(db, other)));
      await assertFails(getDocs(collection(db, `warehouses/${other}/shipments`)));
      await assertFails(setDoc(shipment(db, other), { forbidden: true }));
      await assertFails(deleteDoc(shipment(db, other)));
    }
    await assertFails(getDocs(collection(db, 'warehouses')));
  }
});

test('different apps with the same explicit warehouse share its data', async () => {
  const first = client(claims('es-main'));
  const second = client(claims('es-main', { app_id: 'other.app', license_id: 456 }));
  const path = 'warehouses/es-main/shipments/shared-apps';
  await assertSucceeds(setDoc(doc(first, path), { app: 'fastscan' }));
  await assertSucceeds(getDoc(doc(second, path)));
  await assertSucceeds(updateDoc(doc(second, path), { app: 'other.app' }));
  await assertSucceeds(getDoc(doc(first, path)));
  await assertFails(getDoc(shipment(second, 'es-2')));
});

test('country and contact email cannot grant warehouse access', async () => {
  const countryOnly = claims('es-main', { email: 'same@example.com' });
  delete countryOnly.warehouse_id;
  for (const token of [countryOnly, { ...countryOnly, country_code: 'US' },
    claims(null), claims(''), claims(123), claims('ES-MAIN'), claims('es-main-other')]) {
    const db = client(token);
    await assertFails(getDoc(shipment(db, 'es-main')));
    await assertFails(setDoc(shipment(db, 'es-main'), { forbidden: true }));
    await assertFails(getDoc(doc(db, 'shipments/existing')));
  }
  // Country is metadata; it cannot enlarge or reduce the exact warehouse grant.
  const changedCountry = client(claims('es-2', { country_code: 'US' }));
  await assertSucceeds(getDoc(shipment(changedCountry, 'es-2')));
  await assertFails(getDoc(shipment(changedCountry, 'es-main')));
  await assertFails(getDoc(shipment(changedCountry, 'us-main')));
});

test('unauthenticated clients cannot read or write warehouse or root data', async () => {
  const db = env.unauthenticatedContext().firestore();
  for (const path of ['warehouses/es-main/shipments/order', 'shipments/existing', 'box_entries/existing', 'users/existing']) {
    await assertFails(getDoc(doc(db, path)));
    await assertFails(setDoc(doc(db, path), { forbidden: true }));
  }
});

test('inactive, expired and incomplete license claims deny access', async () => {
  const missingActive = claims('es-main'); delete missingActive.license_active;
  const missingExpiry = claims('es-main'); delete missingExpiry.license_expires_at;
  for (const token of [claims('es-main', { license_active: false }),
    claims('es-main', { license_expires_at: Math.floor(Date.now() / 1000) - 60 }),
    claims('es-main', { license_expires_at: -1 }),
    claims('es-main', { license_expires_at: '0' }), missingActive, missingExpiry]) {
    const db = client(token);
    await assertFails(getDoc(shipment(db, 'es-main')));
    await assertFails(setDoc(shipment(db, 'es-main'), { forbidden: true }));
    await assertFails(getDoc(doc(db, 'shipments/existing')));
    await assertFails(getDoc(doc(db, 'box_entries/existing')));
  }
  const valid = client(claims('es-main', { license_expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  await assertSucceeds(getDoc(shipment(valid, 'es-main')));
});

test('legacy root shipments and box_entries are read-only exclusively for es-main', async () => {
  for (const warehouse of warehouses) {
    const db = client(claims(warehouse));
    for (const name of ['shipments', 'box_entries']) {
      const existing = doc(db, `${name}/existing`);
      const read = operation => warehouse === 'es-main' ? assertSucceeds(operation) : assertFails(operation);
      await read(getDoc(existing));
      await read(getDocs(collection(db, name)));
      await assertFails(setDoc(doc(db, `${name}/new`), { forbidden: true }));
      await assertFails(updateDoc(existing, { forbidden: true }));
      await assertFails(deleteDoc(existing));
      await assertFails(getDoc(doc(db, `${name}/existing/items/item`)));
      await assertFails(setDoc(doc(db, `${name}/existing/items/new`), { forbidden: true }));
    }
  }
});

test('all other root collections deny reads and writes even for es-main', async () => {
  for (const warehouse of warehouses) {
    const db = client(claims(warehouse));
    for (const name of ['users', 'licenses', 'settings', 'unknown']) {
      await assertFails(getDoc(doc(db, `${name}/existing`)));
      await assertFails(getDocs(collection(db, name)));
      await assertFails(setDoc(doc(db, `${name}/new`), { forbidden: true }));
      await assertFails(updateDoc(doc(db, `${name}/existing`), { forbidden: true }));
      await assertFails(deleteDoc(doc(db, `${name}/existing`)));
    }
  }
});
