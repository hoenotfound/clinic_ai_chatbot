-- The RM100 pelvic assessment voucher is staff-verified; never automatically
-- issue or redeem it from an AI message or an unconfirmed booking.
CREATE TABLE IF NOT EXISTS assessment_voucher_tracking (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('eligible', 'issued', 'redeemed', 'voided')),
  assessed_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  updated_by TEXT NOT NULL,
  redemption_note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_voucher_tracking_status
  ON assessment_voucher_tracking(status);
