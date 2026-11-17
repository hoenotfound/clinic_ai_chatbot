const test = require('node:test');
const assert = require('node:assert/strict');
const { runFinal, APPROVAL, checkTools, runCopy, prepareDatabase } = require('../scripts/neutroMigrationFinal.cjs');
const { SERVICE, WORKSPACE, COMMIT, HOLD } = require('../scripts/neutroMigrationRecovery.cjs');
const SOURCE = 'postgresql://test:synthetic@ep-patient-queen-b31tib05.c-4.ap-southeast-1.aws.neon.tech/neondb';
const DESTINATION = SOURCE.replace('ep-patient-queen-b31tib05.c-4','ep-late-dawn-aog3aefy.c-2');
const live = id => ({ id, status: 'live', commit: { id: COMMIT } });
function fixture() {
  const f = { clock: 0, runtime: 'running', samples: 0, calls: [], events: [], expectedDeploy: 'dep-original', approved: APPROVAL, destinationUrl: DESTINATION,
    db: SOURCE, deployments: [live('dep-original')], service: { id: SERVICE, ownerId: WORKSPACE, type: 'web_service',
      repo: 'https://github.com/hoenotfound/clinic_ai_chatbot', suspended: 'not_suspended', autoDeployTrigger: 'off',
      serviceDetails: { env: 'node', numInstances: 1, maintenanceMode: { enabled: false }, envSpecificDetails: { startCommand: 'npm start' } } } };
  f.now = () => f.clock;
  f.wait = async ms => { f.clock += ms; if (f.runtime === 'running' && !f.restored) f.runtime = 'drained'; };
  f.emit = e => f.events.push(e);
  f.readRuntime = async () => { f.samples++; return f.runtime; };
  f.fetchImpl = async () => ({ status: 200, text: async () => f.runtime === 'running' ? 'AI messaging bot is running.' :
    JSON.stringify(f.runtime === 'standalone' ? { mode: 'migration_hold', chatbotRunning: false } :
      { mode: 'migration_hold', acceptingWork: false, activeTasks: 0, drained: true }) });
  f.request = async (path, method = 'GET', body) => {
    f.calls.push({ path, method, body });
    if (path === '' && method === 'PATCH') { f.service.serviceDetails.envSpecificDetails = structuredClone(body.serviceDetails.envSpecificDetails); return {}; }
    if (path === '') return structuredClone(f.service);
    if (path === '/env-vars/DATABASE_URL') { if(method==='PUT')f.db=body.value; return { value: f.db }; }
    if (path === '/deploys?limit=100') return f.deployments.map(deploy => ({ deploy: structuredClone(deploy) }));
    if (path === '/deploys' && method === 'POST') {
      const holding = f.service.serviceDetails.envSpecificDetails.startCommand === HOLD;
      f.deployments.forEach(d => { d.status = 'deactivated'; });
      const d = live(holding ? 'dep-holding' : 'dep-restored'); f.deployments.unshift(d);
      f.runtime = holding ? 'standalone' : 'running'; f.restored = !holding;
      return structuredClone(d);
    }
    const d = f.deployments.find(x => path === '/deploys/' + x.id);
    if (d) return structuredClone(d);
    throw Error('Unexpected request');
  };
  f.preflight=async()=>{f.events.push({phase:'preflight'});};
  f.prepareDestination=async()=>{f.events.push({phase:'prepared'});};
  f.verifyRetirement=async()=>{f.events.push({phase:'retired'});};
  f.copy=async()=>({verified:true,target:'neondb',archiveId:'test-archive',cutoverPerformed:false});
  f.verifyBoundary=async()=>{f.events.push({phase:'boundary'});};
  return f;
}

