/**
 * Stores customer media bytes (photos, voice notes) in Cloudflare R2 instead
 * of Postgres. R2 is S3-compatible, so this uses the standard AWS SDK S3
 * client pointed at R2's endpoint — no Cloudflare-specific SDK needed.
 *
 * The bucket is kept PRIVATE. Customer photos/recordings are sensitive, so
 * bytes are only ever fetched server-side by authenticated routes. For the
 * rare case where Meta must fetch an outbound Instagram attachment by URL,
 * a duplicate temporary object is exposed only through a short-lived SigV4
 * presigned GET URL and then deleted automatically.
 */

const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const DEFAULT_META_SHARE_SECONDS = 10 * 60;
const DEFAULT_TEMP_DELETE_DELAY_MS = 12 * 60 * 1000;
const CLIENT_MEDIA_ROOT = "clients";
const MAX_CLIENT_SLUG_LENGTH = 80;
let cachedClient = null;

function getStorageConfig() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY."
    );
  }
  if (!bucket) throw new Error("R2 storage is not configured. Set R2_BUCKET_NAME.");

  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function getClient() {
  if (cachedClient) return cachedClient;

  const { accountId, accessKeyId, secretAccessKey } = getStorageConfig();
  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

function getBucketName() {
  return getStorageConfig().bucket;
}

function extensionForMimeType(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "audio/ogg") return "ogg";
  if (type === "audio/mpeg" || type === "audio/mp3") return "mp3";
  if (type === "audio/mp4" || type === "audio/x-m4a") return "m4a";
  if (type === "audio/aac") return "aac";
  if (type === "audio/amr") return "amr";
  return "bin";
}

function sanitizeClientSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CLIENT_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

function safeObjectSegment(value, fallback = "misc") {
  const segment = String(value == null ? "" : value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return segment || fallback;
}

/**
 * Returns the client namespace used for new media objects. Existing deployments
 * without CLIENT_SLUG deliberately stay in legacy mode so an environment
 * upgrade cannot suddenly make media uploads fail. Setup Status surfaces that
 * fallback so production clients can be brought onto the isolated namespace.
 */
function getMediaIsolationStatus(env = process.env) {
  const configuredSlug = String(env?.CLIENT_SLUG || "").trim();
  const clientSlug = sanitizeClientSlug(configuredSlug);
  if (!clientSlug) {
    return {
      mode: "legacy",
      clientSlug: null,
      prefix: null,
      reason: configuredSlug ? "invalid_client_slug" : "client_slug_missing",
    };
  }
  return {
    mode: "isolated",
    clientSlug,
    prefix: `${CLIENT_MEDIA_ROOT}/${clientSlug}`,
    reason: null,
  };
}

function applyClientNamespace(relativeKey, env = process.env) {
  const isolation = getMediaIsolationStatus(env);
  return isolation.prefix ? `${isolation.prefix}/${relativeKey}` : relativeKey;
}

/**
 * Pure key builder used by both permanent and temporary media writes. `now`
 * and `id` are injectable for deterministic tests only.
 */
function buildMediaObjectKey({
  kind = "messages",
  contactId = "misc",
  mimeType,
  now = Date.now(),
  id = crypto.randomUUID(),
  env = process.env,
} = {}) {
  const safeKind = kind === "meta-outbound" ? "meta-outbound" : "messages";
  const safeContactId = safeObjectSegment(contactId);
  const safeTimestamp = Number.isFinite(Number(now)) ? Math.max(0, Math.floor(Number(now))) : Date.now();
  const safeId = safeObjectSegment(id, crypto.randomUUID());
  const relativeKey = `${safeKind}/${safeContactId}/${safeTimestamp}-${safeId}.${extensionForMimeType(mimeType)}`;
  return applyClientNamespace(relativeKey, env);
}

function encodeAwsComponent(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeObjectPath(value) {
  return String(value).split("/").map(encodeAwsComponent).join("/");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Creates an R2 SigV4 presigned GET URL without making the bucket public.
 * This mirrors the standard S3 presign algorithm and uses R2's required
 * `auto` region. `now` is injectable only so the signature has a stable unit
 * test; production callers omit it.
 */
function createPresignedGetUrl(
  key,
  { expiresSeconds = DEFAULT_META_SHARE_SECONDS, now = new Date() } = {}
) {
  const { accountId, accessKeyId, secretAccessKey, bucket } = getStorageConfig();
  const expires = Math.max(1, Math.min(604800, Math.floor(Number(expiresSeconds) || 1)));
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeAwsComponent(bucket)}/${encodeObjectPath(key)}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.entries(params)
    .map(([name, value]) => [encodeAwsComponent(name), encodeAwsComponent(value)])
    .sort(([aName, aValue], [bName, bValue]) =>
      aName === bName ? aValue.localeCompare(bValue) : aName.localeCompare(bName)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function putObject(key, buffer, mimeType) {
  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: buffer,
      ContentType: mimeType || "application/octet-stream",
    })
  );
}

/**
 * Uploads a media buffer to R2 and returns the object key to persist in
 * Postgres. New keys are namespaced by CLIENT_SLUG and then by contact. Legacy
 * deployments without CLIENT_SLUG continue writing the historical key shape.
 */
async function uploadMedia(
  buffer,
  mimeType,
  { contactId = "misc", env = process.env } = {}
) {
  const key = buildMediaObjectKey({
    kind: "messages",
    contactId,
    mimeType,
    env,
  });
  await putObject(key, buffer, mimeType);
  return key;
}

/**
 * Creates a second, disposable copy for Meta to fetch. We intentionally do
 * not make the permanent customer-media object public or expose its key. The
 * temporary URL expires after a few minutes and the object is removed shortly
 * afterwards. Failed retries simply create a fresh short-lived copy.
 */
async function uploadTemporaryMedia(
  buffer,
  mimeType,
  {
    contactId = "misc",
    expiresSeconds = DEFAULT_META_SHARE_SECONDS,
    env = process.env,
  } = {}
) {
  const key = buildMediaObjectKey({
    kind: "meta-outbound",
    contactId,
    mimeType,
    env,
  });
  await putObject(key, buffer, mimeType);
  return {
    key,
    url: createPresignedGetUrl(key, { expiresSeconds }),
    expiresSeconds,
  };
}

function scheduleTemporaryMediaDelete(key, delayMs = DEFAULT_TEMP_DELETE_DELAY_MS) {
  if (!key) return null;
  const timer = setTimeout(() => {
    deleteMedia(key).catch((err) => {
      console.error(`Failed to delete temporary Meta media ${key}:`, err);
    });
  }, delayMs);
  timer.unref?.();
  return timer;
}

/**
 * Opens an R2 object as a Node readable stream. When a single HTTP byte range
 * is supplied, that range is forwarded directly to R2 so voice playback and
 * seeking transfer only the requested bytes instead of downloading the whole
 * recording into application memory.
 *
 * The supplied key is used exactly as stored. This is what keeps pre-#128
 * unprefixed database keys fully backward-compatible.
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

/** Deletes a media object from R2. Stored legacy keys are accepted unchanged. */
async function deleteMedia(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }));
}

module.exports = {
  CLIENT_MEDIA_ROOT,
  applyClientNamespace,
  buildMediaObjectKey,
  sanitizeClientSlug,
  getMediaIsolationStatus,
  uploadMedia,
  uploadTemporaryMedia,
  createPresignedGetUrl,
  scheduleTemporaryMediaDelete,
  openMediaStream,
  downloadMedia,
  isRangeNotSatisfiableError,
  deleteMedia,
};
