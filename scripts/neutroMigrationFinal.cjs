#!/usr/bin/env node
"use strict";
// Independent runner. No application imports, automatic retries of mutations,
// source SQL writes, billing-hold releases or customer test sends.
const cp = require('node:child_process');
const path = require('node:path');
const { SOURCE_HOST, DESTINATION_HOST, connectionIdentity } = require('./neutroMigrationHold.cjs');
const recovery = require('./neutroMigrationRecovery.cjs');
const { runtime, journal } = require('./neutroMigrationRehearsal.cjs');
const { clientOptions, dataCheck } = require('./neutroMigrationDataCheck.cjs');
const APPROVAL = 'neutro-final-copy-verify-and-cutover';
const REHEARSAL = 'neutro_rehearsal_20261117';
const PENDING = new Set(['created','build_in_progress','pre_deploy_in_progress','update_in_progress']);
const unwrap = x => x?.deploy || x;

async function inspectPhase(request, expectedDeploy, destination, command) {
  const [service, env, entries] = await Promise.all([request(''),request('/env-vars/DATABASE_URL'),request('/deploys?limit=100')]);
  const actual = connectionIdentity((env.envVar || env).value);
  if(actual.host !== (destination ? DESTINATION_HOST : SOURCE_HOST) || actual.database !== '/neondb')
    throw Error('Unexpected authoritative database.');
  // Reuse service/code/deployment guards, separately checking the real DB above.
  const state = recovery.validate(service, `postgresql://unused:unused@${SOURCE_HOST}/neondb`, entries, expectedDeploy, false);
  if(state.startCommand !== command) throw Error('Unexpected start command.');
  return {liveDeploy:state.liveDeploy,commit:state.commit,destinationDatabase:destination};
}

async function deployPinned(request, emit, wait, now, phase, timeoutMs=180000) {
  emit({phase:`before_${phase}_deploy`,commit:recovery.COMMIT});
  const d = unwrap(await request('/deploys','POST',{commitId:recovery.COMMIT,clearCache:'do_not_clear'}));
  if(!/^dep-[a-z0-9]+$/.test(d?.id || '')) throw Error('Ambiguous deployment response. Do not retry.');
  emit({phase:`${phase}_deploy_requested`,deployId:d.id});
  const deadline = now()+timeoutMs;
  while(now()<deadline) {
    const current = unwrap(await request(`/deploys/${d.id}`));
    if(current.commit?.id!==recovery.COMMIT) throw Error('Unexpected deployment code.');
    if(current.status==='live') return d.id;
    if(!PENDING.has(current.status)) throw Error('Deployment failed or has an unknown status.');
    await wait(3000);
  }
  throw Error('Deployment deadline exceeded. Do not retry blindly.');
}

