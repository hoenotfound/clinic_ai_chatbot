"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { Readable } = require("node:stream");
const express = require("express");
const access = require("../src/utils/accessControl");
const messagesRepo = require("../src/db/messagesRepo");
const storage = require("../src/services/mediaStorageService");

test("Inbox media HTTP route enforces staff access and ownership before signing, with authenticated proxy byte ranges", async (t) => {
  const old = {
    canAccessContact: access.canAccessContact,
    getMessageMediaReferenceForContact: messagesRepo.getMessageMediaReferenceForContact,
    isOwnedStoredMediaKey: storage.isOwnedStoredMediaKey,
    headMediaObject: storage.headMediaObject,
    createPresignedGetUrl: storage.createPresignedGetUrl,
    openMediaStream: storage.openMediaStream,
    flag: process.env.INBOX_DIRECT_R2_VIDEO_ENABLED,
  };
  let allowed = false;
  let lookups = 0;
  let headCalls = 0;
  let signCalls = 0;
  let streams = 0;
  const mediaRef = { media_key: "messages/101/historical.mp4", media_mime_type: "video/mp4" };

  access.canAccessContact = async (user, contactId) => allowed && user?.username === "staff" && contactId === 101;
  messagesRepo.getMessageMediaReferenceForContact = async (contactId, messageId) => {
    lookups++;
    return contactId === 101 && messageId === 81 ? mediaRef :
      contactId === 101 && messageId === 83
        ? { media_key: "messages/101/old-audio.mp3", media_mime_type: "audio/mpeg" }
        : null;
  };
  storage.isOwnedStoredMediaKey = () => true;
  storage.headMediaObject = async () => {
    headCalls++;
    return { mimeType: "video/mp4", bytes: 100 };
  };
  storage.createPresignedGetUrl = () => {
    signCalls++;
    return "https://fake.r2.cloudflarestorage.com/video?X-Amz-Signature=fixture";
  };
  storage.openMediaStream = async (_key, { range }) => {
    streams++;
    const partial = range === "bytes=0-2";
    return {
      body: Readable.from([Buffer.from(partial ? "abc" : "abcdefghij")]),
      contentLength: partial ? 3 : 10,
      contentRange: partial ? "bytes 0-2/10" : null,
      contentType: "video/mp4",
      acceptRanges: "bytes",
    };
  };
  process.env.INBOX_DIRECT_R2_VIDEO_ENABLED = "true";

  // Capture the authorization dependency before requiring the router, as its
  // module imports it by reference at initialization time.
  const routerPath = require.resolve("../src/routes/conversations");
  delete require.cache[routerPath];
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    delete require.cache[routerPath];
    access.canAccessContact = old.canAccessContact;
    messagesRepo.getMessageMediaReferenceForContact = old.getMessageMediaReferenceForContact;
    storage.isOwnedStoredMediaKey = old.isOwnedStoredMediaKey;
    storage.headMediaObject = old.headMediaObject;
    storage.createPresignedGetUrl = old.createPresignedGetUrl;
    storage.openMediaStream = old.openMediaStream;
    if (old.flag === undefined) delete process.env.INBOX_DIRECT_R2_VIDEO_ENABLED;
    else process.env.INBOX_DIRECT_R2_VIDEO_ENABLED = old.flag;
  });

  const router = require("../src/routes/conversations");
  const app = express();
  app.use((req, _res, next) => { req.user = { username: "staff" }; next(); });
  app.use("/api/conversations", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/conversations`;
  const get = (suffix, opts = {}) => fetch(`${base}${suffix}`, { redirect: "manual", ...opts });

  let r = await get("/101/messages/81/media");
  assert.equal(r.status, 403);
  assert.equal(lookups, 0, "Unauthorized staff must not look up media metadata.");
  assert.equal(signCalls, 0);

  r = await get("/101/messages/81/media?delivery=proxy");
  assert.equal(r.status, 403);
  assert.equal(streams, 0);

  // Audio is now protected by the same contact-level authorization, even
  // though it does not use the optional direct-R2 video path.
  r = await get("/101/messages/83/media");
  assert.equal(r.status,403);
  allowed = true;
  r = await get("/101/messages/83/media");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "abcdefghij");
  assert.equal(signCalls, 0);
  assert.equal(headCalls, 0);

  r = await get("/101/messages/82/media");
  assert.equal(r.status, 404);
  assert.equal(signCalls, 0);

  r = await get("/101/messages/81/media", { headers: { Range: "words=broken" } });
  assert.equal(r.status, 416);
  assert.equal(headCalls, 0);

  r = await get("/101/messages/81/media");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /X-Amz-Signature=fixture/);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(headCalls, 1);
  assert.equal(signCalls, 1);
  assert.equal(streams, 1); // The audio request was streamed unchanged.

  r = await get("/101/messages/81/media?delivery=proxy", { headers: { Range: "bytes=0-2" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 0-2/10");
  assert.equal(await r.text(), "abc");
  assert.equal(signCalls, 1);
  assert.equal(streams, 2);

  process.env.INBOX_DIRECT_R2_VIDEO_ENABLED = "false";
  allowed = false; // Staff access remains mandatory without direct video.
  r = await get("/101/messages/81/media");
  assert.equal(r.status, 403);
  assert.equal(signCalls, 1);
  assert.equal(streams, 2);
});
