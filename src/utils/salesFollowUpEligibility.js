const INACTIVITY_HOURS = 48;
const FOLLOW_UP_OUTCOMES = new Set(["contacted", "later", "booked", "not_interested", "unable"]);

function pendingSalesFollowUp(row, now = new Date()) {
  if (!row || row.is_closed || row.stage_type !== "open" ||
    ["appointment_set", "visited"].includes(row.system_key) ||
    ["set", "visited"].includes(row.appointment_status) ||
    !["hot", "warm"].includes(row.temperature) ||
    row.channel !== "whatsapp" || !/^\d{8,15}$/.test(row.whatsapp_number || "") ||
    (!row.whatsapp_opt_in_at || !String(row.whatsapp_opt_in_source || "").trim()) || row.whatsapp_opt_out_at ||
    row.whatsapp_marketing_opt_out_at ||
    !String(row.treatment_interest || row.summary_treatment || "").trim() ||
    row.mode === "human" || !row.last_inbound_at ||
    row.staff_replied_after_inbound || row.active_extended_follow_up) return false;

  const time = new Date(now).getTime();
  const inbound = new Date(row.last_inbound_at).getTime();
  if (!Number.isFinite(time) || !Number.isFinite(inbound) ||
    time - inbound < INACTIVITY_HOURS * 60 * 60 * 1000) return false;
  if (row.next_follow_up_at &&
    new Date(row.next_follow_up_at).getTime() > time) return false;

  const newerCustomerTurn = Number(row.last_inbound_id) > Number(row.task_last_inbound_id || 0);
  if (row.task_status === "not_interested") {
    // Prior rejection cannot be overridden by a routine "hi" or an old interest field.
    return newerCustomerTurn && row.new_verified_interest === true;
  }
  if (row.task_status === "booked") {
    // Cancelled/rescheduled bookings can enter the queue again, but only
    // after Pipeline explicitly moved away from the confirmed appointment.
    return ["cancelled", "reschedule"].includes(row.appointment_status) &&
      row.booking_reopened_after_task === true;
  }
  if (row.task_status === "later") {
    return Boolean(row.task_due_at) && new Date(row.task_due_at).getTime() <= time;
  }
  if (row.task_status === "contacted") {
    // Staff can optionally agree an explicit due date for another attempt.
    return newerCustomerTurn || (Boolean(row.task_due_at) &&
      new Date(row.task_due_at).getTime() <= time);
  }
  if (row.task_status === "unable") return newerCustomerTurn;
  return !row.task_status;
}

function assertFollowUpOutcome(status, dueAt, now = new Date()) {
  if (!FOLLOW_UP_OUTCOMES.has(status)) {
    const error = new Error("Choose a valid follow-up outcome."); error.status = 400; throw error;
  }
  if (status !== "later" && status !== "booked" && !(status === "contacted" && dueAt)) return null;
  const date = new Date(dueAt);
  if (!dueAt || !Number.isFinite(date.getTime()) || date.getTime() <= new Date(now).getTime()) {
    const error = new Error(status === "booked" ? "Enter a future confirmed appointment date and time." : "Choose a future follow-up date and time.");
    error.status = 400; throw error;
  }
  return date;
}

module.exports = { INACTIVITY_HOURS, FOLLOW_UP_OUTCOMES, pendingSalesFollowUp, assertFollowUpOutcome };
