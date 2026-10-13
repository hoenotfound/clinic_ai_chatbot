const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const zeroCost = require("../src/services/whatsappZeroCostGuard");
const scoring = require("../src/services/leadScoringAiService");
const followUp = require("../src/services/followUpAiService");

test("Strict RM0 reconciles an accepted free receipt without weakening billable and unknown holds", async (t) => {
  const old = clinicConfig.automatedFollowUp;
  const phone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  clinicConfig.automatedFollowUp = {
    ...old, whatsappFreeOnly: { enabled: true, activatedAt: "2026-10-13T03:34:05.624Z" },
  };
  process.env.WHATSAPP_PHONE_NUMBER_ID = "1408739622311791";
  t.after(() => {
    clinicConfig.automatedFollowUp = old;
    if (phone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = phone;
  });
  let calls = 0;
  const released = await zeroCost.reconcileConfirmedGate({
    async query(sql, params) {
      calls += 1;
      assert.match(sql, /status = 'awaiting_pricing'/);
      assert.match(sql, /pricing_type = 'free_entry_point'/);
      assert.match(sql, /e.billable = false/);
      assert.match(sql, /alarm.billable = true/);
      assert.match(sql, /g.reservation_id IS NOT NULL/);
      assert.doesNotMatch(sql, /JOIN messages m/); // Meta receipt can precede local link
      assert.match(sql, /FOR UPDATE OF g/);
      assert.match(sql, /INSERT INTO whatsapp_free_only_reconciliations/);
      assert.deepEqual(params, ["1408739622311791", "2026-10-13T03:34:05.624Z"]);
      return { rows: [{ released: 1 }] };
    },
  });
  assert.equal(released, true);
  assert.equal(calls, 1);
});

test("Strict RM0 automatic receipts and manual Billing Hub confirmations are distinct proof sources", () => {
  const sql = zeroCost.VERIFIED_WINDOW_SQL;
  assert.match(sql, /audit\.actor IN \('automatic_verified_receipt','evidence_reconciliation'\)/);
  assert.match(sql, /audit\.verified_billing_hub=true/);
  assert.match(sql, /audit\.provider_pricing_type='free_entry_point'/);
  assert.match(sql, /audit\.provider_billable=false/);
  assert.match(sql, /receipt\.wamid=audit\.wamid/);
  assert.match(sql, /receipt\.delivery_status IN \('sent','delivered','read'\)/);
});

test("Strict RM0 disabled never reconciles or touches the database", async (t) => {
  const old = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = { ...old, whatsappFreeOnly: { enabled: false } };
  t.after(() => { clinicConfig.automatedFollowUp = old; });
  assert.equal(await zeroCost.reconcileConfirmedGate({ query() {
    throw new Error("must not query");
  } }), false);
});

test("lead-scoring model candidates have an alternate and do not repeat the same model", () => {
  const ready = scoring.leadScoringModelsReady(0);
  assert.ok(ready.includes(scoring.GEMINI_MODEL));
  assert.equal(new Set(ready).size, ready.length);
  assert.ok(scoring.MODEL_CAPACITY_COOLDOWN_MS >= 60000);
  assert.equal(scoring.createLeadScoringModelUnavailableError(new Error("503"), "fallback-model").model, "fallback-model");
});

test("one-branch follow-up rejects requests for nonexistent branches without affecting multi-branch clinics", () => {
  const one = [{ name: "Petaling Jaya" }];
  assert.equal(followUp.asksForNonexistentBranchChoice("你想了解哪一间分行？", one), true);
  assert.equal(followUp.asksForNonexistentBranchChoice("Which branch would you like?", one), true);
  assert.equal(followUp.asksForNonexistentBranchChoice("Cawangan mana yang sesuai?", one), true);
  assert.equal(followUp.asksForNonexistentBranchChoice("想去哪个门店比较方便？", one), true);
  assert.equal(followUp.asksForNonexistentBranchChoice("你要找哪一间店？", one), true);
  assert.equal(followUp.asksForNonexistentBranchChoice("Which of our locations would you prefer?", one), true);
  assert.equal(followUp.asksForNonexistentBranchChoice("Lokasi yang mana sesuai?", one), true);
  assert.equal(followUp.asksForNonexistentBranchChoice("PJ 分行的地址是什么？", one), false);
  assert.equal(followUp.asksForNonexistentBranchChoice("Would Saturday at PJ work?", one), false);
  assert.equal(followUp.asksForNonexistentBranchChoice("Which branch?", [{ name: "PJ" }, { name: "KL" }]), false);
});
