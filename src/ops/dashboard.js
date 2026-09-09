function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DA Chatbot Operations</title>
  <style>
    :root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f6f7fb}
    *{box-sizing:border-box} body{margin:0}.shell{max-width:1180px;margin:0 auto;padding:32px 20px 56px}
    h1{margin:0;font-size:28px}.sub{color:#667085;margin:7px 0 24px}.toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
    button{border:0;border-radius:10px;background:#5b5bd6;color:white;padding:10px 14px;font-weight:650;cursor:pointer}
    button:disabled{opacity:.55;cursor:wait}.cards{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:12px;margin:20px 0}
    .card,.panel{background:white;border:1px solid #e4e7ec;border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.03)}
    .card{padding:16px}.card b{display:block;font-size:24px;margin-top:6px}.label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#667085}
    .panel{overflow:auto}table{width:100%;border-collapse:collapse;min-width:900px}th,td{padding:14px 16px;text-align:left;border-bottom:1px solid #eef0f3;font-size:14px}
    th{font-size:12px;text-transform:uppercase;color:#667085;background:#fafbfc}.client{font-weight:700}.muted{color:#667085;font-size:12px;margin-top:3px}
    .badge{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:700;background:#eef2f6}
    .ready{background:#e8f7ee;color:#157347}.ready_with_warnings{background:#fff5d6;color:#8a6200}.needs_testing{background:#fff0dc;color:#9a4c00}.blocked{background:#feecec;color:#b42318}.offline{background:#eef2f6;color:#475467}
    .channels{display:flex;gap:5px;flex-wrap:wrap}.channel{background:#f2f4f7;border-radius:7px;padding:4px 7px;font-size:11px;font-weight:650}
    .error{color:#b42318;max-width:260px}.empty{text-align:center;padding:40px;color:#667085}
    @media(max-width:760px){.cards{grid-template-columns:repeat(2,1fr)}.shell{padding:22px 14px}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="toolbar">
      <div><h1>DA Chatbot Operations</h1><p class="sub">Read-only fleet readiness across isolated client deployments.</p></div>
      <button id="refresh">Refresh all</button>
    </div>
    <section class="cards" id="summary"></section>
    <section class="panel"><div id="table" class="empty">Loading clients…</div></section>
  </main>
<script>
const escapeHtml = ${escapeHtml.toString()};
const statusLabel = {
  ready:"Ready",
  ready_with_warnings:"Ready + warnings",
  needs_testing:"Testing",
  blocked:"Blocked",
  offline:"Offline"
};
const fmt = value => value ? new Date(value).toLocaleString() : "—";
async function load() {
  const response = await fetch("/api/clients", {headers:{accept:"application/json"}});
  if (!response.ok) throw new Error("Could not load registry");
  const data = await response.json();
  const s = data.summary || {};
  document.getElementById("summary").innerHTML = [
    ["Clients",s.total||0,""],
    ["Ready",(s.ready||0)+(s.ready_with_warnings||0),"ready"],
    ["Testing",s.needs_testing||0,"needs_testing"],
    ["Blocked",s.blocked||0,"blocked"],
    ["Offline",s.offline||0,"offline"]
  ].map(([label,count,cls]) => '<div class="card"><span class="label">'+label+'</span><b class="'+cls+'">'+count+'</b></div>').join("");
  const rows = data.clients || [];
  if (!rows.length) {
    document.getElementById("table").innerHTML = '<div class="empty">No clients registered yet.</div>';
    return;
  }
  document.getElementById("table").innerHTML = '<table><thead><tr><th>Client</th><th>Industry</th><th>Channels</th><th>Status</th><th>Last seen</th><th>Version</th><th>Issue</th></tr></thead><tbody>'+
    rows.map(c => {
      const channels=(c.purchasedChannels||[]).map(v=>'<span class="channel">'+escapeHtml(v)+'</span>').join("");
      const deployment=c.deployment||{};
      const issue=c.lastError || c.readiness?.blockers?.[0]?.summary || c.readiness?.testingRequired?.[0]?.summary || "";
      return '<tr><td><div class="client">'+escapeHtml(c.displayName)+'</div><div class="muted">'+escapeHtml(c.clientSlug)+'</div></td>'+
        '<td>'+escapeHtml(c.industry||"—")+'</td>'+
        '<td><div class="channels">'+channels+'</div></td>'+
        '<td><span class="badge '+escapeHtml(c.status)+'">'+escapeHtml(statusLabel[c.status]||c.status)+'</span></td>'+
        '<td>'+escapeHtml(fmt(c.lastSuccessAt))+'</td>'+
        '<td>'+escapeHtml(deployment.state==="current"?"Current":deployment.state==="different"?"Different":"Unknown")+'<div class="muted">'+escapeHtml((deployment.deployedCommit||"").slice(0,8))+'</div></td>'+
        '<td class="'+(issue?"error":"")+'">'+escapeHtml(issue||"—")+'</td></tr>';
    }).join("")+'</tbody></table>';
}
document.getElementById("refresh").addEventListener("click", async () => {
  const button=document.getElementById("refresh"); button.disabled=true; button.textContent="Refreshing…";
  try { await fetch("/api/refresh-all",{method:"POST"}); await load(); }
  finally { button.disabled=false; button.textContent="Refresh all"; }
});
load().catch(err => document.getElementById("table").textContent=err.message);
setInterval(() => load().catch(()=>{}), 30000);
</script>
</body></html>`;
}

module.exports = {
  dashboardHtml,
  escapeHtml,
};
