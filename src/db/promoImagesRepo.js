const { pool } = require("./db");

/**
 * Stores an uploaded promo graphic's raw bytes in Postgres (base64) and
 * returns its row id — used to build a public URL (see GET
 * /promo-images/:id in server.js) that WhatsApp's Cloud API can fetch when
 * sending a promotion image message by link (see services/whatsappService.js
 * sendImage(), which needs a real hosted URL, not a data URI or file upload).
 */
async function saveImage(mimeType, base64Data) {
  const result = await pool.query("INSERT INTO promo_images (mime_type, data) VALUES ($1, $2) RETURNING id", [
    mimeType,
    base64Data,
  ]);
  return result.rows[0].id;
}

/** Returns { mime_type, data } for one uploaded promo image, or null if it doesn't exist. */
async function getImage(id) {
  const result = await pool.query("SELECT mime_type, data FROM promo_images WHERE id = $1", [id]);
  return result.rows[0] || null;
}

/**
 * Deletes one uploaded promo image by id. Called whenever a promo image is
 * replaced or removed from Settings > Promotions (see routes/config.js
 * DELETE /promotions/image/:id) so old rows don't pile up in Postgres.
 * Idempotent — deleting an id that's already gone (or never existed) is not
 * an error, it just affects zero rows.
 */
async function deleteImage(id) {
  await pool.query("DELETE FROM promo_images WHERE id = $1", [id]);
}

/**
 * Safety net for the case the explicit deleteImage() calls above can't
 * catch: staff upload a promo image (which writes a row immediately — see
 * saveImage() above) and then close the tab, switch away, or their browser
 * crashes before they hit Save on the Promotions tab. Nothing ever
 * references that row, and no client-side event fires to clean it up.
 *
 * Called from configRepo.js after every successful config save, and on a
 * timer from server.js, to delete any promo_images row that isn't
 * referenced by `referencedIds` (the ids currently used in
 * config.promotions[].imageUrl) — but only once it's older than
 * `olderThanMinutes`, so an image uploaded seconds ago while staff are
 * still filling out the rest of the form is never at risk of being swept
 * out from under them before they get a chance to save.
 */
async function pruneUnreferenced(referencedIds, olderThanMinutes = 60) {
  const result = await pool.query(
    `DELETE FROM promo_images
     WHERE created_at < now() - ($2 || ' minutes')::interval
       AND NOT (id = ANY($1::int[]))
     RETURNING id`,
    [referencedIds, olderThanMinutes]
  );
  return result.rows.map((r) => r.id);
}

module.exports = { saveImage, getImage, deleteImage, pruneUnreferenced };
