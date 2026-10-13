// Suppress replays of the exact R2 video across staff, regular FU and extended
// WhatsApp template sends. Accepted, pending and uncertain sends count as used.
async function previouslySentVideo({
  database, contactId, mediaKey, excludeMessageId = null,
} = {}) {
  if (!database || !Number.isSafeInteger(Number(contactId)) ||
      Number(contactId) < 1 || !String(mediaKey || "").trim()) return false;
  const result = await database.query(
    `SELECT 1 FROM messages
     WHERE contact_id = $1
       AND role = 'assistant'
       AND media_key = $2
       AND created_at >= now() - interval '7 days'
       AND delivery_status IS DISTINCT FROM 'failed'
       AND delivery_status IS DISTINCT FROM 'cancelled'
       AND ($3::integer IS NULL OR id <> $3::integer)
     LIMIT 1`,
    [Number(contactId), String(mediaKey).trim(), excludeMessageId]
  );
  return result.rows.length > 0;
}


function textOnlyVideoFallback({ language = "zh", serviceName = "", stepIndex = 1 } = {}) {
  const face = /(?:3D|9D|小颜|逆龄|face|facial)/iu.test(String(serviceName || ""));
  const translations = stepIndex === 2
    ? {
        zh: face
          ? "Hi～每个人的脸型和紧致需求都不一样，我们会根据实际情况了解适合怎样护理 😊 你最在意哪方面呢？"
          : "Hi～每个人的体态和调理体验都会有差异，我们会先了解你的实际情况再建议合适的方向 😊",
        en: face
          ? "Hi~ Everyone's facial concerns are different, so we'll look at what suits you personally 😊 Which area matters most to you?"
          : "Hi~ Everyone's posture and treatment experience can differ. We can look at your specific needs first 😊",
        ms: face
          ? "Hai~ Keperluan wajah setiap orang berbeza, jadi kami akan lihat apa yang sesuai untuk anda 😊"
          : "Hai~ Keadaan postur dan pengalaman setiap orang berbeza. Kami boleh fahami keadaan anda dulu 😊",
      }
    : {
        zh: face
          ? "Hi～脸型轮廓、左右不对称或松弛这些问题，可以先了解你的实际情况再看适合什么护理哦 😊"
          : "Hi～如果你比较在意小腹凸、腰臀紧绷或体态问题，中医师会先了解你的情况，再看适合怎样调理 😊",
        en: face
          ? "Hi~ For facial contour or firmness concerns, we can first understand your goals before suggesting a suitable treatment 😊"
          : "Hi~ For lower-back tightness or posture concerns, our TCM physician can first understand your situation 😊",
        ms: face
          ? "Hai~ Untuk masalah kontur atau ketegangan wajah, kami boleh fahami keperluan anda dulu 😊"
          : "Hai~ Untuk masalah pinggang atau postur, tabib TCM kami akan fahami keadaan anda dulu 😊",
      };
  return translations[language] || translations.zh;
}

module.exports = { previouslySentVideo, textOnlyVideoFallback };
