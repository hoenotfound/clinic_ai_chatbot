"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, Pool } = require("pg");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRepository } = require("../src/db/whatsappVideoMediaCacheRepo");

const connectionString = process.env.TEST_DATABASE_URL;

// Exercises the actual PostgreSQL ON CONFLICT lease and compare-and-swap SQL
// using two independent pooled transactions; no production Neon writes.
test("PostgreSQL reusable WhatsApp video cache: leases, stale writers, invalidations and stats",
  { skip: !connectionString }, async () => {
  const admin = new Client({ connectionString });
  const schema = "wa_video_cache_" + process.pid + "_" + Date.now();
  let database;
  await admin.connect();
  try {
    await admin.query("CREATE SCHEMA " + schema);
    database = new Pool({
      connectionString, options: "-c search_path=" + schema, max: 6,
    });
    await database.query(fs.readFileSync(path.join(
      __dirname, "../src/db/migrations/071_whatsapp_shared_video_media_cache.sql"
    ), "utf8"));
    const repo = createRepository(database);
    const phone = "112233445566";
    const hash = "a".repeat(64);
    const mimeType = "video/mp4";
    const ids = [randomUUID(),randomUUID(),randomUUID()];
    const claims = await Promise.all([
      repo.claim(phone,hash,mimeType,ids[0]),
      repo.claim(phone,hash,mimeType,ids[1]),
    ]);
    assert.equal(claims.filter(Boolean).length,1,
      "Concurrent Render workers must acquire exactly one upload lease");
    const winner = ids[claims[0] ? 0 : 1];
    const loser = ids[claims[0] ? 1 : 0];
    assert.equal(await repo.save(phone,hash,loser,"999999"),false,
      "Losing worker cannot overwrite the winning upload");
    assert.equal(await repo.get(phone,hash),null);
    assert.equal(await repo.save(phone,hash,winner,"100001"),true);
    assert.equal(await repo.get(phone,hash),"100001");
    assert.equal(await repo.claim(phone,hash,mimeType,randomUUID()),false,
      "Valid Meta media IDs are not reuploaded");

    // A rejected ID must only invalidate its own exact version.
    assert.equal(await repo.invalidate(phone,hash,"100002"),false);
    assert.equal(await repo.get(phone,hash),"100001");
    assert.equal(await repo.invalidate(phone,hash,"100001"),true);
    assert.equal(await repo.get(phone,hash),null);

    // Crash recovery: expire the first upload claim and steal it atomically.
    const stale = randomUUID();
    const successor = randomUUID();
    assert.equal(await repo.claim(phone,hash,mimeType,stale),true);
    await database.query(
      "UPDATE whatsapp_video_media_cache SET upload_claim_expires_at=" +
      "NOW()-INTERVAL '1 second' WHERE phone_number_id=$1 AND content_fingerprint=$2",
      [phone,hash]
    );
    assert.equal(await repo.claim(phone,hash,mimeType,successor),true);
    assert.equal(await repo.save(phone,hash,stale,"BAD_STALE"),false);
    assert.equal(await repo.save(phone,hash,successor,"100003"),true);
    assert.equal(await repo.get(phone,hash),"100003");
    assert.equal(await repo.invalidate(phone,hash,"100001"),false,
      "Late provider rejection cannot invalidate the replacement");
    assert.equal(await repo.get(phone,hash),"100003");

    // Leased upload that exceeds its deadline cannot publish a stale ID.
    const extraHash = "b".repeat(64);
    const late = randomUUID();
    assert.equal(await repo.claim(phone,extraHash,mimeType,late),true);
    await database.query(
      "UPDATE whatsapp_video_media_cache SET upload_claim_expires_at=" +
      "NOW()-INTERVAL '1 second' WHERE phone_number_id=$1 AND content_fingerprint=$2",
      [phone,extraHash]
    );
    assert.equal(await repo.save(phone,extraHash,late,"EXPIRED"),false);

    // Invalidation races and telemetry aggregation remain scoped by phone.
    await Promise.all([
      repo.recordEvent(phone,"hit",15000000),
      repo.recordEvent(phone,"hit",9000000),
      repo.recordEvent(phone,"miss"),
      repo.recordEvent(phone,"upload"),
      repo.recordEvent(phone,"invalid"),
      repo.recordEvent(phone,"recovered"),
      repo.recordEvent(phone,"fallback"),
    ]);
    assert.equal(await repo.recordEvent(phone,"nonsense"),false);
    const stats = (await database.query(
      "SELECT cache_hits,cache_misses,uploads,fallbacks,invalid_ids," +
      "recovered_sends,upload_bytes_avoided FROM whatsapp_video_media_cache_daily_stats " +
      "WHERE phone_number_id=$1", [phone]
    )).rows[0];
    assert.equal(Number(stats.cache_hits),2);
    assert.equal(Number(stats.cache_misses),1);
    assert.equal(Number(stats.uploads),1);
    assert.equal(Number(stats.fallbacks),1);
    assert.equal(Number(stats.invalid_ids),1);
    assert.equal(Number(stats.recovered_sends),1);
    assert.equal(Number(stats.upload_bytes_avoided),24000000);
  } finally {
    if (database) await database.end();
    try { await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); }
    finally { await admin.end(); }
  }
});
