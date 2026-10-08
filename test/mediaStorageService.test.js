const test = require("node:test");
const assert = require("node:assert/strict");

const { S3Client, CopyObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
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

test("R2 operations abort instead of hanging indefinitely", async (t) => {
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

  process.env.R2_ACCOUNT_ID = "timeout-test";
  process.env.R2_ACCESS_KEY_ID = "AKIDTIMEOUT";
  process.env.R2_SECRET_ACCESS_KEY = "SECRETTIMEOUT";
  process.env.R2_BUCKET_NAME = "private-media";

  S3Client.prototype.send = async function send(_command, options = {}) {
    return await new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true }
      );
    });
  };

  await assert.rejects(
    mediaStorage.sendR2(new CopyObjectCommand({
      Bucket: "private-media",
      Key: "target.jpg",
      CopySource: "private-media/source.jpg",
    }), { timeoutMs: 5 }),
    (err) =>
      err?.code === "R2_REQUEST_TIMEOUT" &&
      mediaStorage.isR2RequestTimeoutError(err)
  );
});

test("forwarded media is copied server-side into a new permanent message object", async (t) => {
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
  const resultKey = await mediaStorage.copyStoredMediaToMessage(
    sourceKey,
    "image/jpeg",
    {
      contactId: 99,
      env: { CLIENT_SLUG: "acme" },
    }
  );

  assert.equal(copyInput.Bucket, "private-media");
  assert.equal(copyInput.CopySource, `private-media/${sourceKey}`);
  assert.equal(copyInput.MetadataDirective, "REPLACE");
  assert.equal(copyInput.ContentType, "image/jpeg");
  assert.match(resultKey, /^clients\/acme\/messages\/99\//);
  assert.notEqual(resultKey, sourceKey);
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


test("durable temporary-media sweep batches stale R2 deletes", async (t) => {
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

  process.env.R2_ACCOUNT_ID = "cleanup-test";
  process.env.R2_ACCESS_KEY_ID = "AKIDCLEAN";
  process.env.R2_SECRET_ACCESS_KEY = "SECRETCLEAN";
  process.env.R2_BUCKET_NAME = "private-media";

  const oldDate = new Date("2026-10-01T00:00:00.000Z");
  const recentDate = new Date("2026-10-07T06:00:00.000Z");
  const calls = [];
  S3Client.prototype.send = async function send(command) {
    calls.push(command);
    if (command instanceof ListObjectsV2Command) {
      return {
        Contents: [
          { Key: "clients/acme/meta-outbound/1/a.jpg", LastModified: oldDate },
          { Key: "clients/acme/meta-outbound/1/b.jpg", LastModified: oldDate },
          { Key: "clients/acme/meta-outbound/1/recent.jpg", LastModified: recentDate },
        ],
        IsTruncated: false,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      return { Errors: [] };
    }
    throw new Error(`Unexpected R2 command: ${command.constructor.name}`);
  };

  const deleted = await mediaStorage.pruneStaleTemporaryMedia({
    now: new Date("2026-10-07T12:00:00.000Z").getTime(),
    olderThanMs: 24 * 60 * 60 * 1000,
    env: { CLIENT_SLUG: "acme" },
  });

  assert.equal(deleted, 2);
  const deleteCalls = calls.filter((command) => command instanceof DeleteObjectsCommand);
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(
    deleteCalls[0].input.Delete.Objects.map((item) => item.Key),
    [
      "clients/acme/meta-outbound/1/a.jpg",
      "clients/acme/meta-outbound/1/b.jpg",
    ]
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

test("R2 download deadline destroys a body stalled after headers", async (t) => {
  const { PassThrough } = require("node:stream");
  const originalSend = S3Client.prototype.send;
  const before = { ...process.env };
  t.after(() => { S3Client.prototype.send = originalSend;
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
      if (before[name] == null) delete process.env[name]; else process.env[name] = before[name];
    }
  });
  Object.assign(process.env, { R2_ACCOUNT_ID: "body-test", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "test" });
  const body = new PassThrough();
  S3Client.prototype.send = async () => ({ Body: body });
  await assert.rejects(mediaStorage.downloadMedia("test.jpg", { timeoutMs: 15 }), { code: "R2_REQUEST_TIMEOUT" });
  assert.equal(body.destroyed, true);
});

test("customer deletion preserves configured follow-up videos shared by other chats", async (t) => {
  const originalSend = S3Client.prototype.send;
  const originalEnv = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  };
  t.after(() => {
    S3Client.prototype.send = originalSend;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, {
    R2_ACCOUNT_ID: "purge-test",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "private-media",
  });

  const env = { CLIENT_SLUG: "neutro" };
  assert.equal(
    mediaStorage.isSharedFollowUpConfigKey("clients/neutro/messages/follow-up-config/video.mp4", env),
    true
  );
  assert.equal(
    mediaStorage.isSharedFollowUpConfigKey("clients/other/messages/follow-up-config/video.mp4", env),
    false
  );
  assert.equal(
    mediaStorage.isSharedFollowUpConfigKey("clients/neutro/messages/99/private.mp4", env),
    false
  );
  const deletes = [];
  S3Client.prototype.send = async (command) => {
    assert.ok(command instanceof DeleteObjectCommand);
    deletes.push(command.input.Key);
    return {};
  };

  const deleted = await mediaStorage.deleteCustomerMediaObjects({
    mediaKeys: [
      "clients/neutro/messages/follow-up-config/video.mp4",
      "clients/neutro/messages/99/private.mp4",
    ],
    env,
  });
  assert.equal(deleted, 1);
  assert.deepEqual(deletes, ["clients/neutro/messages/99/private.mp4"]);
});

test("stale settings video cleanup retains persisted Inbox references", async (t) => {
  const originalSend = S3Client.prototype.send;
  const env = {
    CLIENT_SLUG: "neutro",
    R2_ACCOUNT_ID: "cleanup-references",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "private-media",
  };
  const originalEnv = Object.fromEntries(
    ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]
      .map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, env);
  t.after(() => {
    S3Client.prototype.send = originalSend;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const root = "clients/neutro/messages/follow-up-config/";
  const deletedKeys = [];
  S3Client.prototype.send = async (command) => {
    if (command instanceof ListObjectsV2Command) {
      assert.equal(command.input.Prefix, root);
      return {
        Contents: ["old-still-referenced.mp4", "old-orphan.mp4"].map((key) => ({
          Key: root + key,
          LastModified: new Date("2026-09-01T00:00:00Z"),
        })),
        IsTruncated: false,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      deletedKeys.push(...command.input.Delete.Objects.map((entry) => entry.Key));
      return { Errors: [] };
    }
    throw new Error("Unexpected storage command");
  };
  const count = await mediaStorage.pruneStaleFollowUpConfigVideos({
    env,
    now: new Date("2026-10-08T00:00:00Z").getTime(),
    referencedKeys: [root + "old-still-referenced.mp4"],
  });
  assert.equal(count, 1);
  assert.deepEqual(deletedKeys, [root + "old-orphan.mp4"]);
});

test("failed temporary upload schedules removal of its abandoned object", async (t) => {
  const originalSend = S3Client.prototype.send;
  const originalEnv = Object.fromEntries(
    ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]
      .map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, {
    R2_ACCOUNT_ID: "temp-write-test",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "private-media",
  });
  t.after(() => {
    S3Client.prototype.send = originalSend;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const cleaned = [];
  S3Client.prototype.send = async (command) => {
    if (command instanceof PutObjectCommand) throw new Error("uncertain upload");
    if (command instanceof DeleteObjectCommand) {
      cleaned.push(command.input.Key);
      return {};
    }
    throw new Error("Unexpected storage command");
  };
  await assert.rejects(
    mediaStorage.uploadTemporaryMedia(Buffer.from("video"), "video/mp4", {
      contactId: 77, env: { CLIENT_SLUG: "neutro" },
    }),
    /uncertain upload/
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned.length, 1);
  assert.match(cleaned[0], /^clients\/neutro\/meta-outbound\/77\//);
});
