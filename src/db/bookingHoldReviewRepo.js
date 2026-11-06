const { pool } = require("./db");
const realtimeEvents = require("../utils/realtimeEvents");

// Only an authorized staff member may release an unconfirmed booking review.
// A confirmed appointment or a reschedule cannot be released this way.
async function resolveBookingReview(leadId, actor, database=pool) {
  const id=Number(leadId);
  if (!Number.isSafeInteger(id) || id<=0 || !String(actor||"").trim()) return null;
  const client=await database.connect();
  let result=null;
  try {
    await client.query("BEGIN");
    const contact=await client.query(
      "SELECT c.id FROM contacts c JOIN leads l ON l.contact_id=c.id WHERE l.id=$1 FOR UPDATE OF c",
      [id]
    );
    if (!contact.rows[0]) { await client.query("COMMIT"); return null; }
    const lead=await client.query(
      "SELECT id,contact_id,appointment_status,is_closed FROM leads WHERE id=$1 FOR UPDATE",
      [id]
    );
    const state=lead.rows[0];
    if (!state || state.is_closed || !["none","cancelled",null].includes(state.appointment_status)) {
      await client.query("COMMIT"); return null;
    }
    const pending=await client.query(
      `SELECT signal.id FROM lead_activities signal
       WHERE signal.lead_id=$1
         AND signal.metadata->>'outcome' IN
           ('staff_time_accepted','staff_visit_acknowledged','booking_intent_pending','booking_ready','staff_appointment_reminder')
         AND NOT EXISTS (SELECT 1 FROM lead_activities resolved
           WHERE resolved.lead_id=$1
             AND resolved.metadata->>'outcome'='booking_hold_resolved'
             AND resolved.id>signal.id)
         AND NOT EXISTS (SELECT 1 FROM lead_activities invalidated
           WHERE invalidated.lead_id=$1
             AND signal.metadata->>'outcome'='staff_appointment_reminder'
             AND invalidated.metadata->>'outcome'='staff_reminder_invalidated'
             AND invalidated.metadata->>'staffMessageId'=signal.metadata->>'staffMessageId'
             AND invalidated.id>signal.id)
       ORDER BY signal.id DESC LIMIT 1`,[id]);
    if (!pending.rows[0]) { await client.query("COMMIT"); return null; }
    const saved=await client.query(
      `INSERT INTO lead_activities(lead_id,activity_type,description,actor,metadata)
       VALUES($1,'updated','Staff reviewed booking: no appointment was confirmed. Pending booking hold released.',$2,
         jsonb_build_object('outcome','booking_hold_resolved','reviewedSignalId',$3::bigint))
       RETURNING id`,[id,String(actor).trim(),pending.rows[0].id]
    );
    await client.query(
      `UPDATE contacts SET needs_attention=false, attention_reason=NULL,updated_at=now()
       WHERE id=$1 AND attention_reason LIKE 'Booking ready:%'`,
      [state.contact_id]
    );
    result={leadId:id,contactId:state.contact_id,activityId:saved.rows[0].id};
    await client.query("COMMIT");
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{client.release();}
  if(result){
    realtimeEvents.publish("pipeline_changed",{leadId:result.leadId});
    realtimeEvents.publish("conversation_changed",{contactId:result.contactId,reason:"booking_review_resolved"});
  }
  return result;
}
module.exports={resolveBookingReview};
