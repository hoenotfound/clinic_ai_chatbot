const test = require("node:test");
const assert = require("node:assert/strict");

const { S3Client, CopyObjectCommand } = require("@aws-sdk/client-s3");
const mediaStorage = require("../src/services/mediaStorageService");

test("new permanent media keys are isolated by client slug", () => {
  const common = {
    kind: "messages",
    contactId: 42,
    mimeType: "image/jpeg",
    now: 1789143000000,
    id: "fixed-id",
  };

  const clientA = mediaStorage.buildMediaObjectKey({
    ...common,
    env: { CLIENT_SLUG: "acme-renovation" },
  });
  const clientB = mediaStorage.buildMediaObjectKey({
    ...common,
    env: { CLIENT_SLUG: "beleco-clinic" },
  });

  assert.equal(
    clientA,
    "clients/acme-renovation/messages/42/1789143000000-fixed-id.jpg"
  );
  assert.equal(
    clientB,
    "clients/beleco-clinic/messages/42/1789143000000-fixed-id.jpg"
  );
  assert.notEqual(clientA, clientB);
});

test("temporary Meta media uses the same client namespace", () => {
  const key = mediaStorage.buildMediaObjectKey({
    kind: "meta-outbound",
    contactId: 42,
    mimeType: "audio/ogg",
    now: 1789143000000,
    id: "fixed-id",
    env: { CLIENT_SLUG: "acme-renovation" },
  });

  assert.equal(
    key,
    "clients/acme-renovation/meta-outbound/42/1789143000000-fixed-id.ogg"
  );
});

test("client and contact path components cannot escape the media namespace", () => {
  const key = mediaStorage.buildMediaObjectKey({
    kind: "messages",
    contactId: "../../other/client",
    mimeType: "image/png",
    now: 1,
    id: "../unsafe-id",
    env: { CLIENT_SLUG: "../ACME / West\\.." },
  });

  assert.equal(mediaStorage.sanitizeClientSlug("../ACME / West\\.."), "acme-west");
  assert.equal(
    key,
    "clients/acme-west/messages/..-..-other-client/1-..-unsafe-id.png"
  );
  assert.equal(key.includes("/../"), false);
});

test("exact dot path segments fall back to safe object segments", () => {
  for (const dangerous of [".", ".."]) {
    const contactKey = mediaStorage.buildMediaObjectKey({
      kind: "messages",
      contactId: dangerous,
      mimeType: "image/png",
      now: 1,
      id: "fixed-id",
      env: { CLIENT_SLUG: "acme" },
    });
    assert.equal(
      contactKey,
      "clients/acme/messages/misc/1-fixed-id.png"
    );

    const idKey = mediaStorage.buildMediaObjectKey({
      kind: "messages",
      contactId: "contact",
      mimeType: "image/png",
      now: 1,
      id: dangerous,
      env: { CLIENT_SLUG: "acme" },
    });
    assert.equal(idKey.includes("/./"), false);
    assert.equal(idKey.includes("/../"), false);
    assert.match(idKey, /^clients\/acme\/messages\/contact\/1-[A-Za-z0-9-]+\.png$/);
  }
});

test("missing client slug keeps the historical unprefixed key shape", () => {
  const isolation = mediaStorage.getMediaIsolationStatus({});
  const key = mediaStorage.buildMediaObjectKey({
    kind: "messages",
    contactId: "setup-check",
    mimeType: "application/octet-stream",
    now: 123,
    id: "legacy",
    env: {},
  });

  assert.deepEqual(isolation, {
    mode: "legacy",
    clientSlug: null,
    prefix: null,
    reason: "client_slug_missing",
  });
  assert.equal(key, "messages/setup-check/123-legacy.bin");
  assert.equal(
    mediaStorage.applyClientNamespace("messages/12/existing.jpg", {}),
    "messages/12/existing.jpg"
  );
});