async function runFinal({request,approved,expectedDeploy,emit,preflight,prepareDestination,verifyRetirement,copy,
  verifyBoundary,destinationUrl,readRuntime=runtime,fetchImpl=global.fetch,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms))}) {
  if(approved!==APPROVAL || !/^dep-[a-z0-9]+$/.test(expectedDeploy || '')) throw Error('Specific final cutover approval and source deployment required.');
  const dest=connectionIdentity(destinationUrl);
  if(dest.host!==DESTINATION_HOST || dest.database!=='/neondb') throw Error('Destination identity mismatch.');
  await inspectPhase(request,expectedDeploy,false,'npm start');
  await preflight();
  if(await readRuntime()!=='running') throw Error('Source must be healthy before destination preparation.');
  // Validate the API-prepared empty destination before any production pause.
  await prepareDestination();
  await inspectPhase(request,expectedDeploy,false,'npm start');
  if(await readRuntime()!=='running') throw Error('Source must be healthy before arming.');
  let holdingDeploy, activationStarted=false, drainSeen=false;
  emit({phase:'final_armed',initialDeploy:expectedDeploy,armDeadline:now()+120000});
  const armDeadline=now()+120000;
  let drainDeadline, consecutive=0;
  try {
    while(true) {
      await inspectPhase(request,expectedDeploy,false,'npm start');
      const state=await readRuntime();
      if(state==='running') {
        if(drainSeen) throw Error('Source resumed outside this controller.');
        if(now()>=armDeadline) {emit({phase:'expired_without_pause',cutoverPerformed:false});return;}
      } else if(['draining','drained'].includes(state)) {
        if(!drainSeen){drainSeen=true;drainDeadline=now()+120000;emit({phase:'final_drain_observed',drainDeadline});}
        if(now()>=drainDeadline) throw Error('Drain deadline exceeded; do not retire active work.');
        consecutive=state==='drained'?consecutive+1:0;
        if(consecutive>=3) break;
      } else throw Error('Unexpected holding process before retirement.');
      await wait(2000);
    }
    await inspectPhase(request,expectedDeploy,false,'npm start');
    if(await readRuntime()!=='drained') throw Error('Drain readiness changed.');
    emit({phase:'before_final_hold_config'});
    await request('','PATCH',{serviceDetails:{envSpecificDetails:{startCommand:recovery.HOLD}}});
    await inspectPhase(request,expectedDeploy,false,recovery.HOLD);
    if(await readRuntime()!=='drained') throw Error('Drain readiness changed after holding config.');
    holdingDeploy=await deployPinned(request,emit,wait,now,'hold');
    emit({phase:'holding_deploy_live',deployId:holdingDeploy});
    // Provider "live" can precede public routing convergence. Recheck identity
    // each time and wait only for readiness; never repeat a deployment.
    const holdingDeadline=now()+60000;
    while(true) {
      await inspectPhase(request,holdingDeploy,false,recovery.HOLD);
      let observed;
      try { observed=await readRuntime(); } catch (_) { observed='unavailable'; }
      if(observed==='standalone') break;
      if(!['drained','unavailable'].includes(observed)) throw Error('Unexpected runtime during holding transition.');
      if(now()>=holdingDeadline) throw Error('Standalone holding readiness deadline exceeded.');
      emit({phase:'holding_readiness_wait',observed});
      await wait(2000);
    }
    emit({phase:'holding_readiness_verified'});
    const retired=unwrap(await request(`/deploys/${expectedDeploy}`));
    if(retired.status!=='deactivated' || retired.commit?.id!==recovery.COMMIT) throw Error('Original deployment retirement not confirmed.');
    emit({phase:'original_deploy_deactivated'});
    await verifyRetirement();
    emit({phase:'source_retirement_verified',oldDeploy:expectedDeploy,holdDeploy:holdingDeploy});
    const evidence=await copy(); // Must settle or terminate all child processes before rejecting.
    if(!evidence?.verified || evidence.target!=='neondb' || !evidence.archiveId || evidence.cutoverPerformed!==false)
      throw Error('Full copy and durable archive evidence missing.');
    await verifyBoundary(evidence);
    await inspectPhase(request,holdingDeploy,false,recovery.HOLD);
    if(await readRuntime()!=='standalone') throw Error('Holding state changed after copy.');
    emit({phase:'final_copy_verified',archiveId:evidence.archiveId,sha256:evidence.sha256,tables:evidence.tables,rows:evidence.rows,sequences:evidence.sequences});

    // Conservative authority boundary: even a lost PUT response forbids
    // automatic source recovery. Destination may subsequently receive writes.
    activationStarted=true;
    emit({phase:'destination_activation_started',automaticSourceRecoveryForbidden:true});
    await request('/env-vars/DATABASE_URL','PUT',{value:destinationUrl});
    await inspectPhase(request,holdingDeploy,true,recovery.HOLD);
    if(await readRuntime()!=='standalone') throw Error('Holding state changed before activation.');
    await request('','PATCH',{serviceDetails:{envSpecificDetails:{startCommand:'npm start'}}});
    await inspectPhase(request,holdingDeploy,true,'npm start');
    const liveDeploy=await deployPinned(request,emit,wait,now,'destination',300000);
    const deadline=now()+60000;
    while(true) {
      await inspectPhase(request,liveDeploy,true,'npm start');
      try {await recovery.probe(fetchImpl,false);break;}
      catch (_) {if(now()>=deadline)throw Error('Destination public readiness deadline exceeded.');await wait(2000);}
    }
    await inspectPhase(request,liveDeploy,true,'npm start');
    emit({phase:'destination_live',liveDeploy,archiveId:evidence.archiveId,cutoverPerformed:true,customerDeliveryVerified:false});
  } catch(error) {
    // Emit only known static guard messages, never provider bodies or SQL data.
    const guards=new Set(['Standalone holding process not observed.','Unexpected runtime during holding transition.',
      'Standalone holding readiness deadline exceeded.','Original deployment retirement not confirmed.',
      'An active or unknown deployment blocks recovery.','Live code differs from the reviewed recovery version.',
      'Live deployment changed; recovery blocked.','Unexpected start command.',
      'Active send or worker claims require reconciliation before copying.',
      'Source clients remain. Active or non-pool clients were not terminated.']);
    emit({phase:'final_guard_failed',reason:guards.has(error.message)?error.message:
      /^[0-9A-Z]{5}$/.test(error.code||'')?'postgres_'+error.code:'unclassified_guard_or_provider_failure'});
    if(activationStarted) {emit({phase:'manual_destination_recovery_required',automaticSourceRecoveryForbidden:true});throw error;}
    if(!drainSeen || error.copyChildrenUncertain) throw error;
    // Never retire a draining/faulted process or repeat an uncertain POST.
    // inspect rejects every pending deployment, including a lost POST response.
    const state=await recovery.inspect(request);
    if(![expectedDeploy,holdingDeploy].includes(state.liveDeploy)) throw error;
    if(!['drained','standalone'].includes(await readRuntime())) throw error;
    emit({phase:'final_failed_recovering_source',liveDeploy:state.liveDeploy});
    await recovery.recover({request,expectedDeploy:state.liveDeploy,approved:'source-only-before-any-destination-writes',
      allowDrainedApplication:true,emit,fetchImpl,now,wait});
    emit({phase:'final_failed_source_restored',cutoverPerformed:false});
    throw error;
  }
}

