import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/secure.ts'], bundle: true, write: false, format: 'esm', loader: { '.html': 'text' } });
const worker = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { planFirestoreMigration, copyFirestoreDocuments } = worker;

function document(warehouse, collection, id) {
  return {
    name: `projects/test-project/databases/(default)/documents/warehouses/${warehouse}/${collection}/${id}`,
    fields: { marker: { stringValue: id } },
  };
}

test('dry-run planning reports source, target, pending, and skipped counts without copying', () => {
  const source = [document('license-22', 'shipments', 'one'), document('license-22', 'shipments', 'two')];
  const target = [document('es-main', 'shipments', 'two')];
  const planned = planFirestoreMigration(source, target);
  assert.deepEqual(planned.result, { source_count: 2, target_count: 1, copy_count: 1, skipped_existing: 1 });
  assert.deepEqual(planned.pending.map(item => item.id), ['one']);
});

test('copy writes only pending documents in safe batches with an exists:false precondition', async () => {
  const pending = planFirestoreMigration(
    Array.from({ length: 401 }, (_, index) => document('license-22', 'box_entries', `doc-${index}`)),
    [],
  ).pending;
  const batches = [];
  await copyFirestoreDocuments(
    { FIREBASE_PROJECT_ID: 'test-project' },
    'redacted-test-token',
    'es-main',
    'box_entries',
    pending,
    async (_url, init) => {
      batches.push(JSON.parse(init.body));
      return new Response(null, { status: 200 });
    },
  );
  assert.deepEqual(batches.map(batch => batch.writes.length), [400, 1]);
  assert(batches.flatMap(batch => batch.writes).every(write => write.currentDocument.exists === false));
  assert.match(batches[0].writes[0].update.name, /\/es-main\/box_entries\/doc-0$/);
});

test('matching document IDs are conflicts and are never submitted for overwrite', async () => {
  const planned = planFirestoreMigration(
    [document('license-22', 'product_catalog', 'same')],
    [document('es-main', 'product_catalog', 'same')],
  );
  assert.deepEqual(planned.result, { source_count: 1, target_count: 1, copy_count: 0, skipped_existing: 1 });
  assert.deepEqual(planned.pending, []);
  let called = false;
  await copyFirestoreDocuments({ FIREBASE_PROJECT_ID: 'test-project' }, 'redacted-test-token', 'es-main', 'product_catalog', planned.pending, async () => {
    called = true;
    return new Response(null, { status: 200 });
  });
  assert.equal(called, false);
});