test('final switch occurs only after retirement, full copy, durable archive and boundary checks',async()=>{
 const f=fixture();await runFinal(f);
 assert.equal(f.db,DESTINATION);assert.equal(f.runtime,'running');
 const phases=f.events.map(e=>e.phase);
 assert(phases.indexOf('retired')<phases.indexOf('final_copy_verified'));
 assert(phases.indexOf('boundary')<phases.indexOf('destination_activation_started'));
 assert.equal(phases.at(-1),'destination_live');
 assert.equal(f.events.at(-1).customerDeliveryVerified,false);
 assert.deepEqual(f.calls.filter(c=>c.method!=='GET').map(c=>[c.path,c.method]),[
  ['','PATCH'],['/deploys','POST'],['/env-vars/DATABASE_URL','PUT'],['','PATCH'],['/deploys','POST']]);
 assert(f.calls.filter(c=>c.method==='POST').every(c=>c.body.commitId===COMMIT));
 assert(!JSON.stringify(f.events).includes('synthetic'));
});
test('holding deployment waits for public routing without repeating mutations',async()=>{
 const f=fixture(),read=f.readRuntime;let pending=3;
 f.readRuntime=async()=>{
  if(f.runtime==='standalone'&&pending-- >0) {
   if(pending===1)throw Error('temporary public response');
   return 'drained';
  }
  return read();
 };
 await runFinal(f);
 assert.equal(f.db,DESTINATION);
 assert.equal(f.events.filter(e=>e.phase==='holding_readiness_wait').length,3);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
});
test('holding readiness expiry cannot start copying or change database',async()=>{
 const f=fixture(),read=f.readRuntime;let reads=0;
 f.readRuntime=async()=>f.runtime==='standalone'&&reads++<31?'drained':read();
 await assert.rejects(runFinal(f),/readiness deadline/);
 assert.equal(f.db,SOURCE);
 assert(!f.events.some(e=>e.phase==='retired'));
 assert(!f.calls.some(c=>c.method==='PUT'));
});
test('running application during holding transition cannot authorize a copy',async()=>{
 const f=fixture(),read=f.readRuntime;
 f.readRuntime=async()=>f.runtime==='standalone'?'running':read();
 await assert.rejects(runFinal(f),/Unexpected runtime/);
 assert(!f.events.some(e=>e.phase==='retired'));
 assert(!f.calls.some(c=>c.method==='PUT'));
});
for(const [name,mutate] of [
 ['approval',f=>f.approved=''],['source deploy',f=>f.expectedDeploy='dep-other'],
 ['destination identity',f=>f.destinationUrl=SOURCE],['source identity',f=>f.db=DESTINATION],
 ['paused source',f=>f.runtime='drained'],['multiple instances',f=>f.service.serviceDetails.numInstances=2],
 ['changed code',f=>f.deployments[0].commit.id='a'.repeat(40)],
 ['active deploy',f=>f.deployments.push({status:'build_in_progress'})],
])test('rejects unsafe '+name+' before preparation or Render changes',async()=>{
 const f=fixture();mutate(f);await assert.rejects(runFinal(f));
 assert(!f.events.some(e=>e.phase==='prepared'));assert(!f.calls.some(c=>c.method!=='GET'));
});
test('no signal expires without production mutation',async()=>{
 const f=fixture();f.wait=async ms=>{f.clock+=ms;};await runFinal(f);
 assert.equal(f.events.at(-1).phase,'expired_without_pause');assert(!f.calls.some(c=>c.method!=='GET'));
});
test('active work at deadline is never retired',async()=>{
 const f=fixture();f.wait=async ms=>{f.clock+=ms;f.runtime='draining';};
 await assert.rejects(runFinal(f),/Drain deadline/);assert(!f.calls.some(c=>c.method!=='GET'));
});
for(const stage of ['verifyRetirement','copy','verifyBoundary'])test(stage+' failure restores source before URL change',async()=>{
 const f=fixture();f[stage]=async()=>{throw Error('synthetic failure');};
 await assert.rejects(runFinal(f),/synthetic failure/);assert.equal(f.db,SOURCE);assert.equal(f.runtime,'running');
 assert(!f.calls.some(c=>c.method==='PUT'));assert.equal(f.events.at(-1).phase,'final_failed_source_restored');
});
test('incomplete archive evidence cannot activate destination',async()=>{
 const f=fixture();f.copy=async()=>({verified:true,target:'neondb'});
 await assert.rejects(runFinal(f),/archive/);assert.equal(f.db,SOURCE);assert.equal(f.runtime,'running');
});
test('unconfirmed child termination forbids automatic source restart',async()=>{
 const f=fixture();f.copy=async()=>{const e=Error('uncertain');e.copyChildrenUncertain=true;throw e;};
 await assert.rejects(runFinal(f));assert.equal(f.runtime,'standalone');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
for(const phase of ['url','command','deploy','health'])test('failure after '+phase+' activation never returns to stale source',async()=>{
 const f=fixture(),request=f.request;
 f.request=async(...args)=>{
   const [p,m,b]=args;
   if(phase==='command'&&m==='PATCH'&&b.serviceDetails.envSpecificDetails.startCommand==='npm start')throw Error('failed');
   if(phase==='deploy'&&p==='/deploys'&&m==='POST'&&f.db===DESTINATION)throw Error('ambiguous POST');
   const r=await request(...args);if(phase==='url'&&m==='PUT')throw Error('lost PUT response');return r;
 };
 if(phase==='health')f.fetchImpl=async()=>({status:503,text:async()=>''});
 await assert.rejects(runFinal(f));assert.equal(f.db,DESTINATION);
 assert.equal(f.events.at(-1).phase,'manual_destination_recovery_required');
 assert(!f.events.some(e=>e.phase==='final_failed_recovering_source'));
 assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
test('lost holding POST response is not repeated or followed by recovery',async()=>{
 const f=fixture(),request=f.request;f.request=async(...args)=>{const r=await request(...args);if(args[1]==='POST')throw Error('lost');return r;};
 await assert.rejects(runFinal(f));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('pending holding deployment never overlaps another deployment',async()=>{
 const f=fixture(),request=f.request;f.request=async(...args)=>{const r=await request(...args);if(args[1]==='POST')f.deployments[0].status='build_in_progress';return r;};
 await assert.rejects(runFinal(f));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('requires PostgreSQL 18 clients before database preparation',()=>{
 checkTools(name=>`${name} (PostgreSQL) 18.1`);
 assert.throws(()=>checkTools(name=>`${name} (PostgreSQL) 17.9`));
 assert.throws(()=>checkTools(()=>{throw Error('missing');}));
});
test('unknown database preparation mode is rejected before connection',async()=>{
 await assert.rejects(prepareDatabase(DESTINATION,'unknown',()=>{}),/mode/);
});
test('copy child deadline terminates the process before settling',async()=>{
 const {spawn}=require('node:child_process');let child;
 const fake=(_exe,_args,options)=>{child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);return child;};
 await assert.rejects(runCopy(SOURCE,DESTINATION,'neutro_rehearsal_20261117',fake,50),/deadline/);
 assert(child.signalCode);assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});
test('copy rejects nonzero exits and withholds private stderr',async()=>{
 const {spawn}=require('node:child_process');
 const fake=(_exe,_args,options)=>spawn(process.execPath,['-e',"console.error('private record');process.exit(1)"],options);
 await assert.rejects(runCopy(SOURCE,DESTINATION,'neutro_rehearsal_20261117',fake),e=>!e.message.includes('private record'));
});
test('copy accepts only complete bounded evidence and excludes Render credentials from child',async()=>{
 const {spawn}=require('node:child_process');const target='neutro_rehearsal_20261117';
 const evidence={verified:true,target,archiveId:'test'};
 const fake=(_exe,_args,options)=>{assert.equal(options.env.RENDER_API_KEY,undefined);return spawn(process.execPath,['-e',`console.log(${JSON.stringify(JSON.stringify(evidence))})`],options);};
 assert.deepEqual(await runCopy(SOURCE,DESTINATION,target,fake),evidence);
});

test('active claims block copying while historical unknown holds are preserved',()=>{
 const {assertNoActiveClaims}=require('../scripts/neutroMigrationFinal.cjs');
 for(const value of ['processing','running','sending','reserved','claimed','dispatching','in_progress'])
   assert.throws(()=>assertNoActiveClaims({requiresReview:[{value,count:1}]}),/claims/);
 assert.doesNotThrow(()=>assertNoActiveClaims({requiresReview:[{value:'unknown',count:6},{value:'ambiguous',count:1}]}));
 assert.throws(()=>assertNoActiveClaims({}));
});

test('copy progress forwards only approved phase names and never payload fields',async()=>{
 const {spawn}=require('node:child_process');const target='neutro_rehearsal_20261117',phases=[];
 const evidence={verified:true,target,archiveId:'test'};
 const code=`process.send({phase:'private customer text'});process.send({phase:'source_dumped',private:'hidden'});console.log(${JSON.stringify(JSON.stringify(evidence))});`;
 const fake=(_exe,_args,options)=>spawn(process.execPath,['-e',code],options);
 await runCopy(SOURCE,DESTINATION,target,fake,5000,phase=>phases.push(phase));
 assert.deepEqual(phases,['source_dumped']);
});

test('idle pool cleanup never terminates active transactions or unrelated clients',async()=>{
 const {closeIdlePoolClients}=require('../scripts/neutroMigrationFinal.cjs');
 for(const unsafe of [{pid:1,application_name:'pgbouncer',state:'active',xact_start:null},{pid:1,application_name:'pgbouncer',state:'idle in transaction',xact_start:'time'},{pid:1,application_name:'other',state:'idle',xact_start:null}]){
  const calls=[];const c={query:async(sql,args)=>{calls.push({sql,args});return {rows:[unsafe]};}};
  assert.equal(await closeIdlePoolClients(c,'neondb'),false);assert.equal(calls.length,1);
 }
});
test('idle pool cleanup is scoped to observed PIDs and repeats idle and transaction predicates',async()=>{
 const {closeIdlePoolClients}=require('../scripts/neutroMigrationFinal.cjs');const calls=[];
 const c={query:async(sql,args)=>{calls.push({sql,args});return {rows:calls.length===1?[{pid:42,application_name:'pgbouncer',state:'idle',xact_start:null}]:[]};}};
 assert.equal(await closeIdlePoolClients(c,'neondb'),true);
 assert.deepEqual(calls[1].args,['neondb',[42],false]);
 for(const text of ['pid=ANY','application_name=','state=','xact_start IS NULL','datname=$1'])assert(calls[1].sql.includes(text));
});

test('named chatbot pool clients can be closed only after source retirement',async()=>{
 const {closeIdlePoolClients}=require('../scripts/neutroMigrationFinal.cjs');
 const base={pid:42,application_name:'da-chatbot-neutro-sense-tcm',state:'idle',xact_start:null,usename:'neondb_owner',client_host:'::1'};
 for(const [retired,database,changes,allowed] of [
  [false,'neondb',{},false],[true,'other',{},false],[true,'neondb',{},true],
  [true,'neondb',{client_host:'127.0.0.1'},true],[true,'neondb',{client_host:'192.0.2.1'},false],
  [true,'neondb',{usename:'other'},false],[true,'neondb',{state:'active'},false],
  [true,'neondb',{xact_start:'time'},false],[true,'neondb',{application_name:'another-service'},false],
 ]) {
  const calls=[];const c={query:async(sql,args)=>{calls.push({sql,args});return {rows:calls.length===1?[{...base,...changes}]:[]};}};
  assert.equal(await closeIdlePoolClients(c,database,retired),allowed);
  assert.equal(calls.length,allowed?2:1);
  if(allowed){assert.deepEqual(calls[1].args,['neondb',[42],true]);
   for(const clause of ['usename=','host(client_addr)','state=','xact_start IS NULL','pid=ANY','$3::boolean'])assert(calls[1].sql.includes(clause));}
 }
});

test('API-prepared database validation refuses populated targets without overwriting',async()=>{
 const connect=async(_url,_host,database,_readonly,fn)=>fn({query:async(sql)=>{
  if(sql.includes('sum(pg_database_size'))return {rows:[{bytes:'10000000'}]};
  if(sql.includes('pg_get_userbyid'))return {rows:[{owner:'neondb_owner',encoding:'UTF8',datlocprovider:'b',datlocale:'C.UTF-8'}]};
  if(sql.includes('SELECT pid'))return {rows:[]};
  if(sql.includes('count(*)::int count'))return {rows:[{count:0}]};
  if(sql.includes('count(*)::int n'))return {rows:[{n:115}]};
  throw Error('Unexpected SQL');
 }});
 await assert.rejects(prepareDatabase(DESTINATION,'rehearsal',()=>{},connect),/not empty/);
});
test('final preparation requires the retained initial database',async()=>{
 const connect=async(_url,_host,_db,_readonly,fn)=>fn({query:async(sql)=>{
  if(sql.includes('sum(pg_database_size'))return {rows:[{bytes:'10000000'}]};
  if(sql.includes('pg_get_userbyid'))return {rows:[{owner:'neondb_owner',encoding:'UTF8',datlocprovider:'b',datlocale:'C.UTF-8'}]};
  if(sql.includes('neutro_initial_20261117'))return {rows:[]};
  throw Error('Unexpected SQL');
 }});
 await assert.rejects(prepareDatabase(DESTINATION,'final',()=>{},connect),/Preserved/);
});

