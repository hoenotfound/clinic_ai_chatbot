/**
 * Stores patient media bytes (photos, voice notes) in Cloudflare R2 instead
 * of Postgres. R2 is S3-compatible, so this uses the standard AWS SDK S3
 * client pointed at R2's endpoint — no Cloudflare-specific SDK needed.
 *
 * The bucket is kept PRIVATE. Patient photos/recordings are sensitive, so
 * bytes are only ever fetched server-side by authenticated routes. Browser
 * playback is streamed through the backend instead of exposing a public R2
 * URL or buffering an entire object in memory first.
 */

const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

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

/**
 * Opens an R2 object as a Node readable stream. When a single HTTP byte range
 * is supplied, that range is forwarded directly to R2 so voice playback and
 * seeking transfer only the requested bytes instead of downloading the whole
 * recording into application memory.
 */
async function openMediaStream(key, { range = null } = {}) {
  const input = {
    Bucket: getBucketName(),
    Key: key,
  };
  if (range) input.Range = range;

  const result = await getClient().send(new GetObjectCommand(input));
  if (!result.Body || typeof result.Body.pipe !== "function") {
    throw new Error("R2 returned a media object without a readable body.");
  }

  return {
    body: result.Body,
    contentLength:
      Number.isFinite(result.ContentLength) && result.ContentLength >= 0
        ? result.ContentLength
        : null,
    contentRange: result.ContentRange || null,
    contentType: result.ContentType || null,
    acceptRanges: result.AcceptRanges || "bytes",
    etag: result.ETag || null,
    lastModified: result.LastModified || null,
  };
}

/** Downloads a media object fully. Keep this for AI image context and retries. */
async function downloadMedia(key) {
  const media = await openMediaStream(key);
  const chunks = [];
  for await (const chunk of media.body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isRangeNotSatisfiableError(err) {
  return (
    err?.$metadata?.httpStatusCode === 416 ||
    err?.name === "InvalidRange" ||
    err?.Code === "InvalidRange" ||
    err?.code === "InvalidRange"
  );
}

/** Deletes a media object from R2. */
async function deleteMedia(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }));
}

module.exports = {
  uploadMedia,
  openMediaStream,
  downloadMedia,
  isRangeNotSatisfiableError,
  deleteMedia,
};
