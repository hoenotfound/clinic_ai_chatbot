const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { planTcmReviewReply } = require("../src/utils/tcmServiceReviewReply");
const { followUpAttentionAllowedSql } = require("../src/utils/aiReviewPolicy");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const services = [{ name: "骨盆调理" }, { name: "3D 小颜术" }];
const serviceAliases = [
  { alias: "pelvic adjustment", officialService: "骨盆调理" },
  { alias: "face alignment", officialService: "3D 小颜术" },
];

// Real PostgreSQL review persistence + conversational decision loop, using a
// fake provider to avoid delivering messages to an actual WhatsApp customer.
test("three-message TCM conversation preserves staff reviews, AI ownership and all media/follow-up gates", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { Client } = require("pg");
  const { pool } = require("../src/db/db");
  const contacts = require("../src/db/contactsRepo");
  const telegram = require("../src/services/telegramImmediateAlertService");
  const pushes = require("../src/services/webPushNotificationService");
  const schema = "tcm_flow_" + process.pid + "_" + Date.now();
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const savedQuery = pool.query;
  const savedAlert = telegram.sendAiReviewAlert;
  const savedPush = pushes.sendContactAlertBestEffort;
  await client.connect();
  try {
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query([
      "CREATE TABLE contacts (",
      " id integer primary key, mode text NOT NULL DEFAULT 'ai',",
      " needs_attention boolean DEFAULT false, attention_reason text,",
      " updated_at timestamptz DEFAULT now()",
      ");",
      "CREATE TABLE messages (",
      " id integer primary key, contact_id integer REFERENCES contacts(id),",
      " role text, content text, created_at timestamptz DEFAULT now(),",
      " sent_by_username text, delivery_status text, whatsapp_message_id text,",
      " is_automated_follow_up boolean NOT NULL DEFAULT false",
      ");",
      "INSERT INTO contacts(id) VALUES (7);",
    ].join("\n"));
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/064_ai_review_items.sql"), "utf8"));

    pool.query = (...args) => client.query(...args);
    let reviewAlerts = 0;
    telegram.sendAiReviewAlert = async () => {
      reviewAlerts += 1;
      return { status: "sent" };
    };
    pushes.sendContactAlertBestEffort = () => {};

    const history = [
      { role: "user", content: "Can I know where is your location?" },
      { role: "assistant", content: "We are located in Petaling Jaya." },
    ];
    const sent = [];
    const turns = [
      [1427, "Lumber spine 4 + 5"],
      [1428, "Pelvic adjustment"],
      [1429, "Face alignment"],
    ];
    for (const [id, content] of turns) {
      await client.query("INSERT INTO messages(id,contact_id,role,content) VALUES ($1,7,'user',$2)", [id, content]);
      history.push({ role: "user", content });
      const evidence = await contacts.getTcmReviewEvidence(7,id);
      assert.ok(evidence, content);
      const plan = planTcmReviewReply({
        businessType: "tcm_clinic",
        customerText: content,
        services, serviceAliases, language: "en", conversationHistory: history,
        ...evidence,
      });
      assert.ok(plan, content);
      assert.equal(plan.preserveReview, true);
      // The same persistence method used by the webhook creates durable rows,
      // one staff alert per question, and never switches the contact to Human.
      await contacts.setAiReviewAttention(7, id, content, "clinical");
      if (plan.reply) {
        sent.push(plan.reply);
        await client.query("INSERT INTO messages(id,contact_id,role,content,whatsapp_message_id,delivery_status) VALUES ($1,7,'assistant',$2,$3,'sent')", [id+1000,plan.reply,"wamid-"+id]);
        history.push({ role: "assistant", content: plan.reply });
      }
    }

    const reviews = (await client.query(
      "SELECT inbound_message_id,category,status FROM ai_review_items ORDER BY inbound_message_id"
    )).rows;
    assert.deepEqual(reviews.map((r) => Number(r.inbound_message_id)), [1427,1428,1429]);
    assert.ok(reviews.every((r) => r.category === "clinical" && r.status === "pending"));
    const contact = (await client.query("SELECT mode,needs_attention FROM contacts WHERE id=7")).rows[0];
    assert.equal(contact.mode, "ai");
    assert.equal(contact.needs_attention, true);
    assert.equal(reviewAlerts, 3);
    assert.equal(sent.length, 3);
    assert.equal(sent.filter((r) => /arrange a 1-to-1 assessment/i.test(r)).length, 1);
    assert.equal(await contacts.hasPendingClinicalAiReview(7), true);
    assert.equal(await contacts.canSendAutomaticReviewMedia(7), false);
    const gate = await client.query("SELECT " + followUpAttentionAllowedSql("c") + " AS allowed FROM contacts c WHERE id=7");
    assert.equal(gate.rows[0].allowed, false);

    // Resolving the rows explicitly is the only way to remove clinical status.
    await client.query("UPDATE ai_review_items SET status='resolved' WHERE contact_id=7");
    assert.equal(await contacts.hasPendingClinicalAiReview(7), false);
    // Old spinal questions must not trigger fresh staff reviews after a
    // practitioner has resolved the previous clinical review.
    await client.query("INSERT INTO messages(id,contact_id,role,content) VALUES (1430,7,'user','Face alignment')");
    const resolvedEvidence = await contacts.getTcmReviewEvidence(7,1430);
    assert.deepEqual(resolvedEvidence.recentCustomerTexts,[]);
    assert.equal(resolvedEvidence.pendingClinicalReview,false);
    assert.equal(planTcmReviewReply({
      businessType:"tcm_clinic",customerText:"Face alignment",language:"en",
      services,serviceAliases,conversationHistory:history,...resolvedEvidence,
    }).preserveReview,false);

    // A previous accepted invitation outside the short window cannot suppress
    // a new enquiry. Failed and staff-authored drafts cannot qualify either.
    await client.query("UPDATE messages SET created_at=now()-interval '1 day' WHERE role='assistant'");
    await client.query("INSERT INTO messages(id,contact_id,role,content,delivery_status) VALUES (3000,7,'assistant','Would you like to arrange a 1-to-1 assessment?','failed')");
    const laterEvidence = await contacts.getTcmReviewEvidence(7,1430);
    assert.deepEqual(laterEvidence.recentAcceptedAssistantTexts,[]);
    assert.equal(planTcmReviewReply({
      businessType:"tcm_clinic",customerText:"Face alignment",language:"en",
      services,serviceAliases,conversationHistory:history,...laterEvidence,
    }).alreadyInvited,false);

    // A database outage is NOT interpreted as permission to downgrade.
    pool.query = async () => { throw new Error("test: database unavailable"); };
    assert.equal(await contacts.hasPendingClinicalAiReview(7), null);
  } finally {
    pool.query = savedQuery;
    telegram.sendAiReviewAlert = savedAlert;
    pushes.sendContactAlertBestEffort = savedPush;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
    await client.end();
  }
});
