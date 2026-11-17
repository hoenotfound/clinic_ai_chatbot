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

test('final source boundary detects sequence-only changes and called-state drift', async () => {
  const { assertSequenceValues } = require('../scripts/neutroMigrationCopy.cjs');
  const sequences = [{ relation: 'public.messages_id_seq', value: '100', called: true }];
  const client = row => ({ query: async () => ({ rows: [row] }) });
  await assertSequenceValues(client({ last_value: '100', is_called: true }), sequences);
  await assert.rejects(assertSequenceValues(client({ last_value: '101', is_called: true }), sequences), /Sequence changed/);
  await assert.rejects(assertSequenceValues(client({ last_value: '100', is_called: false }), sequences), /Sequence changed/);
  await assert.rejects(assertSequenceValues(client({}), [{...sequences[0],relation:'public.seq; SELECT 1'}]), /identifier/);
});

test('archive jsonb property order preserves equality while value and array changes fail',()=>{
 const original={schema:{tables:[{relname:'a',owner:'owner',options:{b:2,a:1}},{relname:'b',owner:'owner'}]},tables:[{name:'a',rows:'2',digest:'abc'}],largeObjects:[]};
 const reordered={largeObjects:[],tables:[{digest:'abc',rows:'2',name:'a'}],schema:{tables:[{options:{a:1,b:2},owner:'owner',relname:'a'},{owner:'owner',relname:'b'}]}};
 assert.deepEqual(differences(original,reordered),[]);
 const changed=structuredClone(reordered);changed.tables[0].digest='changed';
 assert.deepEqual(differences(original,changed),['table-data']);
 const reversed=structuredClone(reordered);reversed.schema.tables.reverse();
 assert.deepEqual(differences(original,reversed),['schema:tables']);
 const nested=structuredClone(reordered);nested.schema.tables[0].options.a=3;
 assert.deepEqual(differences(original,nested),['schema:tables']);
});
