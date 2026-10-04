const { pool } = require("./db");

const IMAGE_PURPOSES = Object.freeze({
  PUBLIC_CONFIG: "public_config",
  RESULT_MEDIA: "result_media",
});

function normalizePurpose(value) {
  return value === IMAGE_PURPOSES.RESULT_MEDIA
    ? IMAGE_PURPOSES.RESULT_MEDIA
    : IMAGE_PURPOSES.PUBLIC_CONFIG;
}

/**
 * Stores a Settings-managed image. Marketing/follow-up graphics retain the
 * historical public_config purpose. Before/After result media is tagged
 * result_media immediately at upload time so the public legacy route can
 * never serve it, even before the Settings form is saved.
 */
async function saveImage(
  mimeType,
  base64Data,
  { purpose = IMAGE_PURPOSES.PUBLIC_CONFIG } = {}
) {
  const normalizedPurpose = normalizePurpose(purpose);
  const result = await pool.query(
    "INSERT INTO promo_images (mime_type, data, purpose) VALUES ($1, $2, $3) RETURNING id",
    [mimeType, base64Data, normalizedPurpose]
  );
  return result.rows[0].id;
}

/** Returns one stored Settings image, including its privacy purpose. */
async function getImage(id) {
  const result = await pool.query(
    "SELECT mime_type, data, purpose FROM promo_images WHERE id = $1",
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Public legacy image route access is deliberately restricted to ordinary
 * marketing/follow-up graphics. Result media is never returned here.
 */
async function getPublicImage(id) {
  const result = await pool.query(
    `SELECT mime_type, data, purpose
     FROM promo_images
     WHERE id = $1
       AND purpose = $2`,
    [id, IMAGE_PURPOSES.PUBLIC_CONFIG]
  );
  return result.rows[0] || null;
}

async function markResultMedia(ids, queryable = pool) {
  const safeIds = [...new Set((ids || [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!safeIds.length) return [];
  const result = await queryable.query(
    `UPDATE promo_images
     SET purpose = $2
     WHERE id = ANY($1::int[])
       AND purpose IS DISTINCT FROM $2
     RETURNING id`,
    [safeIds, IMAGE_PURPOSES.RESULT_MEDIA]
  );
  return result.rows.map((row) => row.id);
}

/** Idempotently deletes one uploaded Settings image. */
async function deleteImage(id) {
  await pool.query("DELETE FROM promo_images WHERE id = $1", [id]);
}

/**
 * Deletes old unreferenced Settings images. Message references cover both the
 * historical /promo-images/:id URLs and the authenticated result-media preview
 * URLs so Inbox history and retry metadata remain intact.
 */
async function pruneUnreferenced(referencedIds, olderThanMinutes = 60) {
  const result = await pool.query(
    `DELETE FROM promo_images
     WHERE created_at < now() - ($2 || ' minutes')::interval
       AND NOT (id = ANY($1::int[]))
       AND NOT EXISTS (
         SELECT 1
         FROM messages
         WHERE media_url IS NOT NULL
           AND (
             split_part(split_part(media_url, '?', 1), '#', 1)
               LIKE '%/promo-images/' || promo_images.id::text
             OR split_part(split_part(media_url, '?', 1), '#', 1)
               LIKE '%/api/config/result-media/image/' || promo_images.id::text
           )
       )
     RETURNING id`,
    [referencedIds, olderThanMinutes]
  );
  return result.rows.map((row) => row.id);
}

module.exports = {
  IMAGE_PURPOSES,
  deleteImage,
  getImage,
  getPublicImage,
  markResultMedia,
  pruneUnreferenced,
  saveImage,
};