function checkTools(execFileSync=cp.execFileSync) {
  for(const name of ['pg_dump','pg_restore']) {
    let value;try{value=execFileSync(name,['--version'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore']});}catch(_){throw Error('PostgreSQL 18 clients unavailable.');}
    if(!new RegExp(`^${name} \\(PostgreSQL\\) 18\\.`).test(value)) throw Error('PostgreSQL 18 clients required.');
  }
}

async function pg(raw,host,database,readonly,fn) {
  const {Client}=require('pg');
  const options=clientOptions(raw,host,database);
  if(!readonly) options.options='-c statement_timeout=60000 -c lock_timeout=5000';
  const c=new Client(options);
  try{await c.connect();return await fn(c);}finally{await c.end();}
}

async function closeIdlePoolClients(c,database,retiredSource=false) {
  const sessions=(await c.query("SELECT pid,application_name,state,xact_start,usename,host(client_addr) client_host FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() AND backend_type='client backend'",[database])).rows;
  const retiredApp=s=>retiredSource&&database==='neondb'&&s.application_name==='da-chatbot-neutro-sense-tcm'&&
    s.usename==='neondb_owner'&&['127.0.0.1','::1'].includes(s.client_host);
  if(sessions.some(s=>(s.application_name!=='pgbouncer'&&!retiredApp(s))||s.state!=='idle'||s.xact_start!==null))return false;
  if(sessions.length)await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid=ANY($2::int[]) AND pid<>pg_backend_pid() AND backend_type='client backend' AND (application_name='pgbouncer' OR ($3::boolean AND datname='neondb' AND application_name='da-chatbot-neutro-sense-tcm' AND usename='neondb_owner' AND host(client_addr) IN ('127.0.0.1','::1'))) AND state='idle' AND xact_start IS NULL",[database,sessions.map(s=>s.pid),retiredSource]);
  return true;
}

async function sourceQuiet(sourceUrl,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,retired=false) {
  const deadline=now()+60000;
  while(true) {
    const count=await pg(sourceUrl,SOURCE_HOST,'neondb',true,async c=>{
      // Only the initial retirement boundary may close idle pool backends.
      // Render retirement and clean drain are independently proved first.
      if(retired)await closeIdlePoolClients(c,'neondb',true);
      return (await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].n;
    });
    if(count===0)return;
    if(now()>=deadline)throw Error('Source clients remain. Active or non-pool clients were not terminated.');
    await wait(3000);
  }
}

function assertNoActiveClaims(boundary) {
  const active=new Set(['processing','running','sending','reserved','claimed','dispatching','in_progress']);
  if(!Array.isArray(boundary?.requiresReview)||boundary.requiresReview.some(x=>active.has(x.value)&&x.count>0))
    throw Error('Active send or worker claims require reconciliation before copying.');
  // Historical unknown/ambiguous billing states are copied unchanged. They
  // never authorize a resend, release or reset of a provider reservation.
}

async function prepareDatabase(destinationUrl,mode,emit,connect=pg) {
  if(!['rehearsal','final'].includes(mode))throw Error('Unknown database preparation mode.');
  const target=mode==='rehearsal'?REHEARSAL:'neondb';
  // Neon database creation/preservation is completed through its management API
  // before this runner starts. Never clone a busy managed template with SQL.
  await connect(destinationUrl,DESTINATION_HOST,'postgres',true,async c=>{
    const sizes=(await c.query("SELECT sum(pg_database_size(oid))::text bytes FROM pg_database")).rows[0];
    if(Number(sizes.bytes)+110*1024*1024>500*1024*1024)throw Error('Conservative free storage budget would be exceeded.');
    const meta=(await c.query("SELECT pg_get_userbyid(datdba) owner,pg_encoding_to_char(encoding) encoding,datlocprovider,datlocale FROM pg_database WHERE datname=$1",[target])).rows[0];
    if(meta?.owner!=='neondb_owner'||meta.encoding!=='UTF8'||meta.datlocprovider!=='b'||meta.datlocale!=='C.UTF-8')throw Error('Prepared destination missing or settings differ.');
    if(mode==='final'&&!(await c.query("SELECT 1 FROM pg_database WHERE datname='neutro_initial_20261117'")).rows.length)throw Error('Preserved initial database missing.');
    if(!await closeIdlePoolClients(c,target))throw Error('Prepared destination has active or unrelated clients.');
  });
  await connect(destinationUrl,DESTINATION_HOST,target,true,async c=>{
    await require('./neutroMigrationCopy.cjs').assertNoOtherClients(c);
    const objects=(await c.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','S','v','m','f')")).rows[0].n;
    if(objects!==0)throw Error('Prepared destination is not empty. Nothing overwritten.');
  });
  emit({phase:'empty_destination_prepared',database:target,createdThroughNeonApi:true});
  return target;
}

function runCopy(sourceUrl,destinationUrl,target,spawn=cp.spawn,timeoutMs=300000,onProgress=()=>{}) {
  return new Promise((resolve,reject)=>{
    const env={...process.env,DATABASE_URL:sourceUrl,MIGRATION_DEST_URL:destinationUrl};
    delete env.RENDER_API_KEY;delete env.NEUTRO_MIGRATION_DESTINATION_URL;
    if(target==='neondb'){env.NEUTRO_FINAL_COPY_APPROVED='20261116';env.NEUTRO_OLD_INSTANCE_RETIRED='confirmed';}
    const child=spawn(process.execPath,[path.join(__dirname,'neutroMigrationCopy.cjs'),target],{env,detached:true,stdio:['ignore','pipe','pipe','ipc']});
    const allowed=new Set(['source_dumped','source_manifest_checked','restore_started','restore_finished','destination_manifest_checked','destination_sequences_checked','archive_verified']);
    child.on('message',x=>{if(allowed.has(x?.phase))onProgress(x.phase);});
    let out='',failed=false,timedOut=false,killTimer;
    const stop=()=>{if(failed)return;failed=true;try{process.kill(-child.pid,'SIGTERM');}catch(_){}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch(_){}},5000);};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    child.stdout.on('data',x=>{out+=x;if(out.length>100000)stop();});
    // Diagnostics can contain customer data. Do not forward or upload them.
    child.stderr.on('data',()=>{});
    child.once('error',()=>{clearTimeout(timer);clearTimeout(killTimer);reject(Error('Copy runner unavailable.'));});
    child.once('close',async code=>{
      clearTimeout(timer);clearTimeout(killTimer);
      // A closed parent is insufficient if a detached descendant survives.
      // Kill any remaining group and require its disappearance before recovery.
      if(child.pid) {
        try {process.kill(-child.pid,0);failed=true;process.kill(-child.pid,'SIGKILL');}
        catch(error){if(error.code!=='ESRCH'){const e=Error('Copy child state uncertain.');e.copyChildrenUncertain=true;reject(e);return;}}
        let alive=true;
        for(let i=0;i<40;i++) {
          try{process.kill(-child.pid,0);}catch(error){if(error.code==='ESRCH'){alive=false;break;}}
          await new Promise(r=>setTimeout(r,50));
        }
        if(alive){const e=Error('Copy descendants could not be confirmed stopped.');e.copyChildrenUncertain=true;reject(e);return;}
      }
      if(failed||code!==0){const e=Error('Copy runner failed or exceeded its deadline.');e.code=timedOut?'copy_deadline':'copy_failed';reject(e);return;}
      try{const e=JSON.parse(out.trim());if(!e.verified||e.target!==target||!e.archiveId)throw Error();resolve(e);}
      catch(_){reject(Error('Copy runner evidence invalid.'));}
    });
  });
}

async function main() {
  if(process.env.RENDER_SERVICE_ID||process.env.NODE_OPTIONS)throw Error('Use the independent runner without preloads.');
  const mode=process.argv[2];
  if(!['--copy-rehearsal','--final-cutover'].includes(mode))throw Error('Explicit runner mode required.');
  if(mode==='--final-cutover'&&process.env.NEUTRO_FINAL_CUTOVER_APPROVED!==APPROVAL)throw Error('Final cutover is not approved.');
  checkTools();
  const request=recovery.api(process.env.RENDER_API_KEY),destinationRaw=process.env.NEUTRO_MIGRATION_DESTINATION_URL;
  clientOptions(destinationRaw,DESTINATION_HOST);
  const emit=journal('neutro-final-journal.json');
  const preflight=()=>dataCheck({request,destinationUrl:destinationRaw,Client:require('pg').Client,emit,referenceDatabase:mode==='--final-cutover'?'neutro_initial_20261117':'neondb'});
  await preflight();
  const current=await recovery.inspect(request);
  const env=await request('/env-vars/DATABASE_URL'),sourceUrl=(env.envVar||env).value;
  clientOptions(sourceUrl,SOURCE_HOST);
  if(mode==='--copy-rehearsal') {
    let evidence,target;
    try{target=await prepareDatabase(destinationRaw,'rehearsal',emit);evidence=await runCopy(sourceUrl,destinationRaw,target,cp.spawn,600000,phase=>emit({phase:'copy_'+phase}));}
    finally{await recovery.verifyRecoveredSource({request,expectedDeploy:current.liveDeploy,emit});}
    emit({...evidence,workdir:undefined,phase:'independent_copy_rehearsal_verified',cutoverPerformed:false});return;
  }
  const destination=new URL(destinationRaw);
  destination.hostname=DESTINATION_HOST.replace('.c-','-pooler.c-');
  destination.search='?sslmode=verify-full&channel_binding=require';
  await runFinal({request,approved:process.env.NEUTRO_FINAL_CUTOVER_APPROVED,
    expectedDeploy:process.env.NEUTRO_EXPECTED_SOURCE_DEPLOY,emit,preflight:async()=>{},
    prepareDestination:()=>prepareDatabase(destinationRaw,'final',emit),
    verifyRetirement:async()=>{
      await sourceQuiet(sourceUrl,undefined,undefined,true);
      const boundary=await pg(sourceUrl,SOURCE_HOST,'neondb',true,c=>require('./neutroMigrationBoundary.cjs').inspect(c));
      assertNoActiveClaims(boundary);
      emit({phase:'source_claims_checked',activeClaims:0,historicalHoldsPreserved:true});
    },copy:()=>runCopy(sourceUrl,destinationRaw,'neondb',cp.spawn,600000,phase=>emit({phase:'copy_'+phase})),
    verifyBoundary:async evidence=>{
      await sourceQuiet(sourceUrl);
      // Re-read the verified archive's manifests, then recheck source under one
      // snapshot immediately before activation, including nontransactional sequences.
      const archived=await pg(destinationRaw,DESTINATION_HOST,'neutro_backup_20261116',true,async c=>(await c.query('SELECT source_manifest FROM migration_archive.production_dump WHERE id=$1',[evidence.archiveId])).rows[0]?.source_manifest);
      if(!archived)throw Error('Final archive unavailable.');
      const {manifest,differences,assertSequenceValues,assertNoOtherClients}=require('./neutroMigrationCopy.cjs');
      for(const [url,host] of [[sourceUrl,SOURCE_HOST],[destinationRaw,DESTINATION_HOST]])await pg(url,host,'neondb',true,async c=>{
        await c.query("SET TIME ZONE 'UTC'");
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await assertNoOtherClients(c);
        if(differences(archived.manifest,await manifest(c)).length)throw Error('Database changed after final verification.');
        await assertSequenceValues(c,archived.sequences);await c.query('ROLLBACK');
      });
    },destinationUrl:destination.toString()});
}
if(require.main===module)main().catch(error=>{const reason=['copy_deadline','copy_failed'].includes(error.code)?error.code:/^[0-9A-Z]{5}$/.test(error.code||'')?'postgres_'+error.code:'guard_or_provider_failure';console.error('FINAL_RUNNER_STOPPED: '+reason+'. Inspect the last phase and current service; never blindly retry or repoint after activation.');process.exitCode=1;});
module.exports={APPROVAL,REHEARSAL,runFinal,inspectPhase,checkTools,prepareDatabase,runCopy,assertNoActiveClaims,closeIdlePoolClients};

