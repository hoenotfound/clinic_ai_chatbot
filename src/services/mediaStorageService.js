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
const { jpegFrameEncoding } = require("../utils/jpegEncoding");
const {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const DEFAULT_META_SHARE_SECONDS = 10 * 60;
const DEFAULT_TEMP_DELETE_DELAY_MS = 12 * 60 * 1000;
const DEFAULT_STALE_TEMP_MEDIA_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_R2_REQUEST_TIMEOUT_MS = 10 * 1000;
const CLIENT_MEDIA_ROOT = "clients";
const MAX_CLIENT_SLUG_LENGTH = 80;
let cachedClient = null;

function isStorageConfigured(env = process.env) {
  return Boolean(
    env.R2_ACCOUNT_ID &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_BUCKET_NAME
  );
}

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

function r2RequestTimeoutMs(env = process.env) {
  const parsed = Number(env?.R2_REQUEST_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_R2_REQUEST_TIMEOUT_MS;
}

async function sendR2(command, { timeoutMs = r2RequestTimeoutMs() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await getClient().send(command, { abortSignal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(
        `R2 request timed out after ${timeoutMs}ms.`
      );
      timeoutError.name = "R2RequestTimeoutError";
      timeoutError.code = "R2_REQUEST_TIMEOUT";
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isR2RequestTimeoutError(err) {
  return err?.code === "R2_REQUEST_TIMEOUT";
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
  if (type === "video/mp4") return "mp4";
  if (type === "video/3gpp") return "3gp";
  if (type === "video/quicktime") return "mov";
  if (type === "video/webm") return "webm";
  if (type === "application/pdf") return "pdf";
  if (type === "application/msword") return "doc";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (type === "application/vnd.ms-excel") return "xls";
  if (type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (type === "application/vnd.ms-powerpoint") return "ppt";
  if (type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (type === "text/plain") return "txt";
  if (type === "text/csv") return "csv";
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
  if (!segment || segment === "." || segment === "..") return fallback;
  return segment;
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
  if (isolation.reason === "invalid_client_slug") {
    const error = new Error(
      "CLIENT_SLUG is configured but does not produce a valid client media namespace."
    );
    error.code = "INVALID_CLIENT_MEDIA_SLUG";
    throw error;
  }
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
  await sendR2(
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
    id: `${crypto.randomUUID()}${jpegFrameEncoding(buffer) === "non-progressive" ? "-baseline" : ""}`,
  });
  try {
    await putObject(key, buffer, mimeType);
    return key;
  } catch (err) {
    if (isR2RequestTimeoutError(err)) {
      // The client aborted before it learned whether R2 committed the write.
      // Best-effort deletion prevents an untracked permanent customer-media
      // object if the server finished just before the response was lost.
      deleteMedia(key).catch((cleanupErr) => {
        console.error(
          `Failed to clean up timed-out R2 media write ${key}:`,
          cleanupErr
        );
      });
    }
    throw err;
  }
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

/**
 * Creates a disposable Meta-facing copy of an already persisted private media
 * object entirely inside R2. This avoids sending the same bytes over the
 * Render->R2 link twice while also keeping the permanent customer-media key
 * out of third-party URLs/logs.
 */
async function copyStoredMediaToMessage(
  sourceKey,
  mimeType,
  {
    contactId = "misc",
    env = process.env,
  } = {}
) {
  if (!sourceKey) throw new Error("Stored media key is required.");

  const bucket = getBucketName();
  const key = buildMediaObjectKey({
    kind: "messages",
    contactId,
    mimeType,
    env,
    id: `${crypto.randomUUID()}${/-baseline\.jpg$/.test(sourceKey) ? "-baseline" : ""}`,
  });

  try {
    await sendR2(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: `${bucket}/${sourceKey}`,
        MetadataDirective: "REPLACE",
        ContentType: mimeType || "application/octet-stream",
      })
    );
    return key;
  } catch (err) {
    if (isR2RequestTimeoutError(err)) {
      deleteMedia(key).catch((cleanupErr) => {
        console.error(
          `Failed to clean up timed-out R2 media copy ${key}:`,
          cleanupErr
        );
      });
    }
    throw err;
  }
}

async function copyStoredMediaToTemporary(
  sourceKey,
  mimeType,
  {
    contactId = "misc",
    expiresSeconds = DEFAULT_META_SHARE_SECONDS,
    env = process.env,
  } = {}
) {
  if (!sourceKey) throw new Error("Stored media key is required.");

  const bucket = getBucketName();
  const key = buildMediaObjectKey({
    kind: "meta-outbound",
    contactId,
    mimeType,
    env,
  });

  await sendR2(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: `${bucket}/${sourceKey}`,
      MetadataDirective: "REPLACE",
      ContentType: mimeType || "application/octet-stream",
    })
  );

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

function temporaryMediaPrefix(env = process.env) {
  return applyClientNamespace("meta-outbound/", env);
}

function followUpConfigVideoPrefix(env = process.env) {
  return applyClientNamespace("messages/follow-up-config/", env);
}

function customerMediaPrefixes(contactId, env = process.env) {
  if (!isStorageConfigured(env)) return [];
  const isolation = getMediaIsolationStatus(env);
  if (!isolation.prefix) return [];
  const segment = safeObjectSegment(contactId);
  return [
    `${isolation.prefix}/messages/${segment}/`,
    `${isolation.prefix}/meta-outbound/${segment}/`,
  ];
}

function isOwnedCustomerMediaPrefix(prefix, env = process.env) {
  const isolation = getMediaIsolationStatus(env);
  if (!isolation.prefix) return false;
  const normalized = String(prefix || "");
  return (
    normalized.startsWith(`${isolation.prefix}/messages/`) ||
    normalized.startsWith(`${isolation.prefix}/meta-outbound/`)
  );
}

async function deleteMediaPrefix(prefix, { env = process.env } = {}) {
  if (!isOwnedCustomerMediaPrefix(prefix, env)) {
    const err = new Error(
      "Refusing to delete a customer-media prefix outside this client namespace."
    );
    err.code = "CUSTOMER_MEDIA_PREFIX_NOT_OWNED";
    throw err;
  }

  const bucket = getBucketName();
  const keys = [];
  let continuationToken;

  do {
    const page = await sendR2(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    keys.push(
      ...(page.Contents || [])
        .map((object) => object?.Key)
        .filter(Boolean)
    );
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  let deleted = 0;
  for (let offset = 0; offset < keys.length; offset += 500) {
    const batch = keys.slice(offset, offset + 500);
    const result = await sendR2(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: batch.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));
    const failures = (result.Errors || []).filter((item) => item?.Key);
    if (failures.length > 0) {
      const err = new Error(
        `Failed to delete ${failures.length} customer media object(s) from R2.`
      );
      err.code = "CUSTOMER_MEDIA_DELETE_PARTIAL";
      err.failedKeys = failures.map((item) => item.Key);
      throw err;
    }
    deleted += batch.length;
  }

  return deleted;
}

/**
 * Exact stored keys come from this client's own database. Namespaced keys must
 * still belong to this client; legacy permanent keys retain the historical
 * messages/<contact>/... shape so old clients remain deletable after enabling
 * CLIENT_SLUG.
 */
function isOwnedStoredMediaKey(key, env = process.env) {
  const normalized = String(key || "").trim();
  if (!normalized) return false;

  const isolation = getMediaIsolationStatus(env);
  if (normalized.startsWith(`${CLIENT_MEDIA_ROOT}/`)) {
    return Boolean(
      isolation.prefix &&
      normalized.startsWith(`${isolation.prefix}/`)
    );
  }

  return normalized.startsWith("messages/");
}

/**
 * Deletes all customer media known at purge time. Exact keys are deleted first.
 * Namespaced prefix cleanup then catches temporary/unreferenced objects. Legacy
 * shared-bucket deployments deliberately skip prefix deletion because ownership
 * of a bare messages/<contact>/ prefix cannot be proven across clients.
 */
async function deleteCustomerMediaObjects({
  mediaKeys = [],
  mediaPrefixes = [],
  env = process.env,
} = {}) {
  const keys = [...new Set(
    (Array.isArray(mediaKeys) ? mediaKeys : [])
      .map((key) => String(key || "").trim())
      .filter(Boolean)
  )];
  const prefixes = [...new Set(
    (Array.isArray(mediaPrefixes) ? mediaPrefixes : [])
      .map((prefix) => String(prefix || "").trim())
      .filter(Boolean)
  )];

  let deleted = 0;
  for (const key of keys) {
    if (!isOwnedStoredMediaKey(key, env)) {
      const err = new Error(
        "Refusing to delete a stored media key outside this client's media namespace."
      );
      err.code = "CUSTOMER_MEDIA_KEY_NOT_OWNED";
      throw err;
    }
    await deleteMedia(key);
    deleted += 1;
  }
  for (const prefix of prefixes) {
    deleted += await deleteMediaPrefix(prefix, { env });
  }
  return deleted;
}

function isStaleTemporaryObject(object, {
  now = Date.now(),
  olderThanMs = DEFAULT_STALE_TEMP_MEDIA_AGE_MS,
} = {}) {
  const modifiedAt = object?.LastModified ? new Date(object.LastModified).getTime() : NaN;
  return Boolean(
    object?.Key &&
    Number.isFinite(modifiedAt) &&
    modifiedAt <= Number(now) - Math.max(0, Number(olderThanMs) || 0)
  );
}

/**
 * Durable backstop for temporary Meta attachments. The normal delete timer is
 * fast but disappears on a process restart; this sweep removes objects that
 * survived a restart or a transient delete failure.
 */
async function pruneStaleTemporaryMedia({
  olderThanMs = DEFAULT_STALE_TEMP_MEDIA_AGE_MS,
  now = Date.now(),
  env = process.env,
} = {}) {
  const isolation = getMediaIsolationStatus(env);
  // A legacy unprefixed deployment cannot prove that meta-outbound/ belongs
  // exclusively to this client when buckets are shared. Fail closed instead
  // of risking deletion of another client's temporary objects.
  if (!isolation.prefix) return 0;

  const prefix = temporaryMediaPrefix(env);
  const bucket = getBucketName();
  let continuationToken = undefined;
  let deleted = 0;

  do {
    const page = await sendR2(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const staleKeys = (page.Contents || [])
      .filter((object) => isStaleTemporaryObject(object, { now, olderThanMs }))
      .map((object) => object.Key)
      .filter(Boolean);

    // R2 implements S3 DeleteObjects. Batch cleanup avoids hundreds of
    // sequential delete requests competing with live customer media traffic.
    for (let offset = 0; offset < staleKeys.length; offset += 500) {
      const batch = staleKeys.slice(offset, offset + 500);
      const result = await sendR2(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }));
      const failedKeys = new Set(
        (result.Errors || []).map((item) => item?.Key).filter(Boolean)
      );
      deleted += batch.filter((key) => !failedKeys.has(key)).length;

      if (failedKeys.size) {
        console.warn(
          `R2 temporary-media batch cleanup failed for ${failedKeys.size} object(s).`
        );
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
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

  const result = await sendR2(new GetObjectCommand(input));
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
async function downloadMedia(key, { timeoutMs = r2RequestTimeoutMs(), maxBytes = 32 * 1024 * 1024, range = null } = {}) {
  let body;
  let timer;
  let expired = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const error = new Error(`R2 download timed out after ${timeoutMs}ms.`);
      error.name = "R2RequestTimeoutError";
      error.code = "R2_REQUEST_TIMEOUT";
      body?.destroy(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const media = await openMediaStream(key, { range });
        body = media.body;
        if (expired) {
          body.destroy();
          return null;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of body) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            throw new Error("Stored media exceeds the download size limit.");
          }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    if (body && !body.readableEnded) body.destroy();
  }
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
  await sendR2(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }));
}

async function pruneStaleFollowUpConfigVideos({
  referencedKeys = [],
  olderThanMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
  env = process.env,
} = {}) {
  if (!isStorageConfigured(env)) return 0;
  const isolation = getMediaIsolationStatus(env);
  // Legacy shared-bucket mode cannot prove ownership of this settings prefix.
  // Do not perform broad cleanup there; explicit configured-key deletion still
  // remains safe through isOwnedStoredMediaKey().
  if (!isolation.prefix) return 0;

  const keep = new Set(
    (Array.isArray(referencedKeys) ? referencedKeys : [])
      .map((key) => String(key || "").trim())
      .filter(Boolean)
  );
  const prefix = followUpConfigVideoPrefix(env);
  const bucket = getBucketName();
  let continuationToken;
  let deleted = 0;

  do {
    const page = await sendR2(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const staleKeys = (page.Contents || [])
      .filter((object) => isStaleTemporaryObject(object, { now, olderThanMs }))
      .map((object) => object?.Key)
      .filter((key) => key && !keep.has(key));

    for (let offset = 0; offset < staleKeys.length; offset += 500) {
      const batch = staleKeys.slice(offset, offset + 500);
      const result = await sendR2(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }));
      const failed = new Set(
        (result.Errors || []).map((item) => item?.Key).filter(Boolean)
      );
      deleted += batch.filter((key) => !failed.has(key)).length;
      if (failed.size) {
        console.warn(
          `R2 follow-up-video cleanup failed for ${failed.size} object(s).`
        );
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}


module.exports = {
  CLIENT_MEDIA_ROOT,
  DEFAULT_R2_REQUEST_TIMEOUT_MS,
  applyClientNamespace,
  buildMediaObjectKey,
  sanitizeClientSlug,
  getMediaIsolationStatus,
  isStorageConfigured,
  r2RequestTimeoutMs,
  sendR2,
  isR2RequestTimeoutError,
  uploadMedia,
  uploadTemporaryMedia,
  copyStoredMediaToMessage,
  copyStoredMediaToTemporary,
  createPresignedGetUrl,
  scheduleTemporaryMediaDelete,
  temporaryMediaPrefix,
  followUpConfigVideoPrefix,
  customerMediaPrefixes,
  deleteCustomerMediaObjects,
  deleteMediaPrefix,
  isOwnedCustomerMediaPrefix,
  isOwnedStoredMediaKey,
  isStaleTemporaryObject,
  pruneStaleTemporaryMedia,
  pruneStaleFollowUpConfigVideos,
  openMediaStream,
  downloadMedia,
  isRangeNotSatisfiableError,
  deleteMedia,
};