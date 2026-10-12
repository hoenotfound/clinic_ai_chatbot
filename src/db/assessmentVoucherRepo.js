"use strict";

const { pool } = require("./db");
const { hasCapability } = require("../utils/permissions");

const VOUCHER_VALUE_RM = 100;
const STATUSES = new Set(["eligible", "issued", "redeemed", "voided"]);
const TRANSITIONS = Object.freeze({
  none: ["eligible"],
  eligible: ["issued", "voided"],
  issued: ["redeemed", "voided"],
  redeemed: [],
  voided: [],
});

class VoucherValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "VoucherValidationError";
    this.status = status;
  }
}

function validTransition(previous, next) {
  return STATUSES.has(next) && (TRANSITIONS[previous || "none"] || []).includes(next);
}

function isPelvicLead(treatmentInterest) {
  return /^(?:骨盆(?:调理|調理|矫正|矯正|调整|調整)|骨盤(?:調理|调理)|骨盘(?:调理|調理)|pelvic\s+(?:care|adjustment|treatment))$/iu
    .test(String(treatmentInterest || "").trim());
}

function publicVoucher(row) {
  return row ? {
    status: row.status,
    valueRm: VOUCHER_VALUE_RM,
    assessedAt: row.assessed_at,
    issuedAt: row.issued_at,
    redeemedAt: row.redeemed_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    redemptionNote: row.redemption_note,
  } : { status: "not_verified", valueRm: VOUCHER_VALUE_RM };
}

async function getVoucher(leadId, queryable = pool) {
  const result = await queryable.query(
    "SELECT * FROM assessment_voucher_tracking WHERE lead_id = $1",
    [leadId]
  );
  return publicVoucher(result.rows[0]);
}

async function transitionVoucher(leadId, { status, redemptionNote, termsConfirmed }, actor, database = pool) {
  const next = String(status || "");
  if (!STATUSES.has(next)) throw new VoucherValidationError("Invalid voucher action.");
  if (!actor || typeof actor !== "string") throw new VoucherValidationError("Staff identity is required.", 403);
  if (status === "issued" && termsConfirmed !== true) {
    throw new VoucherValidationError("Staff must confirm voucher terms before issuing.");
  }
  if (status === "redeemed" && (typeof redemptionNote !== "string" || !redemptionNote.trim())) {
    throw new VoucherValidationError("A redemption note describing the agreed terms is required.");
  }
  if (redemptionNote != null &&
      (typeof redemptionNote !== "string" || redemptionNote.trim().length > 500)) {
    throw new VoucherValidationError("Redemption note must be at most 500 characters.");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const leadResult = await client.query(
      "SELECT id, appointment_status, treatment_interest FROM leads WHERE id = $1 FOR UPDATE",
      [leadId]
    );
    const lead = leadResult.rows[0];
    if (!lead) {
      await client.query("ROLLBACK");
      return null;
    }
    const currentResult = await client.query(
      "SELECT * FROM assessment_voucher_tracking WHERE lead_id = $1 FOR UPDATE",
      [leadId]
    );
    const current = currentResult.rows[0] || null;
    if (!validTransition(current?.status, next)) {
      throw new VoucherValidationError("Voucher state changed or that action is no longer available.", 409);
    }
    if (next === "eligible" &&
        (lead.appointment_status !== "visited" || !isPelvicLead(lead.treatment_interest))) {
      throw new VoucherValidationError(
        "Confirm the pelvic treatment interest and mark the appointment as Visited before verifying assessment attendance."
      );
    }
    const result = await client.query(
      `INSERT INTO assessment_voucher_tracking (
        lead_id, status, assessed_at, issued_at, redeemed_at, updated_by, redemption_note
       ) VALUES (
        $1, $2, CASE WHEN $2 = 'eligible' THEN now() ELSE NULL END,
        CASE WHEN $2 = 'issued' THEN now() ELSE NULL END,
        CASE WHEN $2 = 'redeemed' THEN now() ELSE NULL END, $3, $4
       )
       ON CONFLICT (lead_id) DO UPDATE SET
         status = EXCLUDED.status,
         issued_at = CASE WHEN EXCLUDED.status = 'issued' THEN now() ELSE assessment_voucher_tracking.issued_at END,
         redeemed_at = CASE WHEN EXCLUDED.status = 'redeemed' THEN now() ELSE assessment_voucher_tracking.redeemed_at END,
         updated_by = EXCLUDED.updated_by,
         redemption_note = CASE WHEN EXCLUDED.status = 'redeemed' THEN EXCLUDED.redemption_note
                                ELSE assessment_voucher_tracking.redemption_note END,
         updated_at = now()
       RETURNING *`,
      [leadId, next, actor, status === "redeemed" ? redemptionNote.trim() : null]
    );
    await client.query(
      `INSERT INTO lead_activities (lead_id, activity_type, description, actor, metadata)
       VALUES ($1, 'updated', $2, $3, $4)`,
      [leadId, {
        eligible: "RM100 pelvic assessment voucher eligibility confirmed after attendance.",
        issued: "RM100 pelvic assessment voucher issued by staff.",
        redeemed: "RM100 pelvic assessment voucher redeemed with staff-confirmed terms.",
        voided: "RM100 pelvic assessment voucher voided by staff.",
      }[next], actor, {
        type: "pelvic_assessment_voucher",
        from: current?.status || "not_verified",
        to: next,
        ...(status === "redeemed" ? { redemptionNote: redemptionNote.trim() } : {}),
      }]
    );
    await client.query("COMMIT");
    return publicVoucher(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  VOUCHER_VALUE_RM,
  VoucherValidationError,
  getVoucher,
  isPelvicLead,
  publicVoucher,
  transitionVoucher,
  validTransition,
};
