function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const sharedStyles = `
  :root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f6f7fb}
  *{box-sizing:border-box}body{margin:0}.shell{max-width:1180px;margin:0 auto;padding:32px 20px 56px}
  h1{margin:0;font-size:28px}h2{font-size:17px;margin:0 0 14px}.sub{color:#667085;margin:7px 0 24px}.toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.spaced-toolbar{margin-top:18px}
  button,.button{border:0;border-radius:10px;background:#5b5bd6;color:white;padding:10px 14px;font-weight:650;cursor:pointer;text-decoration:none;display:inline-block}
  button:disabled{opacity:.55;cursor:not-allowed}.cards{display:grid;grid-template-columns:repeat(6,minmax(115px,1fr));gap:12px;margin:20px 0}.version-cards{grid-template-columns:2fr repeat(3,minmax(115px,1fr));margin-top:0}
  select{border:1px solid #d0d5dd;border-radius:10px;background:white;color:#172033;padding:9px 34px 9px 10px;font-weight:650}.lifecycle-control{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.lifecycle-control .label{text-transform:none;letter-spacing:0;font-size:13px}
  .card,.panel{background:white;border:1px solid #e4e7ec;border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.03)}
  .card{padding:16px}.card b{display:block;font-size:24px;margin-top:6px}.card .commit-value{font-size:17px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#667085}
  .panel{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1040px}th,td{padding:14px 16px;text-align:left;border-bottom:1px solid #eef0f3;font-size:14px}
  th{font-size:12px;text-transform:uppercase;color:#667085;background:#fafbfc}.client{font-weight:700}.client a{color:#172033;text-decoration:none}.client a:hover{text-decoration:underline}.muted{color:#667085;font-size:12px;margin-top:3px}
  .badge{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:700;background:#eef2f6}
  .ready{background:#e8f7ee;color:#157347}.ready_with_warnings{background:#fff5d6;color:#8a6200}.needs_testing{background:#fff0dc;color:#9a4c00}.blocked{background:#feecec;color:#b42318}.offline{background:#eef2f6;color:#475467}
  .lifecycle-setup{background:#eef4ff;color:#3538cd}.lifecycle-trial{background:#f4ebff;color:#6941c6}.lifecycle-live{background:#e8f7ee;color:#157347}.lifecycle-paused{background:#eef2f6;color:#475467}
  .version-current{background:#e8f7ee;color:#157347}.version-drifted{background:#fff0dc;color:#9a4c00}.version-unknown{background:#eef2f6;color:#475467}
  .channels{display:flex;gap:5px;flex-wrap:wrap}.channel{background:#f2f4f7;border-radius:7px;padding:4px 7px;font-size:11px;font-weight:650}
  .error{color:#b42318;max-width:260px}.empty{text-align:center;padding:40px;color:#667085}.empty h2{color:#172033;margin-bottom:8px}.empty p{margin:8px auto;max-width:650px;line-height:1.5}.empty code{display:inline-block;margin-top:10px;padding:9px 11px;border-radius:8px;background:#f2f4f7;color:#344054;font-size:12px}.back{color:#5b5bd6;text-decoration:none;font-weight:650;font-size:14px}
  .detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:20px 0}.detail-panel{padding:18px}.kv{display:grid;grid-template-columns:160px 1fr;gap:9px 16px;font-size:14px}.kv dt{color:#667085}.kv dd{margin:0;overflow-wrap:anywhere}
  .section-list{display:grid;gap:9px}.issue-row,.channel-row{border:1px solid #eef0f3;border-radius:10px;padding:12px}.issue-row b,.channel-row b{display:block;margin-bottom:4px}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  @media(max-width:900px){.cards,.version-cards{grid-template-columns:repeat(2,1fr)}}@media(max-width:760px){.cards,.version-cards{grid-template-columns:1fr}.detail-grid{grid-template-columns:1fr}.shell{padding:22px 14px}.kv{grid-template-columns:120px 1fr}}
`;

