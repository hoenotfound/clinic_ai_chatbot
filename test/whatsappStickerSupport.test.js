const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const whatsappSource = read("src/services/whatsappService.js");
const inboundClaimSource = read("src/services/inboundMessageClaimService.js");
const serverSource = read("src/server.js");
const conversationStoreSource = read("src/utils/conversationStore.js");
const inboxSource = read("portal-frontend/src/pages/Inbox.jsx");

test("customer stickers are supported WhatsApp media, not unsupported messages", () => {
  assert.match(whatsappSource, /message\.type === "sticker"/);
  assert.match(whatsappSource, /mediaId: message\.sticker\?\.id \|\| null/);
  assert.match(whatsappSource, /mediaType: "sticker"/);
  assert.match(whatsappSource, /unsupportedType: null/);
  assert.match(
    inboundClaimSource,
    /incoming\.mediaType === "sticker"[\s\S]*sent a sticker/
  );
});

test("sticker media is saved for Inbox display without AI interpretation", () => {
  assert.match(serverSource, /if \(mediaType === "sticker"\)/);
  assert.match(serverSource, /downloadIncomingMedia\(incoming\)/);
  assert.match(serverSource, /mimeType:[\s\S]*"image\/webp"/);
  assert.match(
    serverSource,
    /Stored WhatsApp sticker[\s\S]*without generating an AI reply/
  );
  assert.match(
    conversationStoreSource,
    /function isStickerRow\(row\)/
  );
  assert.match(
    conversationStoreSource,
    /!isStickerRow\(row\)/
  );
});

test("sticker attachment storage failures stay internal and do not enter the generic handoff path", () => {
  const stickerStart = serverSource.indexOf('if (mediaType === "sticker")');
  const stickerEnd = serverSource.indexOf(
    "// Photos/videos without captions and stickers",
    stickerStart
  );
  assert.ok(stickerStart >= 0 && stickerEnd > stickerStart);

  const stickerBlock = serverSource.slice(stickerStart, stickerEnd);
  assert.match(stickerBlock, /try \{/);
  assert.match(stickerBlock, /conversationStore\.updateInboundMessage/);
  assert.match(stickerBlock, /catch \(stickerStorageErr\)/);
  assert.match(stickerBlock, /keeping the durable placeholder without changing ownership/);
  assert.doesNotMatch(stickerBlock, /sendTrackedText\(/);
  assert.doesNotMatch(stickerBlock, /pauseAiForHumanHandoff\(/);
});

test("a trailing sticker does not suppress a useful reply to an earlier burst message", () => {
  assert.match(
    serverSource,
    /function canGenerateAutomatedReplyForIncoming\(item\)/
  );
  assert.match(
    serverSource,
    /if \(incoming\?\.mediaType === "sticker"\) return false;/
  );
  assert.match(
    serverSource,
    /replyTargetIndex = index/
  );
});

test("Inbox renders stored stickers as compact contain-fit artwork", () => {
  assert.match(inboxSource, /const isSticker =/);
  assert.match(inboxSource, /Customer sticker/);
  assert.match(inboxSource, /max-h-36 max-w-\[9rem\] object-contain/);
  assert.match(inboxSource, /\(!isSticker \|\| !hasImage\)/);
});
