"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const guard = require("../src/services/whatsappZeroCostGuard");
const config = require("../src/config/clinicConfig");

test("Postgres: free-only gate reconciles only durable Meta nonbillable pricing proof across callback orderings", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "strict_gate_reconcile_" + process.pid + "_" + Date.now();
  const previous = config.automatedFollowUp;
  const previousPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  config.automatedFollowUp = {
    ...(previous || {}),
    whatsappFreeOnly: { enabled: true, activatedAt: "2026-10-13T02:00:00.000Z" },
  };
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  t.after(() => {
    config.automatedFollowUp = previous;
    if (previousPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhone;
  });
  await client.connect();
  try {
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query(`
      CREATE TABLE whatsapp_free_only_send_gate (
        phone_number_id TEXT PRIMARY KEY, status TEXT NOT NULL,
        reservation_id TEXT, wamid TEXT, recipient TEXT,
        message_id INTEGER, attempt_id BIGINT, updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE whatsapp_free_entry_pricing_evidence (
        wamid TEXT PRIMARY KEY, pricing_type TEXT NOT NULL, billable BOOLEAN,
        delivery_status TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE whatsapp_free_only_reconciliations (
        id BIGSERIAL PRIMARY KEY, phone_number_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL, prior_status TEXT NOT NULL,
        wamid TEXT, message_id INTEGER, attempt_id BIGINT,
        actor TEXT NOT NULL, reason TEXT NOT NULL, verified_billing_hub BOOLEAN NOT NULL,
        provider_pricing_type TEXT, provider_billable BOOLEAN,
        reconciled_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO whatsapp_free_only_send_gate
        (phone_number_id,status,reservation_id,wamid,recipient,message_id)
      VALUES ('123456789','awaiting_pricing','reservation-1','wamid.proven','60110000000',55);
    `);
    // No matching receipt, wrong receipt and billable receipts must never clear.
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query(`
      INSERT INTO whatsapp_free_entry_pricing_evidence
        (wamid,pricing_type,billable,delivery_status)
      VALUES ('wamid.another','free_entry_point',false,'read')
    `);
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query(`
      INSERT INTO whatsapp_free_entry_pricing_evidence
        (wamid,pricing_type,billable,delivery_status)
      VALUES ('wamid.proven','free_entry_point',true,'delivered')
    `);
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query("UPDATE whatsapp_free_entry_pricing_evidence SET billable=NULL WHERE wamid='wamid.proven'");
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query("UPDATE whatsapp_free_entry_pricing_evidence SET billable=false,delivery_status='failed' WHERE wamid='wamid.proven'");
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query("UPDATE whatsapp_free_entry_pricing_evidence SET delivery_status='read' WHERE wamid='wamid.proven'");
    // An account-wide billable alarm must override the eligible receipt.
    await client.query(`INSERT INTO whatsapp_free_entry_pricing_evidence
      (wamid,pricing_type,billable,delivery_status)
      VALUES ('wamid.billable.alarm','regular',true,'sent')`);
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query("DELETE FROM whatsapp_free_entry_pricing_evidence WHERE wamid='wamid.billable.alarm'");
    // Callback can be saved while the local outbound messages table has no
    // WAMID yet. Provider-accepted gate and matching nonbillable Meta receipt
    // still reconcile, without trusting a separate/unknown reservation.
    assert.equal(await guard.reconcileConfirmedGate(client), true);
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    const released = (await client.query("SELECT * FROM whatsapp_free_only_send_gate")).rows[0];
    assert.equal(released.status, "idle");
    assert.equal(released.wamid, null);
    const audits = (await client.query("SELECT * FROM whatsapp_free_only_reconciliations")).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].wamid, "wamid.proven");
    assert.equal(audits[0].provider_billable, false);
    assert.equal(audits[0].actor, "automatic_verified_receipt");
    // A missing reservation id can never release a gate without an audit.
    await client.query(`UPDATE whatsapp_free_only_send_gate
       SET status='awaiting_pricing',wamid='wamid.proven',reservation_id=NULL`);
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query(`UPDATE whatsapp_free_only_send_gate
       SET status='unknown',reservation_id='reservation-2'`);
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    await client.query("UPDATE whatsapp_free_only_send_gate SET status='reserved'");
    assert.equal(await guard.reconcileConfirmedGate(client), false);
    assert.equal((await client.query("SELECT COUNT(*)::int count FROM whatsapp_free_only_reconciliations")).rows[0].count, 1);
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
    await client.end();
  }
});
