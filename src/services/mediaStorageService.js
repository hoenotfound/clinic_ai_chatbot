/**
 * Stores patient media bytes (photos, voice notes) in Cloudflare R2 instead
 * of Postgres. R2 is S3-compatible, so this uses the standard AWS SDK S3
 * client pointed at R2's endpoint — no Cloudflare-specific SDK needed.
 *
 * The bucket is kept PRIVATE. Patient photos/recordings are sensitive, so
 * bytes are only ever fetched server-side (via getMediaBuffer) by routes
 * that already enforce staff authentication — never exposed as a public
 * URL. This mirrors the access model the app already had when bytes lived
 * in Postgres (see routes/conversations.js media route).
 */

const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY."
    );
  }

  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

function getBucketName() {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2 storage is not configured. Set R2_BUCKET_NAME.");
  return bucket;
}

function extensionForMimeType(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "audio/ogg") return "ogg";
  if (type === "audio/mpeg" || type === "audio/mp3") return "mp3";
  if (type === "audio/amr") return "amr";
  return "bin";
}

/**
 * Uploads a media buffer to R2 and returns the object key to persist in
 * Postgres. Keys are namespaced by contact so a bucket listing stays
 * organized and a contact's media can be found/deleted together later.
 */
async function uploadMedia(buffer, mimeType, { contactId = "misc" } = {}) {
  const key = `messages/${contactId}/${Date.now()}-${crypto.randomUUID()}.${extensionForMimeType(mimeType)}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: buffer,
      ContentType: mimeType || "application/octet-stream",
    })
  );

  return key;
}

/** Downloads a media object from R2 and returns it as a Buffer. */
async function downloadMedia(key) {
  const result = await getClient().send(
    new GetObjectCommand({ Bucket: getBucketName(), Key: key })
  );
  const chunks = [];
  for await (const chunk of result.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Deletes a media object from R2 (e.g. once a migrated row is verified). */
async function deleteMedia(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }));
}

module.exports = {
  uploadMedia,
  downloadMedia,
  deleteMedia,
};