function dashboardHtml(nonce = "") {
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DA Chatbot Operations</title>
  <style nonce="${safeNonce}">${sharedStyles}</style>
</head>
<body>
  <main class="shell">
    <div class="toolbar">
      <div><h1>DA Chatbot Operations</h1><p class="sub">Fleet readiness and deployment drift across isolated client deployments. Only Live clients are background monitored.</p></div>
      <button id="refresh">Refresh live clients</button>
    </div>
    <section class="cards" id="summary"></section>
    <section class="cards version-cards" id="deployment-summary"></section>
    <section class="panel"><div id="table" class="empty">Loading clients…</div></section>
  </main>
<script nonce="${safeNonce}">
const escapeHtml = ${escapeHtml.toString()};
const statusLabel = {ready:"Ready",ready_with_warnings:"Ready with warnings",needs_testing:"Testing required",blocked:"Blocked",offline:"Offline"};
const lifecycleLabel = {setup:"Setup",trial:"Trial",live:"Live",paused:"Paused"};
const driftLabel = {current:"Current",drifted:"Drifted",unknown:"Unknown"};
const targetSourceLabel = {configured:"Pinned target",registry_deployment:"Registry deployment",unavailable:"Unavailable"};
const fmt = value => value ? new Date(value).toLocaleString() : "—";
const shortCommit = value => value ? String(value).slice(0,8) : "—";
const channelName = value => typeof value === "string" ? value : (value?.channel || value?.name || "unknown");
const actionHeaders = {"x-ops-action":"1"};
async function load() {
  const response = await fetch("/api/clients", {headers:{accept:"application/json"}});
  if (!response.ok) throw new Error("Could not load registry");
  const data = await response.json();
  const s = data.summary || {};
  const d = data.deploymentSummary || {};
  document.getElementById("summary").innerHTML = [
    ["Clients",s.total||0,""],
    ["Ready",s.ready||0,"ready"],
    ["Ready + warnings",s.ready_with_warnings||0,"ready_with_warnings"],
    ["Testing",s.needs_testing||0,"needs_testing"],
    ["Blocked",s.blocked||0,"blocked"],
    ["Offline",s.offline||0,"offline"]
  ].map(([label,count,cls]) => '<div class="card"><span class="label">'+label+'</span><b class="'+cls+'">'+count+'</b></div>').join("");
  document.getElementById("deployment-summary").innerHTML = [
    '<div class="card"><span class="label">Fleet target · '+escapeHtml(targetSourceLabel[d.targetSource]||d.targetSource||"Unavailable")+'</span><b class="commit-value">'+escapeHtml(shortCommit(d.targetCommit))+'</b><div class="muted">Exact commit comparison only. Read-only visibility.</div></div>',
    '<div class="card"><span class="label">Version current</span><b class="version-current">'+escapeHtml(d.current||0)+'</b></div>',
    '<div class="card"><span class="label">Drifted</span><b class="version-drifted">'+escapeHtml(d.drifted||0)+'</b></div>',
    '<div class="card"><span class="label">Version unknown</span><b class="version-unknown">'+escapeHtml(d.unknown||0)+'</b></div>'
  ].join("");
  const rows = data.clients || [];
  if (!rows.length) {
    document.getElementById("table").innerHTML = '<div class="empty"><h2>No client deployments registered</h2><p>Provisioning can enroll new clients automatically. New clients start in Setup so background monitoring does not keep staging services awake.</p><code>npm run provision-client -- --ops-enrollment required --execute ...</code><p class="muted">Move a client to Live only after its hosting is production-ready. Run npm run ops-registry:verify before relying on this dashboard in production.</p></div>';
    return;
  }
  document.getElementById("table").innerHTML = '<table><thead><tr><th>Client</th><th>Lifecycle</th><th>Industry</th><th>Channels</th><th>Status</th><th>Last contact</th><th>Version</th><th>Issue</th></tr></thead><tbody>'+
    rows.map(c => {
      const channels=(c.purchasedChannels||[]).map(v=>'<span class="channel">'+escapeHtml(channelName(v))+'</span>').join("");
      const deployment=c.deployment||{};
      const issue=c.lastError || c.blockers?.[0]?.summary || c.testing?.[0]?.summary || c.warnings?.[0]?.summary || "";
      const detailHref='/clients/'+encodeURIComponent(c.clientSlug);
      const lifecycle=c.lifecycleStatus||'live';
      const monitoring=c.backgroundPollingEnabled?'Automatic monitoring':'No background polling';
      const drift=deployment.driftStatus||'unknown';
      const versionPair='Observed '+shortCommit(deployment.observedCommit)+' · Target '+shortCommit(deployment.targetCommit);
      return '<tr><td><div class="client"><a href="'+detailHref+'">'+escapeHtml(c.displayName)+'</a></div><div class="muted">'+escapeHtml(c.clientSlug)+'</div></td>'+
        '<td><span class="badge lifecycle-'+escapeHtml(lifecycle)+'">'+escapeHtml(lifecycleLabel[lifecycle]||lifecycle)+'</span><div class="muted">'+escapeHtml(monitoring)+'</div></td>'+
        '<td>'+escapeHtml(c.industry||"—")+'</td>'+
        '<td><div class="channels">'+channels+'</div></td>'+
        '<td><span class="badge '+escapeHtml(c.status)+'">'+escapeHtml(statusLabel[c.status]||c.status)+'</span></td>'+
        '<td>'+escapeHtml(fmt(c.lastSuccessAt))+'</td>'+
        '<td><span class="badge version-'+escapeHtml(drift)+'">'+escapeHtml(driftLabel[drift]||drift)+'</span><div class="muted">'+escapeHtml(versionPair)+'</div></td>'+
        '<td class="'+(issue?"error":"")+'">'+escapeHtml(issue||"—")+'</td></tr>';
    }).join("")+'</tbody></table>';
}
document.getElementById("refresh").addEventListener("click", async () => {
  const button=document.getElementById("refresh"); button.disabled=true; button.textContent="Refreshing live clients…";
  try {
    const response=await fetch("/api/refresh-all",{method:"POST",headers:actionHeaders});
    if(!response.ok) throw new Error("Could not refresh live clients");
    await load();
  } catch (err) {
    document.getElementById("table").innerHTML='<div class="empty error">'+escapeHtml(err.message)+'</div>';
  } finally { button.disabled=false; button.textContent="Refresh live clients"; }
});
load().catch(err => document.getElementById("table").textContent=err.message);
setInterval(() => load().catch(()=>{}), 30000);
</script>
</body></html>`;
}

function clientDetailHtml(clientSlug, nonce = "") {
  const safeSlug = inlineScriptJson(String(clientSlug || ""));
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Client Operations Detail</title>
  <style nonce="${safeNonce}">${sharedStyles}</style>
</head>
<body>
  <main class="shell">
    <a class="back" href="/">← All clients</a>
    <div class="toolbar spaced-toolbar">
      <div><h1 id="title">Client operations</h1><p class="sub" id="subtitle">Loading…</p></div>
      <div class="actions">
        <label class="lifecycle-control"><span class="label">Lifecycle</span>
          <select id="lifecycle">
            <option value="setup">Setup</option>
            <option value="trial">Trial</option>
            <option value="live">Live</option>
            <option value="paused">Paused</option>
          </select>
        </label>
        <button id="save-lifecycle">Save lifecycle</button>
        <button id="refresh">Refresh client</button>
      </div>
    </div>
    <div id="content" class="empty panel">Loading client…</div>
  </main>
<script nonce="${safeNonce}">
const escapeHtml = ${escapeHtml.toString()};
const clientSlug = ${safeSlug};
const statusLabel = {ready:"Ready",ready_with_warnings:"Ready with warnings",needs_testing:"Testing required",blocked:"Blocked",offline:"Offline"};
const lifecycleLabel = {setup:"Setup",trial:"Trial",live:"Live",paused:"Paused"};
const driftLabel = {current:"Current",drifted:"Drifted",unknown:"Unknown"};
const targetSourceLabel = {configured:"Pinned target",registry_deployment:"Registry deployment",unavailable:"Unavailable"};
const fmt = value => value ? new Date(value).toLocaleString() : "—";
const actionHeaders = {"x-ops-action":"1"};
const actionJsonHeaders = {"x-ops-action":"1","content-type":"application/json"};
const issueRows = items => (items||[]).map(item => '<div class="issue-row"><b>'+escapeHtml(item.summary||item.category||"Issue")+'</b><div>'+escapeHtml(item.action||item.remediationRoute||"")+'</div></div>').join("") || '<div class="muted">None</div>';
function lifecycleHelp(status){
  if(status==='live') return 'Background monitoring is enabled on the normal fleet interval.';
  if(status==='paused') return 'All Registry polling is paused until the lifecycle is changed.';
  return 'Background polling is off. Use Refresh client only when you want to wake and test this setup/trial deployment.';
}
function changedSinceProvisioning(value){return value===true?'Yes':value===false?'No':'Unknown';}
async function load() {
  const response=await fetch('/api/clients/'+encodeURIComponent(clientSlug),{headers:{accept:'application/json'}});
  if(response.status===404) throw new Error('Client not found');
  if(!response.ok) throw new Error('Could not load client');
  const c=await response.json();
  const lifecycle=c.lifecycleStatus||'live';
  document.getElementById('title').textContent=c.displayName||c.clientSlug;
  document.getElementById('subtitle').innerHTML='<span class="badge '+escapeHtml(c.status)+'">'+escapeHtml(statusLabel[c.status]||c.status)+'</span> &nbsp; <span class="badge lifecycle-'+escapeHtml(lifecycle)+'">'+escapeHtml(lifecycleLabel[lifecycle]||lifecycle)+'</span> &nbsp; '+escapeHtml(c.industry||'Unknown industry');
  document.getElementById('lifecycle').value=lifecycle;
  const refreshButton=document.getElementById('refresh');
  refreshButton.disabled=c.manualRefreshAllowed===false;
  refreshButton.title=c.manualRefreshAllowed===false?'Paused clients cannot be refreshed until reactivated.':'';
  const d=c.deployment||{};
  const drift=d.driftStatus||'unknown';
  const channels=(c.channels||[]).map(ch => '<div class="channel-row"><b>'+escapeHtml(ch.channel||'Channel')+' · '+escapeHtml(ch.status||'unknown')+'</b><div>Last verified round trip: '+escapeHtml(fmt(ch.lastVerifiedRoundTripAt))+'</div></div>').join('') || '<div class="muted">No purchased-channel readiness has been recorded yet.</div>';
  document.getElementById('content').outerHTML='<div id="content">'+
    '<div class="detail-grid">'+
      '<section class="panel detail-panel"><h2>Deployment & version drift</h2><dl class="kv"><dt>Render</dt><dd>'+escapeHtml(c.render?.serviceName||c.baseUrl||'—')+'</dd><dt>Version state</dt><dd><span class="badge version-'+escapeHtml(drift)+'">'+escapeHtml(driftLabel[drift]||drift)+'</span></dd><dt>Observed commit</dt><dd>'+escapeHtml(d.observedCommit||'Unknown')+'</dd><dt>Fleet target</dt><dd>'+escapeHtml(d.targetCommit||'Unknown')+'</dd><dt>Target source</dt><dd>'+escapeHtml(targetSourceLabel[d.targetSource]||d.targetSource||'Unavailable')+'</dd><dt>Provisioned commit</dt><dd>'+escapeHtml(d.provisionedCommit||'Unknown')+'</dd><dt>Changed since provisioning</dt><dd>'+escapeHtml(changedSinceProvisioning(d.changedSinceProvisioning))+'</dd><dt>Registry commit</dt><dd>'+escapeHtml(d.registryCommit||'Unknown')+'</dd><dt>App version</dt><dd>'+escapeHtml(d.appVersion||'—')+'</dd><dt>Process started</dt><dd>'+escapeHtml(fmt(d.startedAt))+'</dd><dt>Version observed</dt><dd>'+escapeHtml(fmt(d.lastObservedAt))+'</dd></dl><p class="muted">Deployment drift is read-only. The Registry does not redeploy, upgrade, or change client configuration.</p></section>'+
      '<section class="panel detail-panel"><h2>Lifecycle & monitoring</h2><dl class="kv"><dt>Lifecycle</dt><dd>'+escapeHtml(lifecycleLabel[lifecycle]||lifecycle)+'</dd><dt>Background polling</dt><dd>'+escapeHtml(c.backgroundPollingEnabled?'Enabled':'Disabled')+'</dd><dt>Manual refresh</dt><dd>'+escapeHtml(c.manualRefreshAllowed===false?'Disabled':'Available')+'</dd><dt>Policy</dt><dd>'+escapeHtml(lifecycleHelp(lifecycle))+'</dd></dl><p class="muted">Lifecycle controls Registry polling only. It does not change the Render or Neon billing plan.</p></section>'+
      '<section class="panel detail-panel"><h2>Contact</h2><dl class="kv"><dt>Last attempt</dt><dd>'+escapeHtml(fmt(c.lastPollAttemptAt))+'</dd><dt>Last success</dt><dd>'+escapeHtml(fmt(c.lastSuccessAt))+'</dd><dt>Last known readiness</dt><dd>'+escapeHtml(statusLabel[c.lastKnownReadinessStatus]||c.lastKnownReadinessStatus||'Unknown')+'</dd><dt>HTTP status</dt><dd>'+escapeHtml(c.lastHttpStatus??'—')+'</dd><dt>Current error</dt><dd class="'+(c.lastError?'error':'')+'">'+escapeHtml(c.lastError||'None')+'</dd></dl></section>'+
    '</div>'+
    '<section class="panel detail-panel"><h2>Purchased channels</h2><div class="section-list">'+channels+'</div></section>'+
    '<div class="detail-grid">'+
      '<section class="panel detail-panel"><h2>Blockers</h2><div class="section-list">'+issueRows(c.blockers)+'</div></section>'+
      '<section class="panel detail-panel"><h2>Testing required</h2><div class="section-list">'+issueRows(c.testing)+'</div></section>'+
    '</div>'+
    '<section class="panel detail-panel"><h2>Warnings</h2><div class="section-list">'+issueRows(c.warnings)+'</div></section>'+
  '</div>';
}
document.getElementById('save-lifecycle').addEventListener('click',async()=>{const b=document.getElementById('save-lifecycle');const select=document.getElementById('lifecycle');b.disabled=true;b.textContent='Saving…';try{const response=await fetch('/api/clients/'+encodeURIComponent(clientSlug)+'/lifecycle',{method:'POST',headers:actionJsonHeaders,body:JSON.stringify({lifecycleStatus:select.value})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'Could not update lifecycle');await load();}catch(err){document.getElementById('content').innerHTML='<div class="empty error">'+escapeHtml(err.message)+'</div>';}finally{b.disabled=false;b.textContent='Save lifecycle';}});
document.getElementById('refresh').addEventListener('click',async()=>{const b=document.getElementById('refresh');b.disabled=true;b.textContent='Refreshing…';try{const response=await fetch('/api/clients/'+encodeURIComponent(clientSlug)+'/refresh',{method:'POST',headers:actionHeaders});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'Could not refresh client');await load();}catch(err){document.getElementById('content').innerHTML='<div class="empty error">'+escapeHtml(err.message)+'</div>';}finally{b.disabled=false;b.textContent='Refresh client';}});
load().catch(err=>document.getElementById('content').textContent=err.message);
</script>
</body></html>`;
}

module.exports = {
  clientDetailHtml,
  dashboardHtml,
  escapeHtml,
  inlineScriptJson,
};
