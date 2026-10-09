"use strict";

const { pool } = require("../db/db");
const clinicConfig = require("../config/clinicConfig");
const { configuredAccount } = require("./whatsappZeroCostGuard");

class ReconcileError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Reconciliation NEVER changes provider pricing evidence and NEVER claims that
// an unpriced message was free. It is a deliberate audited operator override
// after independently checking the conversation and Meta Billing Hub.
async function reconcile({ actor, reservationId, reason, confirmedBillingHub }, database = pool) {
  const account = configuredAccount();
  if (!account) throw new ReconcileError("account_not_configured","WhatsApp account is not configured.",503);
  if (!actor || !String(actor).trim()) throw new ReconcileError("operator_required","A signed-in administrator is required.",403);
  if (confirmedBillingHub !== true) throw new ReconcileError(
    "billing_check_required","Check Meta Billing Hub and the customer conversation before manually releasing a send.");
  if (typeof reason !== "string" || reason.trim().length < 30 || reason.length > 1000)
    throw new ReconcileError("reason_required","Provide an investigation reason between 30 and 1000 characters.",400);
  if (typeof reservationId !== "string" || !/^[0-9a-f-]{36}$/i.test(reservationId))
    throw new ReconcileError("reservation_required","Refresh the gate status and select the current reservation.",400);

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const gate = (await client.query(
      `SELECT * FROM whatsapp_free_only_send_gate
       WHERE phone_number_id=$1 FOR UPDATE`,[account])).rows[0];
    if (!gate || gate.status === "idle" || gate.reservation_id !== reservationId)
      throw new ReconcileError("reservation_changed",
        "The reservation changed. Refresh before reconciling.");

    const activatedAt=clinicConfig.automatedFollowUp?.whatsappFreeOnly?.activatedAt;
    const validActivation=typeof activatedAt === "string" && Number.isFinite(Date.parse(activatedAt));
    if (!validActivation) throw new ReconcileError("activation_unverified",
      "Strict-mode activation is not available; refusing to reset an unresolved send.");

    const alarm=(await client.query(
      `SELECT EXISTS (SELECT 1 FROM whatsapp_free_entry_pricing_evidence
        WHERE billable=true AND updated_at >= $1::timestamptz) AS tripped`,
      [activatedAt])).rows[0];
    if (alarm?.tripped !== false) throw new ReconcileError("billing_alarm_active",
      "Meta reported a billable message. Do not reset this reservation while the billing alarm is active.");

    const priced=gate.wamid ? (await client.query(
      `SELECT pricing_type,billable,delivery_status
       FROM whatsapp_free_entry_pricing_evidence WHERE wamid=$1`,[gate.wamid])).rows[0] : null;
    if (priced?.billable === true) throw new ReconcileError("message_billable",
      "Meta recorded a billable message. Do not override the billing alarm.");

    await client.query(
      `INSERT INTO whatsapp_free_only_reconciliations
       (phone_number_id,reservation_id,prior_status,wamid,message_id,attempt_id,
        actor,reason,verified_billing_hub,provider_pricing_type,provider_billable)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
      [account,gate.reservation_id,gate.status,gate.wamid||null,
        gate.message_id||null,gate.attempt_id||null,
        String(actor).slice(0,160),reason.trim(),
        priced?.pricing_type||null,priced?.billable??null]);
    await client.query(
      `UPDATE whatsapp_free_only_send_gate SET status='idle',
         reservation_id=NULL,wamid=NULL,recipient=NULL,
         message_id=NULL,attempt_id=NULL,updated_at=now()
       WHERE phone_number_id=$1 AND reservation_id=$2`,[account,reservationId]);
    await client.query("COMMIT");
    return {
      success:true,priorStatus:gate.status,
      billingVerifiedByMeta:priced?.pricing_type==="free_entry_point" && priced.billable===false,
      note:"Operator-reconciled; Meta billing is not guaranteed free by this action.",
    };
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally { client.release(); }
}

module.exports = { reconcile, ReconcileError };
