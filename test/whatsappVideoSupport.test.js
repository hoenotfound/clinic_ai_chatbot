const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const serverSource = read("src/server.js");
const conversationStoreSource = read("src/utils/conversationStore.js");
const channelMessagingSource = read("src/services/channelMessagingService.js");
const conversationsRouteSource = read("src/routes/conversations.js");
const inboxSource = read("portal-frontend/src/pages/Inbox.jsx");

test("inbound WhatsApp videos are downloaded and stored for Inbox playback", () => {
  const videoStart = serverSource.indexOf('if (mediaType === "video")');
  const stickerStart = serverSource.indexOf('if (mediaType === "sticker")', videoStart);
  assert.ok(videoStart >= 0 && stickerStart > videoStart);

  const videoBlock = serverSource.slice(videoStart, stickerStart);
  assert.match(videoBlock, /downloadIncomingMedia\(incoming\)/);
  assert.match(videoBlock, /downloadedMime\.startsWith\("video\/"\)/);
  assert.match(videoBlock, /conversationStore\.updateInboundMessage/);
  assert.match(videoBlock, /video could not be stored/);
  assert.match(videoBlock, /video could not be downloaded/);
});

test("captionless videos never ask the AI to interpret media content and are surfaced to staff", () => {
  assert.match(
    serverSource,
    /incoming\?\.mediaType === "video"[\s\S]*return false;/
  );
  assert.match(
    serverSource,
    /mediaType === "video" && !String\(incoming\.text \|\| ""\)\.trim\(\)[\s\S]*sent a video without a caption[\s\S]*Stored WhatsApp video[\s\S]*without generating an AI reply/
  );
  assert.match(
    serverSource,
    /\(mediaType === "video" && !incoming\.text\)/
  );
  assert.match(
    conversationStoreSource,
    /AI cannot inspect the video's visual or audio content/
  );
  assert.match(
    conversationStoreSource,
    /Do not infer what it shows or sounds like/
  );
});

test("stored video forwarding preserves the original MIME type", () => {
  assert.match(
    conversationsRouteSource,
    /videoMimeType: mimeType/
  );
  assert.match(
    channelMessagingSource,
    /options\.videoMimeType \|\| "video\/mp4"/
  );
  assert.match(
    channelMessagingSource,
    /whatsapp\.uploadMedia\([\s\S]*videoMimeType,[\s\S]*videoFilename/
  );
});

test("Inbox uses authenticated stored-media streaming for received videos", () => {
  assert.match(inboxSource, /const isVideo = mediaMimeType\.startsWith\("video\/"\)/);
  assert.match(inboxSource, /api\.messageMediaUrl\(contactId, message\.id\)/);
  assert.match(inboxSource, /function OnDemandInboxVideo[\s\S]*<video[\s\S]*playsInline/);
  assert.match(inboxSource, /isVideo && videoSrc[\s\S]*<OnDemandInboxVideo/);
});

test("historical Inbox videos defer their media source until a deliberate play action", () => {
  assert.match(inboxSource, /function OnDemandInboxVideo\(/);
  assert.match(inboxSource, /src=\{uploading \? src : undefined\}/);
  assert.match(inboxSource, /activeSourceRef\.current !== playbackSrc \|\| player\.error/);
  assert.match(inboxSource, /player\.removeAttribute\("src"\)/);
  assert.match(inboxSource, /Retry video/);
  assert.match(inboxSource, /onError=\{\(\) =>/);
  assert.match(inboxSource, /preload=\{uploading \? "metadata" : "none"\}/);
  assert.match(inboxSource, /player\.src = playbackSrc;[\s\S]*?player\.play\(\)/);
  assert.match(inboxSource, /aria-label="Play video"/);
  assert.match(inboxSource, /uploading=\{Boolean\(message\._uploading\)\}/);
  // The existing authenticated media URL and outbound video sends are unchanged.
  assert.match(inboxSource, /api\.messageMediaUrl\(contactId, message\.id\)/);
  assert.match(conversationsRouteSource, /mediaStorage\.openMediaStream\([\s\S]*voicePlayback\?\.key \|\| mediaRef\.media_key/);
  assert.match(conversationsRouteSource, /voicePlayback\?\.mimeType \|\|[\s\S]*mediaRef\.media_mime_type/);
});
