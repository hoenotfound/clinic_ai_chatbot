const test = require('node:test');
const assert = require('node:assert/strict');
const { run, runtime, APPROVAL } = require('../scripts/neutroMigrationRehearsal.cjs');
const { SERVICE, WORKSPACE, COMMIT, HOLD, probe } = require('../scripts/neutroMigrationRecovery.cjs');
const SOURCE = 'postgresql://test:synthetic@ep-patient-queen-b31tib05.c-4.ap-southeast-1.aws.neon.tech/neondb';
const live = id => ({ id, status: 'live', commit: { id: COMMIT } });
function fixture() {
  const f = { clock: 0, runtime: 'running', samples: 0, calls: [], events: [], expectedDeploy: 'dep-original', approved: APPROVAL,
    db: SOURCE, deployments: [live('dep-original')], service: { id: SERVICE, ownerId: WORKSPACE, type: 'web_service',
      repo: 'https://github.com/hoenotfound/clinic_ai_chatbot', suspended: 'not_suspended', autoDeployTrigger: 'off',
      serviceDetails: { env: 'node', numInstances: 1, maintenanceMode: { enabled: false }, envSpecificDetails: { startCommand: 'npm start' } } } };
  f.now = () => f.clock;
  f.wait = async ms => { f.clock += ms; if (f.runtime === 'running' && !f.restored) f.runtime = 'drained'; };
  f.emit = e => f.events.push(e);
  f.readRuntime = async () => { f.samples++; return f.runtime; };
  f.fetchImpl = async () => ({ status: 200, text: async () => f.runtime === 'running' ? '<!doctype html><html></html>' :
    JSON.stringify(f.runtime === 'standalone' ? { mode: 'migration_hold', chatbotRunning: false } :
      { mode: 'migration_hold', acceptingWork: false, activeTasks: 0, drained: true }) });
  f.request = async (path, method = 'GET', body) => {
    f.calls.push({ path, method, body });
    if (path === '' && method === 'PATCH') { f.service.serviceDetails.envSpecificDetails = structuredClone(body.serviceDetails.envSpecificDetails); return {}; }
    if (path === '') return structuredClone(f.service);
    if (path === '/env-vars/DATABASE_URL') return { value: f.db };
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
  return f;
}

test('browser-independent rehearsal performs only holding and original-code recovery, without DB changes', async () => {
  const f = fixture(); await run(f);
  assert.equal(f.events[0].phase, 'armed');
  assert.equal(f.events.at(-1).phase, 'rehearsal_complete');
  assert.equal(f.runtime, 'running');
  const writes = f.calls.filter(c => c.method !== 'GET');
  assert.deepEqual(writes.map(c => [c.path,c.method]), [['','PATCH'],['/deploys','POST'],['','PATCH'],['/deploys','POST']]);
  assert.deepEqual(writes.filter(c=>c.method === 'POST').map(c=>c.body.commitId), [COMMIT,COMMIT]);
  assert.equal(writes.some(c=>JSON.stringify(c).includes('DATABASE_URL')), false);
});

test('arming expires without deployment when no pause happens', async () => {
  const f = fixture(); f.wait = async ms => { f.clock += ms; };
  await run(f);
  assert.equal(f.events.at(-1).phase, 'expired_without_pause');
  assert.equal(f.calls.some(c=>c.method !== 'GET'), false);
  assert.equal(f.clock, 120000);
});

test('active drain cannot be forcibly retired when deadline expires', async () => {
  const f = fixture(); f.wait = async ms => { f.clock += ms; f.runtime = 'draining'; };
  await assert.rejects(run(f), /Drain deadline/);
  assert.equal(f.calls.some(c=>c.method !== 'GET'), false);
});

test('a transient clean sample does not authorize retirement', async () => {
  const f = fixture(); let samples = 0;
  f.readRuntime = async () => ++samples === 1 ? 'running' : samples % 2 === 0 ? 'drained' : 'draining';
  await assert.rejects(run(f), /Drain deadline/);
  assert.equal(f.calls.some(c=>c.method !== 'GET'), false);
});

for (const [name, mutate] of [
  ['missing approval', f=>{f.approved='';}],
  ['wrong initial deployment', f=>{f.expectedDeploy='dep-other';}],
  ['destination URL', f=>{f.db=SOURCE.replace('ep-patient-queen-b31tib05.c-4','ep-late-dawn-aog3aefy.c-2');}],
  ['already paused', f=>{f.runtime='drained';}],
  ['changed live code', f=>{f.deployments[0].commit.id='b'.repeat(40);}],
]) test(`refuses ${name} without mutation`, async()=>{
  const f=fixture();mutate(f);await assert.rejects(run(f));
  assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});

test('database switch after drain blocks holding and recovery', async()=>{
  const f=fixture(), emit=f.emit;
  f.emit=e=>{emit(e);if(e.phase==='drain_observed')f.db=SOURCE.replace('/neondb','/other');};
  await assert.rejects(run(f),/source/);
  assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});

test('failed holding deployment restores the cleanly drained original app', async()=>{
  const f=fixture(), request=f.request;
  f.request=async(...args)=>{
    const r=await request(...args);
    if(args[0]==='/deploys' && args[1]==='POST' && r.id==='dep-holding') {
      f.deployments[0].status='build_failed'; f.deployments[1].status='live'; f.runtime='drained';
    }
    return r;
  };
  await assert.rejects(run(f),/Holding deployment failed/);
  assert.equal(f.runtime,'running');
  assert.equal(f.events.at(-1).phase,'rehearsal_failed_source_restored');
});

test('lost holding POST result does not cause a second holding deploy', async()=>{
  const f=fixture(), request=f.request;
  f.request=async(...args)=>{const r=await request(...args);if(args[0]==='/deploys' && args[1]==='POST')throw Error('Lost response');return r;};
  await assert.rejects(run(f));
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert.equal(f.events.some(e=>e.phase==='rehearsal_complete'),false);
});

test('lost recovery POST result is not retried', async()=>{
  const f=fixture(), request=f.request;
  f.request=async(...args)=>{const r=await request(...args);if(args[0]==='/deploys' && args[1]==='POST' && r.id==='dep-restored')throw Error('Lost response');return r;};
  await assert.rejects(run(f));
  assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
  assert.equal(f.events.some(e=>e.phase==='rehearsal_complete'),false);
});

test('in-progress holding deployment is never overlapped by recovery', async()=>{
  const f=fixture(), request=f.request;
  f.request=async(...args)=>{
    const r=await request(...args);
    if(args[0]==='/deploys' && args[1]==='POST')f.deployments[0].status='build_in_progress';
    return r;
  };
  await assert.rejects(run(f),/active/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

for(const body of [
  {mode:'migration_draining',acceptingWork:false,activeTasks:1,drained:false},
  {mode:'migration_hold',acceptingWork:false,activeTasks:0,drained:true},
  {mode:'migration_hold',chatbotRunning:false},
]) test(`recovery cannot report normal health for paused state ${JSON.stringify(body)}`,async()=>{
  const fetchImpl=async()=>({status:200,text:async()=>JSON.stringify(body)});
  await assert.rejects(probe(fetchImpl,false));
});

test('runtime parser refuses unknown JSON and failed public response',async()=>{
  await assert.rejects(runtime(async()=>({status:200,text:async()=>'{"ok":true}'})));
  await assert.rejects(runtime(async()=>({status:503,text:async()=>''})));
  assert.equal(await runtime(async()=>({status:200,text:async()=>'<html>Login</html>'})),'running');
});
