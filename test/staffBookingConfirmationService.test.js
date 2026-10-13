const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseStaffConfirmedSlot,
  createStaffBookingConfirmationService,
} = require("../src/services/staffBookingConfirmationService");

const NOW = new Date("2026-10-13T05:00:00.000Z");

test("only explicit staff-confirmed full calendar appointments are eligible for CRM sync", () => {
  assert.equal(parseStaffConfirmedSlot("您的预约已确认：17/10/2026 下午4点 😊", NOW),
    "2026-10-17T08:00:00.000Z");
  assert.equal(parseStaffConfirmedSlot("Appointment confirmed: 2026-10-17 at 4:30pm", NOW),
    "2026-10-17T08:30:00.000Z");
  assert.equal(parseStaffConfirmedSlot("预约已确认 17/10/2026 16:00", NOW),
    "2026-10-17T08:00:00.000Z");
  for (const message of [
    "星期六，4点的时间你方便吗？",
    "预约已确认 星期六 下午4点",
    "Your appointment is not confirmed: 17/10/2026 4:00pm",
    "待确认 17/10/2026 4:00pm 预约",
    "预约已确认 31/02/2027 4:00pm",
    "预约已确认 17/10/2026 4点",
    "预约已确认 17/10/2026 4:00",
  ]) {
    assert.equal(parseStaffConfirmedSlot(message, NOW), null, message);
  }
});

test("provider-accepted explicit staff confirmation sets the CRM booked date and status", async () => {
  const calls = [];
  const service = createStaffBookingConfirmationService({
    config: { businessType: "tcm_clinic" },
    now: () => NOW,
    pipeline: {
      getActiveLeadForContact: async (contactId) => {
        calls.push(["lookup", contactId]);
        return { id: 77, appointment_status: "none", is_closed: false };
      },
      updateLead: async (id, patch, actor) => {
        calls.push(["update", id, patch, actor]);
        return { id, ...patch };
      },
    },
  });
  const result = await service(372, "您的预约已确认：17/10/2026 下午4点", { providerAccepted: true });
  assert.equal(result.appointmentStatus, "set");
  assert.deepEqual(calls, [
    ["lookup", 372],
    ["update", 77, { appointmentStatus: "set", appointmentAt: "2026-10-17T08:00:00.000Z" }, "Staff chat confirmation"],
  ]);
});

test("failed or ambiguous sends cannot change booking records", async () => {
  const calls = [];
  const service = createStaffBookingConfirmationService({
    config: { businessType: "tcm_clinic" }, now: () => NOW,
    pipeline: {
      getActiveLeadForContact: async () => { calls.push("lookup"); return null; },
      updateLead: async () => { throw new Error("must not update"); },
    },
  });
  assert.equal(await service(372, "您的预约已确认：17/10/2026 下午4点", { providerAccepted: false }), null);
  assert.equal(await service(372, "星期六4点方便吗?", { providerAccepted: true }), null);
  assert.deepEqual(calls, []);
});

test("closed, visited or cancelled lead is not reopened by a staff message", async () => {
  for (const appointment_status of ["visited", "cancelled"]) {
    const service = createStaffBookingConfirmationService({
      config: { businessType: "tcm_clinic" }, now: () => NOW,
      pipeline: {
        getActiveLeadForContact: async () => ({ id: 5, is_closed: false, appointment_status }),
        updateLead: async () => { throw new Error("must not update"); },
      },
    });
    assert.equal(await service(5, "预约已确认 17/10/2026 下午4点", { providerAccepted: true }), null);
  }
});
