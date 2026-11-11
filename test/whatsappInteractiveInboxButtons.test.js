"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {reserveOutboundAttempt} = require("../src/db/inboundProcessingRepo");
const {recoveryTreatmentButtons} = require("../src/services/whatsapp131060Recovery");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("atomic recovery reservation saves exactly the native buttons sent to Meta", async () => {
  const queries = [];
  const db = {async query(sql,params) {
    queries.push({sql,params});
    if (/FROM inbound_processing_jobs\s+WHERE id = \$1\s+FOR UPDATE/.test(sql)) {
      return {rows:[{id:701,message_id:801,contact_id:901,status:"processing",terminal_at:null}]};
    }
    if (/FROM inbound_outbound_attempts a/.test(sql)) return {rows:[]};
    if (/INSERT INTO messages/.test(sql)) return {
      rows:[{id:802,contact_id:901,role:"assistant",content:params[1]}],
    };
    if (/INSERT INTO inbound_outbound_attempts/.test(sql)) return {
      rows:[{processing_job_id:701,inbound_message_id:801,assistant_message_id:802,contact_id:901}],
    };
    return {rows:[]};
  }};
  const buttons = recoveryTreatmentButtons();
  const result = await reserveOutboundAttempt({
    processingJobId:701,contactId:901,content:"Hi～欢迎来到 Neutro Sense 😊",
    origin:"system_fallback",interactiveButtons:buttons,
  },db);
  assert.equal(result.message.id,802);
  const insert = queries.find(({sql})=>/INSERT INTO messages/.test(sql));
  assert.match(insert.sql,/whatsapp_interactive/);
  assert.match(insert.sql,/\$3::jsonb/);
  assert.deepEqual(JSON.parse(insert.params[2]),{type:"button",buttons});
  assert.equal(queries[0].sql,"BEGIN");
  assert.equal(queries.at(-1).sql,"COMMIT");
  assert.equal(queries.filter(({sql})=>/INSERT INTO messages/.test(sql)).length,1);
});

test("ordinary AI replies never acquire treatment buttons through the persistence path",async()=>{
  const db={query:async()=>{throw Error("must reject before DB access")}};
  for(const invalid of [
    {origin:"ai_reply",interactiveButtons:recoveryTreatmentButtons()},
    {origin:"system_fallback",interactiveButtons:[{id:"random",title:"Dummy"}]},
    {origin:"system_fallback",interactiveButtons:[]},
  ])await assert.rejects(
    reserveOutboundAttempt({processingJobId:701,contactId:901,content:"text",...invalid},db),
    TypeError
  );
});

test("both portal thread-page queries include lightweight read-only interactive metadata",()=>{
  const sql = source("src/db/messagesRepo.js");
  const sections = sql.slice(sql.indexOf("async function getMessagePageForContact("),
    sql.indexOf("// Returns only the R2 reference",sql.indexOf("async function getMessagePageForContact(")));
  assert.equal((sections.match(/\bwhatsapp_interactive\b/g)||[]).length,2);
  assert.match(sections,/WHERE contact_id = \$1 AND id > \$2/);
  assert.match(sections,/WHERE contact_id = \$1\$\{cursorClause\}/);
  const inbox=source("portal-frontend/src/pages/Inbox.jsx");
  assert.match(inbox,/message\.whatsapp_interactive\?\.type === "button"/);
  assert.match(inbox,/role="group" aria-label="WhatsApp reply options sent"/);
  assert.match(inbox,/Read-only in Inbox/);
});

test("migration backfills only provider-accepted Neutro secondary recovery choices",()=>{
  const migration=source("src/db/migrations/123_whatsapp_interactive_inbox_buttons.sql");
  assert.match(migration,/ADD COLUMN IF NOT EXISTS whatsapp_interactive JSONB/);
  assert.match(migration,/JOIN outbound_message_evidence AS receipt/);
  assert.match(migration,/receipt\.accepted IS TRUE/);
  assert.match(migration,/receipt\.provider_message_id = m\.whatsapp_message_id/);
  assert.match(migration,/sa\.sender_key = 'neutro_secondary'/);
  assert.match(migration,/m\.whatsapp_interactive IS NULL/);
  assert.match(migration,/m\.delivery_status IN \('sent', 'delivered', 'read'\)/);
  assert.match(migration,/neutro_131060_9d/);
});
