const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const consent = require("../src/db/whatsappInboundConsentRepo");

test("Postgres inbound consent evidence is atomic and rejects duplicate/older messages",
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "inbound_consent_" + process.pid + "_" + Date.now();
    await client.connect();
    try {
      await client.query("CREATE SCHEMA " + schema);
      await client.query("SET search_path TO " + schema);
      await client.query(`
        CREATE TABLE contacts (
          id integer PRIMARY KEY, channel text, whatsapp_opt_in_at timestamptz,
          whatsapp_opt_in_source text, whatsapp_opt_out_at timestamptz,
          whatsapp_marketing_opt_out_at timestamptz,
          whatsapp_marketing_opt_out_source text, updated_at timestamptz DEFAULT now()
        );
        CREATE TABLE leads (
          id integer PRIMARY KEY, contact_id integer REFERENCES contacts(id),
          marketing_consent text NOT NULL DEFAULT 'unknown', updated_at timestamptz DEFAULT now()
        );
        CREATE TABLE messages (
          id integer PRIMARY KEY, contact_id integer REFERENCES contacts(id),
          role text, content text, whatsapp_message_id text,
          created_at timestamptz DEFAULT now(), source_created_at timestamptz,
          media_mime_type text, is_forwarded boolean DEFAULT false
        );
      `);
      const migrations = ["055_whatsapp_marketing_consent_events.sql",
        "058_whatsapp_inbound_marketing_consent_evidence.sql"];
      for(const name of migrations) {
        await client.query(fs.readFileSync(
          path.join(__dirname, "../src/db/migrations", name), "utf8"));
      }
      await client.query(`
        INSERT INTO contacts(id,channel) VALUES(1,'whatsapp');
        INSERT INTO leads(id,contact_id) VALUES(2,1);
        INSERT INTO messages(id,contact_id,role,content,whatsapp_message_id,created_at)
        VALUES(3,1,'user',
          'Hi～想了解 Neutro Sense TCM 的骨盆调理，之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊',
          'wamid.real',now()-interval '5 minutes');
      `);
      const database = { connect: async() => ({
        query:client.query.bind(client), release() {},
      })};
      const opts = {contactId:1, leadId:2, messageId:3,
        businessName:"Neutro Sense TCM Centre", isClickToWhatsApp:true};
      const first = await consent.recordFromInbound(opts, { database });
      assert.equal(first.recorded,true);
      const saved = (await client.query(`
        SELECT e.message_id,e.provider_message_id,e.message_text,
          e.business_name,e.consent_scope,e.consent_category,
          e.consented_at, c.whatsapp_opt_in_at,c.whatsapp_opt_in_source,
          l.marketing_consent FROM whatsapp_marketing_consent_events e
        JOIN contacts c ON c.id=e.contact_id JOIN leads l ON l.id=e.lead_id
      `)).rows;
      assert.equal(saved.length,1);
      assert.equal(saved[0].message_id,3);
      assert.equal(saved[0].provider_message_id,"wamid.real");
      assert.equal(saved[0].business_name,"Neutro Sense TCM Centre");
      assert.equal(saved[0].consent_category,"MARKETING");
      assert.equal(saved[0].marketing_consent,"opted_in");
      assert.equal(saved[0].whatsapp_opt_in_source,"ctwa_explicit_customer_message");
      assert.equal((await consent.recordFromInbound(opts, { database })).recorded,false,
        "same Meta message must not refresh permission");

      await client.query("UPDATE contacts SET whatsapp_opt_out_at=now() WHERE id=1");
      await client.query("UPDATE leads SET marketing_consent='opted_out' WHERE id=2");
      assert.equal((await consent.recordFromInbound(opts, { database })).recorded,false,
        "replayed old message must not undo global STOP");
      assert.equal((await client.query(
        "SELECT marketing_consent FROM leads WHERE id=2")).rows[0].marketing_consent,"opted_out");
    } finally {
      await client.query("SET search_path TO public").catch(()=>{});
      await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(()=>{});
      await client.end();
    }
  });
