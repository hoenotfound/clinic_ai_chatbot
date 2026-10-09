const test = require("node:test");
const assert = require("node:assert/strict");
const repo = require("../src/db/whatsappInboundConsentRepo");

const wording = "Hi～想了解 Neutro Sense TCM 的骨盆调理，之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊";
const input = { contactId: 9, leadId: 7, messageId: 15, businessName: "Neutro Sense TCM Centre", isClickToWhatsApp: true };

function database({
  messageText = wording, role = "user", media = null, provider = "wamid.15",
  existingOptIn = null, globalOptOut = null, marketingOptOut = null,
  leadExists = true, inserted = true, forwarded = false,
} = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM contacts WHERE id=\$1 FOR UPDATE/.test(sql)) return { rows: [{
        id: 9, channel: "whatsapp", whatsapp_opt_in_at: existingOptIn,
        whatsapp_opt_out_at: globalOptOut, whatsapp_marketing_opt_out_at: marketingOptOut,
      }] };
      if (/FROM messages WHERE id=\$1 AND contact_id=\$2/.test(sql)) {
        return { rows: [{
          id: 15, role, content: messageText, whatsapp_message_id: provider,
          sent_at: new Date("2026-10-09T01:00:00Z"), media_mime_type: media,
          is_forwarded: forwarded,
        }] };
      }
      if (/SELECT id FROM leads WHERE id=\$1/.test(sql))
        return { rows: leadExists ? [{ id: 7 }] : [] };
      if (/INSERT INTO whatsapp_marketing_consent_events/.test(sql))
        return { rows: inserted ? [{ id: 101 }] : [], rowCount: inserted ? 1 : 0 };
      return { rowCount: 1, rows: [] };
    },
    release() { calls.push({sql:"RELEASE"}); },
  };
  return { calls, driver: { connect: async () => client } };
}

test("transactionally stores source message, provider id, business, time and marketing scope", async () => {
  const { calls, driver } = database();
  const result = await repo.recordFromInbound(input, { database: driver });
  assert.equal(result.recorded, true);
  const inserted = calls.find((row) => row.sql.includes("INSERT INTO whatsapp_marketing_consent_events"));
  assert.ok(inserted);
  assert.deepEqual(inserted.params.slice(0,5), [9,7,"ctwa_explicit_customer_message",15,"wamid.15"]);
  assert.equal(inserted.params[5], wording);
  assert.equal(inserted.params[6], "Neutro Sense TCM Centre");
  assert.equal(inserted.params[7], "treatment_followups_and_related_offers");
  assert.equal(inserted.params[8], "MARKETING");
  assert.equal(inserted.params[9], "2026-10-09T01:00:00.000Z");
  assert.equal(inserted.params[10], "customer_whatsapp_text");
  assert.match(calls.find((row)=>row.sql.startsWith("UPDATE contacts")).sql, /whatsapp_opt_in_at=\$2/);
  assert.match(calls.find((row)=>row.sql.startsWith("UPDATE leads")).sql, /marketing_consent='opted_in'/);
  assert.ok(calls.find((row)=>row.sql==="COMMIT"));
});

test("does not create permission from enquiries, synthetic media, or absent lead", async () => {
  for (const opts of [
    {messageText:"你好！我想了解你们骨盆的疗程"},
    {messageText:wording,media:"image/jpeg"},
    {messageText:wording,role:"assistant"},
    {messageText:wording,provider:null},
    {messageText:wording,forwarded:true},
    {messageText:wording,leadExists:false},
  ]) {
    const { calls, driver } = database(opts);
    const result = await repo.recordFromInbound(input, { database: driver });
    assert.equal(result.recorded, false);
    assert.equal(calls.some((c)=>c.sql.startsWith("UPDATE contacts")),false);
    assert.equal(calls.some((c)=>c.sql.startsWith("UPDATE leads")),false);
  }
});

test("replayed messages and previously opted-out contacts cannot silently restore consent", async () => {
  const cases = [
    { existingOptIn: "2026-10-09T01:01:00Z" },
    { globalOptOut: "2026-10-09T00:50:00Z" },
    { marketingOptOut: "2026-10-09T01:03:00Z" },
    { inserted:false },
  ];
  for (const opts of cases) {
    const { calls, driver } = database(opts);
    assert.equal((await repo.recordFromInbound(input, { database:driver })).recorded, false);
    assert.equal(calls.some((c)=>c.sql.startsWith("UPDATE leads")),false);
    assert.equal(calls.some((c)=>c.sql.startsWith("UPDATE contacts")),false);
    assert.ok(calls.find((c)=>c.sql==="ROLLBACK"));
  }
});

test("a genuinely newer explicit message may renew promotional consent after a marketing-only opt-out", async () => {
  const { calls,driver } = database({marketingOptOut:"2026-10-09T00:45:00Z"});
  assert.equal((await repo.recordFromInbound(input, { database:driver })).recorded,true);
  assert.ok(calls.some((c)=>c.sql.startsWith("UPDATE leads")));
});
