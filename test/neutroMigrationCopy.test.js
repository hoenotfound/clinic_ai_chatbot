const test = require('node:test');
const assert = require('node:assert/strict');
const { targetName, connection, differences } = require('../scripts/neutroMigrationCopy.cjs');
const { SOURCE_HOST, DESTINATION_HOST } = require('../scripts/neutroMigrationHold.cjs');

test('final copy requires both explicit approvals; rehearsal cannot target another database', () => {
  assert.equal(targetName('neutro_rehearsal_20261116', {}), 'neutro_rehearsal_20261116');
  for (const env of [{}, { NEUTRO_FINAL_COPY_APPROVED: '20261116' }, { NEUTRO_OLD_INSTANCE_RETIRED: 'confirmed' }]) {
    assert.throws(() => targetName('neondb', env));
  }
  assert.equal(targetName('neondb', { NEUTRO_FINAL_COPY_APPROVED: '20261116', NEUTRO_OLD_INSTANCE_RETIRED: 'confirmed' }), 'neondb');
  for (const name of ['postgres', 'neutro_backup_20261116', 'neutro_rehearsal_20261116;drop']) {
    assert.throws(() => targetName(name, {}));
  }
});

test('connections are pinned to the reviewed source and destination, with verified TLS', () => {
  const raw = `postgresql://test:synthetic@${SOURCE_HOST.replace('.c-', '-pooler.c-')}/neondb?sslmode=require`;
  const result = connection(raw, SOURCE_HOST);
  assert.equal(result.hostname, SOURCE_HOST);
  assert.equal(result.searchParams.get('sslmode'), 'verify-full');
  assert.throws(() => connection(raw, DESTINATION_HOST));
  assert.throws(() => connection(raw.replace('/neondb?', '/other?'), SOURCE_HOST));
  assert.throws(() => connection('invalid synthetic credential', SOURCE_HOST), error => !error.message.includes('synthetic'));
});

function manifest() {
  return { schema: { tables: [{ relname: 'messages', owner: 'neondb_owner', acl: 'original' }], constraints: [] }, tables: [{ name: 'messages', rows: '2', digest: 'aaa' }], largeObjects: [] };
}

test('equal row counts cannot conceal changed records or application grants', () => {
  const source = manifest(), target = manifest();
  assert.deepEqual(differences(source, target), []);
  target.tables[0].digest = 'bbb';
  assert.deepEqual(differences(source, target), ['table-data']);
  target.schema.tables[0].acl = 'broader';
  assert.deepEqual(differences(source, target), ['schema:tables', 'table-data']);
});

test('only reviewed monitoring-view ACL differences are accepted', () => {
  const source = manifest(), target = manifest();
  source.schema.tables = [{ relname: 'pg_stat_statements', owner: 'cloud_admin', acl: 'source' }];
  target.schema.tables = [{ relname: 'pg_stat_statements', owner: 'cloud_admin', acl: 'destination' }];
  assert.deepEqual(differences(source, target), []);
  target.schema.tables[0].owner = 'other_owner';
  assert.deepEqual(differences(source, target), ['schema:tables']);
});

test('unrelated constraints and large-object data still require exact matches', () => {
  const source = manifest(), target = manifest();
  source.schema.constraints = [{ table_name: 'other', conname: 'ordinary_check', definition: 'CHECK (x > 0)' }];
  target.schema.constraints = [{ table_name: 'other', conname: 'ordinary_check', definition: 'CHECK (x > 1)' }];
  target.largeObjects = [{ loid: 1, pageno: 0, digest: 'changed' }];
  assert.deepEqual(differences(source, target), ['schema:constraints', 'large-objects']);
});
