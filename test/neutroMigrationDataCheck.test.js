const test = require('node:test');
const assert = require('node:assert/strict');
const { clientOptions, dataCheck, EXPECTED_SENDERS, SUMMARY_SQL } = require('../scripts/neutroMigrationDataCheck.cjs');
const { SOURCE_HOST, DESTINATION_HOST } = require('../scripts/neutroMigrationHold.cjs');
const { SERVICE, WORKSPACE, COMMIT } = require('../scripts/neutroMigrationRecovery.cjs');
const uri = host => `postgresql://test:synthetic-secret@${host}/neondb`;

function fixture() {
  const f = { calls: [], clients: [], events: [], deploy: 'dep-current', sourceUrl: uri(SOURCE_HOST),
    destinationUrl: uri(DESTINATION_HOST), summary: { database:'neondb',server_version:180007,tables:115,migrations:133,
      sequences:53,unvalidated_foreign_keys:0,orphan_messages:0,migration_digest:'synthetic' },
    senders: structuredClone(EXPECTED_SENDERS),
    archives:[{id:'initial-20261116',bytes:100,checksum_matches:true},{id:'rehearsal-1794834186228',bytes:100,checksum_matches:true}] };
  f.request = async (path, method='GET') => {
    f.calls.push({path,method});
    if (method !== 'GET') throw Error('Mutation attempted');
    if (path === '') return {id:SERVICE,ownerId:WORKSPACE,type:'web_service',repo:'https://github.com/hoenotfound/clinic_ai_chatbot',
      autoDeployTrigger:'off',suspended:'not_suspended',serviceDetails:{env:'node',numInstances:1,maintenanceMode:{enabled:false},envSpecificDetails:{startCommand:'npm start'}}};
    if (path === '/env-vars/DATABASE_URL') return {value:f.sourceUrl};
    if (path === '/deploys?limit=100') return [{id:f.deploy,status:'live',commit:{id:COMMIT}}];
    throw Error('Unexpected request');
  };
  f.Client = class {
    constructor(options) { this.options=options; this.queries=[]; this.ended=false; f.clients.push(this); }
    async connect() { if(f.connectFailure) throw Error('synthetic-secret'); }
    async query(sql) {
      this.queries.push(sql);
      assert.match(sql,/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SELECT )/);
      if(sql === SUMMARY_SQL) return {rows:[f.summary]};
      if(sql.includes('FROM whatsapp_sender_accounts')) return {rows:f.senders};
      if(sql.includes('FROM migration_archive.production_dump')) {
        if(f.changeDeploy) f.deploy='dep-concurrent';
        return {rows:f.archives};
      }
      return {rows:[]};
    }
    async end() { this.ended=true; }
  };
  f.fetchImpl = async () => ({status:200,text:async()=>'AI messaging bot is running.'});
  f.emit = e => f.events.push(e);
  return f;
}

test('data check uses direct verified TLS connections and read-only sessions with safe output',async()=>{
  const f=fixture(); await dataCheck(f);
  assert.equal(f.calls.every(c=>c.method==='GET'),true);
  assert.deepEqual(f.clients.map(c=>c.options.host),[SOURCE_HOST,DESTINATION_HOST,DESTINATION_HOST]);
  for(const c of f.clients) {
    assert.equal(c.options.ssl.rejectUnauthorized,true);
    assert.match(c.options.options,/default_transaction_read_only=on/);
    assert.equal(c.queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(c.ended,true);
  }
  assert.equal(f.events.at(-1).phase,'read_only_data_access_verified');
  assert.equal(f.events.at(-1).cutoverReady,false);
  assert.equal(f.events.at(-1).finalCopyVerified,false);
  assert.equal(JSON.stringify(f.events).includes('synthetic-secret'),false);
});

test('connection options reject wrong hosts and ignore supplied TLS/session overrides',()=>{
  assert.throws(()=>clientOptions(uri(SOURCE_HOST),DESTINATION_HOST),/identity/);
  assert.throws(()=>clientOptions(uri(DESTINATION_HOST).replace('/neondb','/other'),DESTINATION_HOST),/identity/);
  const c=clientOptions(uri(DESTINATION_HOST.replace('.c-2','-pooler.c-2'))+'?sslmode=disable&options=-c%20default_transaction_read_only=off',DESTINATION_HOST);
  assert.equal(c.host,DESTINATION_HOST);
  assert.deepEqual(c.ssl,{rejectUnauthorized:true});
  assert.match(c.options,/default_transaction_read_only=on/);
});

for(const [name,change] of [
  ['missing destination access',f=>f.destinationUrl=''],
  ['incorrect sender',f=>f.senders[0].meta_phone_number_id='other'],
  ['orphan messages',f=>f.summary.orphan_messages=1],
  ['damaged backup',f=>f.archives[0].checksum_matches=false],
  ['missing original backup',f=>f.archives.shift()],
  ['concurrent deployment',f=>f.changeDeploy=true],
  ['connection failure',f=>f.connectFailure=true],
]) test(`data check blocks ${name} without success or mutation`,async()=>{
  const f=fixture();change(f);await assert.rejects(dataCheck(f));
  assert.equal(f.calls.every(c=>c.method==='GET'),true);
  assert.equal(f.clients.every(c=>c.ended),true);
  assert.equal(f.events.some(e=>e.phase==='read_only_data_access_verified'),false);
});