test("stored media is copied server-side into a disposable Meta object", async (t) => {
  const originalSend = S3Client.prototype.send;
  const original = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  };

  t.after(() => {
    S3Client.prototype.send = originalSend;
    if (original.accountId === undefined) delete process.env.R2_ACCOUNT_ID;
    else process.env.R2_ACCOUNT_ID = original.accountId;
    if (original.accessKeyId === undefined) delete process.env.R2_ACCESS_KEY_ID;
    else process.env.R2_ACCESS_KEY_ID = original.accessKeyId;
    if (original.secretAccessKey === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = original.secretAccessKey;
    if (original.bucket === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = original.bucket;
  });

  process.env.R2_ACCOUNT_ID = "copy-test";
  process.env.R2_ACCESS_KEY_ID = "AKIDCOPY";
  process.env.R2_SECRET_ACCESS_KEY = "SECRETCOPY";
  process.env.R2_BUCKET_NAME = "private-media";

  let copyInput = null;
  S3Client.prototype.send = async function send(command) {
    assert.ok(command instanceof CopyObjectCommand);
    copyInput = command.input;
    return {};
  };

  const sourceKey = "clients/acme/messages/42/123-original.jpg";
  const result = await mediaStorage.copyStoredMediaToTemporary(
    sourceKey,
    "image/jpeg",
    {
      contactId: 42,
      expiresSeconds: 600,
      env: { CLIENT_SLUG: "acme" },
    }
  );

  assert.equal(copyInput.Bucket, "private-media");
  assert.equal(copyInput.CopySource, `private-media/${sourceKey}`);
  assert.equal(copyInput.MetadataDirective, "REPLACE");
  assert.equal(copyInput.ContentType, "image/jpeg");
  assert.match(result.key, /^clients\/acme\/meta-outbound\/42\//);
  assert.equal(result.url.includes(sourceKey), false);
  assert.ok(result.url.includes("/private-media/clients/acme/meta-outbound/42/"));
  assert.equal(result.expiresSeconds, 600);
});

test("R2 presigned GET URL matches AWS SigV4 for a fixed request", (t) => {
  const original = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  };
  t.after(() => {
    if (original.accountId === undefined) delete process.env.R2_ACCOUNT_ID;
    else process.env.R2_ACCOUNT_ID = original.accountId;
    if (original.accessKeyId === undefined) delete process.env.R2_ACCESS_KEY_ID;
    else process.env.R2_ACCESS_KEY_ID = original.accessKeyId;
    if (original.secretAccessKey === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = original.secretAccessKey;
    if (original.bucket === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = original.bucket;
  });

  process.env.R2_ACCOUNT_ID = "abc123";
  process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.R2_SECRET_ACCESS_KEY = "SECRETEXAMPLE";
  process.env.R2_BUCKET_NAME = "my-bucket";

  const url = mediaStorage.createPresignedGetUrl(
    "meta-outbound/123/photo a.jpg",
    {
      expiresSeconds: 900,
      now: new Date("2026-09-02T07:30:00.000Z"),
    }
  );

  assert.equal(
    url,
    "https://abc123.r2.cloudflarestorage.com/my-bucket/meta-outbound/123/photo%20a.jpg" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIDEXAMPLE%2F20260902%2Fauto%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20260902T073000Z" +
      "&X-Amz-Expires=900" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=e1b1d9db37df83e46bbd0d6137100b794b46f53c55bed5cc3cb6f51240d2faea"
  );
});

test("R2 presigned GET URL clamps expiry to S3 maximum", (t) => {
  const original = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  };
  t.after(() => {
    if (original.accountId === undefined) delete process.env.R2_ACCOUNT_ID;
    else process.env.R2_ACCOUNT_ID = original.accountId;
    if (original.accessKeyId === undefined) delete process.env.R2_ACCESS_KEY_ID;
    else process.env.R2_ACCESS_KEY_ID = original.accessKeyId;
    if (original.secretAccessKey === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = original.secretAccessKey;
    if (original.bucket === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = original.bucket;
  });

  process.env.R2_ACCOUNT_ID = "abc123";
  process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.R2_SECRET_ACCESS_KEY = "SECRETEXAMPLE";
  process.env.R2_BUCKET_NAME = "my-bucket";

  const url = new URL(
    mediaStorage.createPresignedGetUrl("file.jpg", {
      expiresSeconds: 9999999,
      now: new Date("2026-09-02T07:30:00.000Z"),
    })
  );
  assert.equal(url.searchParams.get("X-Amz-Expires"), "604800");
});


test("temporary media cleanup targets only the current client namespace", () => {
  assert.equal(
    mediaStorage.temporaryMediaPrefix({ CLIENT_SLUG: "Neutro Sense TCM" }),
    "clients/neutro-sense-tcm/meta-outbound/"
  );
  assert.equal(
    mediaStorage.temporaryMediaPrefix({}),
    "meta-outbound/"
  );
});

test("temporary media cleanup only considers objects older than the safety window", () => {
  const now = new Date("2026-10-06T00:00:00.000Z").getTime();
  assert.equal(
    mediaStorage.isStaleTemporaryObject(
      { Key: "clients/acme/meta-outbound/1/old.jpg", LastModified: new Date("2026-10-04T23:59:59.000Z") },
      { now, olderThanMs: 24 * 60 * 60 * 1000 }
    ),
    true
  );
  assert.equal(
    mediaStorage.isStaleTemporaryObject(
      { Key: "clients/acme/meta-outbound/1/recent.jpg", LastModified: new Date("2026-10-05T12:00:00.000Z") },
      { now, olderThanMs: 24 * 60 * 60 * 1000 }
    ),
    false
  );
  assert.equal(
    mediaStorage.isStaleTemporaryObject(
      { Key: null, LastModified: new Date("2026-10-01T00:00:00.000Z") },
      { now, olderThanMs: 24 * 60 * 60 * 1000 }
    ),
    false
  );
});


test("durable temporary-media sweep fails closed without a client namespace", async () => {
  assert.equal(
    await mediaStorage.pruneStaleTemporaryMedia({ env: {} }),
    0
  );
});


test("customer purge prefixes stay inside the current client namespace", () => {
  const env = {
    CLIENT_SLUG: "Neutro Sense TCM",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "bucket",
  };
  assert.equal(mediaStorage.isStorageConfigured(env), true);
  assert.deepEqual(
    mediaStorage.customerMediaPrefixes(42, env),
    [
      "clients/neutro-sense-tcm/messages/42/",
      "clients/neutro-sense-tcm/meta-outbound/42/",
    ]
  );
  assert.equal(
    mediaStorage.isOwnedCustomerMediaPrefix(
      "clients/neutro-sense-tcm/messages/42/",
      { CLIENT_SLUG: "Neutro Sense TCM" }
    ),
    true
  );
  assert.equal(
    mediaStorage.isOwnedCustomerMediaPrefix(
      "clients/other-client/messages/42/",
      { CLIENT_SLUG: "Neutro Sense TCM" }
    ),
    false
  );
});

test("legacy media mode fails closed for customer prefix deletion", () => {
  assert.deepEqual(mediaStorage.customerMediaPrefixes(42, {}), []);
  assert.deepEqual(
    mediaStorage.customerMediaPrefixes(42, { CLIENT_SLUG: "client-without-r2" }),
    []
  );
  assert.equal(
    mediaStorage.isStorageConfigured({ CLIENT_SLUG: "client-without-r2" }),
    false
  );
  assert.equal(
    mediaStorage.isOwnedCustomerMediaPrefix("messages/42/", {}),
    false
  );
});


test("stored customer media keys reject another client's namespace", () => {
  const env = { CLIENT_SLUG: "neutro-sense-tcm" };
  assert.equal(
    mediaStorage.isOwnedStoredMediaKey(
      "clients/neutro-sense-tcm/messages/42/photo.jpg",
      env
    ),
    true
  );
  assert.equal(
    mediaStorage.isOwnedStoredMediaKey("messages/42/legacy.jpg", env),
    true
  );
  assert.equal(
    mediaStorage.isOwnedStoredMediaKey(
      "clients/other-client/messages/42/photo.jpg",
      env
    ),
    false
  );
  assert.equal(
    mediaStorage.isOwnedStoredMediaKey(
      "clients/neutro-sense-tcm/messages/42/photo.jpg",
      {}
    ),
    false
  );
});
