"use strict";

// Use the same narrow result-media safety rule for the primary and secondary
// WhatsApp queues. Ordinary follow-up questions must not invalidate results.
// Only clear opt-outs, sensitive clinical changes and changes of treatment do.
const STOP_REQUEST_PATTERN =
  "(^|[[:space:]])(stop|unsubscribe|opt[ -]?out)([[:space:][:punct:]]|$)|不要再发|停止发送|停止推送|别再发|不要再联系|jangan hantar|jangan mesej";
const CLINICAL_REVIEW_PATTERN =
  "(腹直肌分离|腹直肌分離|严重疼痛|嚴重疼痛|剧烈疼痛|劇烈疼痛|怀孕|懷孕|出血|severe pain|bleeding|pregnant|sakit teruk|hamil)";
const FACE_PATTERN =
  "(3[[:space:]]*d|9[[:space:]]*d|小颜|小顏|逆龄|逆齡|四方脸|四方臉|方脸|方臉|大小脸|大小臉|双下巴|雙下巴|下颌线|下顎線|下頜線|jawline|square face|double chin|facial|face lift|muka petak|dagu berlapis)";
const PELVIC_PATTERN = "(骨盆|盆骨|pelvic|pinggul)";
const PULSE_PATTERN = "(脉冲|脈衝|pulse wave|golden pulse)";
const FACE_3D_PATTERN = "(3[[:space:]]*d|小颜|小顏)";
const FACE_9D_PATTERN = "(9[[:space:]]*d|逆龄|逆齡)";

// The aliases are internal fixed SQL identifiers, never customer input.
// This is a conservative treatment switch check, not treatment inference.
// A symptom or generic pricing question alone does not select new media.
function resultSupersessionSql(originalAlias="inbound", newerAlias="newer"){
  const oldText=`COALESCE(${originalAlias}.content,'')`;
  const newText=`COALESCE(${newerAlias}.content,'')`;
  return `(
    ${newText} ~* '${STOP_REQUEST_PATTERN}'
    OR ${newText} ~* '${CLINICAL_REVIEW_PATTERN}'
    OR ((${oldText} ~* '${PELVIC_PATTERN}' OR ${oldText} ~* '${PULSE_PATTERN}')
      AND ${newText} ~* '${FACE_PATTERN}')
    OR (${oldText} ~* '${FACE_PATTERN}'
      AND (${newText} ~* '${PELVIC_PATTERN}' OR ${newText} ~* '${PULSE_PATTERN}'))
    OR (${oldText} ~* '${PELVIC_PATTERN}' AND ${newText} ~* '${PULSE_PATTERN}')
    OR (${oldText} ~* '${PULSE_PATTERN}' AND ${newText} ~* '${PELVIC_PATTERN}')
    OR (${oldText} ~* '${FACE_3D_PATTERN}' AND ${newText} ~* '${FACE_9D_PATTERN}')
    OR (${oldText} ~* '${FACE_9D_PATTERN}' AND ${newText} ~* '${FACE_3D_PATTERN}')
  )`;
}

module.exports={resultSupersessionSql,STOP_REQUEST_PATTERN,
  CLINICAL_REVIEW_PATTERN,FACE_PATTERN,PELVIC_PATTERN,PULSE_PATTERN};
